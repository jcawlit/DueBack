/**
 * Checking an Audiobookshelf book out: the whole operation, in one place.
 *
 * Fetch the item fresh, download every audio file, write the parts, hand
 * back what the store needs to record a checkout. Everything that is the
 * same as a USB checkout is done by the same code — `downloadBookToDevice`
 * writes into the layout `copy.ts` defines, and the caller runs the same
 * `recordCheckoutComplete` afterwards.
 */

import { AbsError, StaleInoError, type AbsClient } from './client';
import { audioFilesOf, detailFrom } from './map';
import { downloadBookToDevice, type DownloadControls } from './download';
import { saveRemoteDetail } from '@/db/remoteBooks';
import type { CopyOutcome } from '@/lib/files/copy';

type Json = Record<string, unknown>;

export type CheckoutResult = {
  outcome: CopyOutcome;
  /** Written only when the download succeeded. */
  parts: {
    name: string;
    sizeBytes: number;
    durationSec: number;
    startSec: number;
    trackNumber?: number;
    localRelPath: string;
  }[];
  /** Total size as the server reported it just now, for the budget. */
  sizeBytes: number;
};

export type CheckoutOptions = {
  onProgress?: (fraction: number) => void;
  onControls?: (controls: DownloadControls) => void;
};

/**
 * Downloads a book, re-reading the item first.
 *
 * The re-read is not caution, it is correctness: an ino is the server's
 * inode number and changes whenever a file is rewritten or the library is
 * rescanned, so a stored one is worthless. If a file 404s anyway — the
 * library was rescanned between the fetch and the download — the item is
 * read once more and the download retried, and a second failure is
 * reported plainly rather than retried for ever.
 */
export async function checkoutRemoteBook(
  client: AbsClient,
  serverUrl: string,
  bookId: string,
  remoteId: string,
  token: string,
  options: CheckoutOptions = {},
): Promise<CheckoutResult> {
  const attempt = async (expanded: Json): Promise<CopyOutcome> => {
    const files = audioFilesOf(expanded);
    if (files.length === 0) {
      return {
        ok: false,
        reason: 'source-missing',
        message: 'The server lists no audio files for this book.',
      };
    }
    return downloadBookToDevice(bookId, serverUrl, remoteId, files, token, {
      onProgress: ({ bytesWritten, totalBytes }) =>
        options.onProgress?.(totalBytes > 0 ? bytesWritten / totalBytes : 0),
      onControls: options.onControls,
    });
  };

  let expanded = (await client.item(remoteId)) as Json;
  let detail = detailFrom(expanded);
  let outcome: CopyOutcome;

  try {
    outcome = await attempt(expanded);
  } catch (error) {
    if (!(error instanceof StaleInoError)) throw error;
    // Read the item again and try once. The inos moved under us, which a
    // rescan on the server does routinely.
    console.warn('[abs] a file ino went stale mid-checkout; re-reading the item');
    expanded = (await client.item(remoteId)) as Json;
    detail = detailFrom(expanded);
    try {
      outcome = await attempt(expanded);
    } catch (second) {
      if (!(second instanceof StaleInoError)) throw second;
      outcome = {
        ok: false,
        reason: 'source-missing',
        message: 'The files moved on the server while they were being fetched. Try again.',
      };
    }
  }

  // Keep what the fresh read told us, whether or not the audio landed: the
  // chapter list and the sizes are the most current we have either way.
  await saveRemoteDetail(bookId, detail, expanded).catch(() => {});

  const files = audioFilesOf(expanded);
  const parts = outcome.ok
    ? files.map((file, i) => ({
        name: file.name,
        sizeBytes: file.sizeBytes,
        // Offsets come from the track list, which is the only place that has
        // them; a file with no matching track starts where the last one ended.
        durationSec: detail.tracks[i]?.durationSec ?? 0,
        startSec: detail.tracks[i]?.startSec ?? 0,
        trackNumber: i + 1,
        localRelPath: outcome.localRelPaths[i],
      }))
    : [];

  return { outcome, parts, sizeBytes: files.reduce((n, f) => n + f.sizeBytes, 0) };
}

/** Whether the signed-in account may download at all. */
export async function canDownload(client: AbsClient): Promise<boolean> {
  try {
    const session = await client.authorize();
    // Absent means the server did not say, and refusing on silence would
    // disable checkout against a version that simply reports less.
    return session.user.canDownload !== false;
  } catch (error) {
    if (error instanceof AbsError && error.kind === 'forbidden') return false;
    throw error;
  }
}
