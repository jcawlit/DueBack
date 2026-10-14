/**
 * Keeping a book's identity across a change of address.
 *
 * A scan knows where it found things. This module is what turns that into
 * "the same book as before" — the index a scan looks books up in, the books
 * that did not turn up this time, and the one careful operation that moves a
 * newly found book's audio onto the identity of a book that has gone.
 */

import type { BookShape } from '@/lib/library/identity';
import { adoptLibraryId, ensureDeviceId, ensureLibraryId, getDb } from './schema';
import { withLockRetry } from './books';

// Re-exported so the rest of the app can ask one module about identity, even
// though these three are only settings and live where settings live.
export { adoptLibraryId, ensureDeviceId, ensureLibraryId };

/**
 * Where each known book was last found, to its uuid.
 *
 * Scoped to one library, because a path key is only a path: two libraries can
 * each hold `A Book/01.mp3`, and matching across them would hand one library's
 * place and notes to the other's book. Books with no library recorded are
 * included — that is every book indexed before identity existed, and refusing
 * them would make a stranger of each one on the first scan after an upgrade.
 */
export async function loadPathKeyIndex(libraryId: string | null): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; path_key: string | null }>(
    `SELECT id, path_key FROM books
      WHERE path_key IS NOT NULL AND (library_id IS NULL OR library_id = ?)`,
    libraryId,
  );
  const index = new Map<string, string>();
  for (const row of rows) {
    if (row.path_key) index.set(row.path_key, row.id);
  }
  return index;
}

export type VanishedBook = {
  id: string;
  title: string;
  folderRelPath: string;
  shape: BookShape;
  sampleHash: string | null;
  /** Whether anything would be lost by leaving it missing. */
  hasProgress: boolean;
};

type ShapeRow = {
  id: string;
  title: string;
  folder_rel_path: string;
  size_bytes: number;
  duration_sec: number;
  part_sizes: string | null;
  sample_hash: string | null;
  progress_sec: number;
};

function shapeFromRow(row: ShapeRow): BookShape {
  let partSizes: number[] = [];
  try {
    const parsed = row.part_sizes ? JSON.parse(row.part_sizes) : [];
    if (Array.isArray(parsed)) partSizes = parsed.filter((n) => typeof n === 'number');
  } catch {
    partSizes = [];
  }
  return {
    sizeBytes: row.size_bytes,
    durationSec: row.duration_sec,
    partCount: partSizes.length,
    partSizes,
  };
}

/**
 * Books this scan did not find, which may simply have moved.
 *
 * Only books with a recorded shape are worth offering: one indexed before
 * identity existed has no part sizes, so there is nothing to match it on and
 * pretending otherwise would mean guessing.
 */
export async function loadVanishedBooks(seenIds: string[]): Promise<VanishedBook[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ShapeRow>(
    `SELECT id, title, folder_rel_path, size_bytes, duration_sec, part_sizes,
            sample_hash, progress_sec
       FROM books
      WHERE source_kind = 'library' AND part_sizes IS NOT NULL`,
  );
  const seen = new Set(seenIds);
  return rows
    .filter((row) => !seen.has(row.id))
    .map((row) => ({
      id: row.id,
      title: row.title,
      folderRelPath: row.folder_rel_path,
      shape: shapeFromRow(row),
      sampleHash: row.sample_hash,
      hasProgress: row.progress_sec > 0,
    }));
}

/**
 * Moves a newly found book onto the identity of one that had gone.
 *
 * The old row keeps everything a scan cannot rebuild — progress, whether it
 * was finished, where its local copy is, its checkout history, and the notes
 * and characters hanging off its id — and takes on everything the scan just
 * learned about where the audio now lives.
 *
 * Local part paths are carried across **by index**, not by path. The whole
 * reason this is happening is that the paths changed; the audio did not, and
 * its order did not, which is what the content sample proved.
 */
export async function reconnectBook(foundId: string, keepId: string): Promise<void> {
  if (foundId === keepId) return;
  const db = await getDb();
  await withLockRetry(() =>
    db.withTransactionAsync(async () => {
      const locals = await db.getAllAsync<{ idx: number; local_rel_path: string | null }>(
        'SELECT idx, local_rel_path FROM parts WHERE book_id = ? ORDER BY idx',
        keepId,
      );

      await db.runAsync(
        `UPDATE books SET
           folder_rel_path = (SELECT folder_rel_path FROM books WHERE id = ?1),
           raw_folder_name = (SELECT raw_folder_name FROM books WHERE id = ?1),
           title           = (SELECT title           FROM books WHERE id = ?1),
           author          = (SELECT author          FROM books WHERE id = ?1),
           narrator        = (SELECT narrator        FROM books WHERE id = ?1),
           duration_sec    = (SELECT duration_sec    FROM books WHERE id = ?1),
           size_bytes      = (SELECT size_bytes      FROM books WHERE id = ?1),
           cover_file      = COALESCE((SELECT cover_file   FROM books WHERE id = ?1), cover_file),
           cover_source    = COALESCE((SELECT cover_source FROM books WHERE id = ?1), cover_source),
           path_key        = (SELECT path_key        FROM books WHERE id = ?1),
           library_id      = (SELECT library_id      FROM books WHERE id = ?1),
           part_sizes      = (SELECT part_sizes      FROM books WHERE id = ?1),
           sample_hash     = (SELECT sample_hash     FROM books WHERE id = ?1),
           sample_version  = (SELECT sample_version  FROM books WHERE id = ?1),
           chapters_from_parts = (SELECT chapters_from_parts FROM books WHERE id = ?1),
           drm             = (SELECT drm             FROM books WHERE id = ?1),
           warnings        = (SELECT warnings        FROM books WHERE id = ?1),
           last_scanned_at = (SELECT last_scanned_at FROM books WHERE id = ?1),
           missing         = 0
         WHERE id = ?2`,
        foundId, keepId,
      );

      await db.runAsync('DELETE FROM parts WHERE book_id = ?', keepId);
      await db.runAsync('DELETE FROM chapters WHERE book_id = ?', keepId);
      await db.runAsync('UPDATE parts SET book_id = ? WHERE book_id = ?', keepId, foundId);
      await db.runAsync('UPDATE chapters SET book_id = ? WHERE book_id = ?', keepId, foundId);

      for (const local of locals) {
        if (!local.local_rel_path) continue;
        await db.runAsync(
          'UPDATE parts SET local_rel_path = ? WHERE book_id = ? AND idx = ?',
          local.local_rel_path, keepId, local.idx,
        );
      }

      await db.runAsync('DELETE FROM books WHERE id = ?', foundId);
    }),
  );
}

/** A book that has gone, and what the scan thinks it might have become. */
export type ReconnectQuestion = {
  missingId: string;
  missingTitle: string;
  missingFolder: string;
  candidates: { id: string; title: string; folderRelPath: string }[];
  reason: 'unverified' | 'ambiguous';
};
