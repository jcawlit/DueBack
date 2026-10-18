/**
 * Bringing a server's library into the local database.
 *
 * Two passes, on purpose. The catalogue lands first and whole, so the
 * shelves fill in one write; covers follow one at a time afterwards, because
 * a few hundred images is a few hundred round trips and nobody should look
 * at an empty library while they happen.
 */

import type { AbsClient } from './client';
import { catalogueEntries, detailFrom, type AbsDetail } from './map';
import { storeCover } from '@/lib/files/covers';
import {
  loadRemoteDetail,
  remoteBooksNeedingCovers,
  saveRemoteDetail,
  setRemoteCover,
  upsertCatalogue,
  type CatalogueChange,
} from '@/db/remoteBooks';

/**
 * Reads every page, then writes once.
 *
 * `upsertCatalogue` treats anything absent from the list as gone from the
 * server, so a half-read catalogue would mark the rest of the library
 * missing. Letting the fetch throw before any write is what makes a dropped
 * connection a no-op instead of a disaster.
 */
export async function pullCatalogue(
  client: AbsClient,
  sourceId: string,
  libraryId: string,
): Promise<CatalogueChange> {
  const raw = await client.libraryItems(libraryId);
  return upsertCatalogue(sourceId, catalogueEntries(raw));
}

/**
 * Fetches the covers that are missing, one at a time.
 *
 * Serial rather than parallel: this is a home server on a phone's wifi, and
 * two hundred simultaneous image requests is a denial of service against the
 * thing you are trying to read. One failure is skipped, not fatal — a book
 * with no picture is a book, and the next refresh tries again.
 *
 * Every cover goes through the Authorization header and into the local cache.
 * Nothing ever points an <Image> at the server.
 */
export async function pullCovers(
  client: AbsClient,
  sourceId: string,
  options: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ fetched: number; failed: number }> {
  const wanted = await remoteBooksNeedingCovers(sourceId);
  const todo = options.limit ? wanted.slice(0, options.limit) : wanted;
  let fetched = 0;
  let failed = 0;

  for (const [i, book] of todo.entries()) {
    try {
      /*
       * A book the server has no artwork for answers 404, which arrives
       * here as a throw and is counted as a miss — so there is no need to
       * second-guess the bytes by size. An earlier version refused anything
       * under 512 bytes as "too small to be real" and threw away a
       * perfectly good cover: the server re-encodes to WebP, and a plain
       * one compresses to a few hundred bytes.
       */
      const bytes = await client.cover(book.remote_id);
      if (bytes.length === 0) {
        failed += 1;
        continue;
      }
      const stored = await storeCover(book.id, bytes, 'remote');
      if (stored) {
        await setRemoteCover(book.id, stored.fileName);
        fetched += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn(`[abs] cover for ${book.remote_id} failed`, error);
    }
    options.onProgress?.(i + 1, todo.length);
  }

  return { fetched, failed };
}

export type DetailResult = {
  detail: AbsDetail;
  /** True when this came from the cache because the server was unreachable. */
  cached: boolean;
  /** When the cache was written, for the "last seen" line. */
  cachedAt?: string;
};

/**
 * The expanded record for one book, from the server or from the last time.
 *
 * Never throws for a book that has been opened before: a server that cannot
 * be reached falls back to what it said last, which is the difference
 * between a stale chapter list and a blank screen.
 */
export async function fetchDetail(
  client: AbsClient | null,
  bookId: string,
  remoteId: string,
): Promise<DetailResult | null> {
  if (client) {
    try {
      const raw = await client.item(remoteId);
      const detail = detailFrom(raw);
      await saveRemoteDetail(bookId, detail, raw);
      return { detail, cached: false };
    } catch (error) {
      console.warn(`[abs] could not read ${remoteId}, falling back to the cache`, error);
    }
  }

  const cached = await loadRemoteDetail(bookId);
  if (!cached) return null;
  try {
    return { detail: detailFrom(JSON.parse(cached.json)), cached: true, cachedAt: cached.at };
  } catch {
    console.warn(`[abs] the cached record for ${bookId} was unreadable`);
    return null;
  }
}
