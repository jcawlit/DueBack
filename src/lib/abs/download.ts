/**
 * Checking a book out of a server: the audio, onto the phone.
 *
 * The same shape as `copyBookToDevice`, and deliberately the same outcome
 * type, because what happens afterwards must not care which library a book
 * came from. Files land in exactly the places a USB checkout puts them —
 * `bookLayout` in `copy.ts` is the one definition of where — so the player,
 * `deleteLocalCopy` and startup reconciliation all work unchanged.
 *
 * Three rules this file exists to keep:
 *
 * **Never `GET /api/items/:id/download`.** That endpoint returns a ZIP of
 * the whole item. It cannot be resumed, cannot be played until it is
 * complete, and would have to be unpacked. Checkout is per-file, always.
 *
 * **Never reuse a stored ino.** A file's ino is the server's inode number
 * and changes when the file is rewritten or the library is rescanned. The
 * caller re-fetches the expanded item immediately before calling this, and
 * a 404 mid-download means the ino went stale under us.
 *
 * **Never a token in a URL.** Authorization is a header, here as everywhere.
 */

import { Directory, DownloadTask, File } from 'expo-file-system';
import { bookLayout, checkFreeSpace, swapIntoPlace, type CopyOutcome } from '@/lib/files/copy';
import { fileDownloadUrl, StaleInoError } from './client';
import type { AbsAudioFile } from './map';

export { fileDownloadUrl, StaleInoError };

/** One audio file on the server, as the expanded item described it just now. */
export type RemotePart = AbsAudioFile;

export type DownloadProgressReport = {
  bytesWritten: number;
  totalBytes: number;
  partIndex: number;
  partCount: number;
};

export type DownloadControls = {
  /** Suspends the transfer; resume data is kept by the task. */
  pause: () => void;
  /** Picks the transfer up from where it stopped. */
  resume: () => void;
  /** Abandons it. The staging folder goes with it. */
  cancel: () => void;
  paused: () => boolean;
};

export type DownloadOptions = {
  onProgress?: (progress: DownloadProgressReport) => void;
  /** Handed the controls as soon as there is something to control. */
  onControls?: (controls: DownloadControls) => void;
};

/** A sentence a person can read, from whatever the transfer threw. */
function plainFailure(detail: string): string {
  if (detail) console.warn('[abs] download failed:', detail);
  if (/ENOSPC|No space left/i.test(detail)) {
    return 'The phone ran out of room partway through. Nothing was saved.';
  }
  if (/Network request failed|ETIMEDOUT|ECONNRESET|Unable to resolve host|timed out/i.test(detail)) {
    return 'The connection dropped partway through. Nothing was saved.';
  }
  return 'The download stopped unexpectedly. Nothing was saved.';
}

/**
 * Downloads every file of a book and moves the set into place.
 *
 * All-or-nothing, like the copy it mirrors: a half-downloaded book is never
 * visible as a book. Unlike the copy, a single file can be paused and picked
 * up again without losing what has already arrived — the transfer is HTTP and
 * the task holds the resume data, which is the whole reason this uses
 * `DownloadTask` rather than a plain fetch to a file.
 */
export async function downloadBookToDevice(
  bookId: string,
  serverUrl: string,
  itemId: string,
  parts: RemotePart[],
  token: string,
  options: DownloadOptions = {},
): Promise<CopyOutcome> {
  const totalBytes = parts.reduce((n, p) => n + p.sizeBytes, 0);

  const space = checkFreeSpace(totalBytes);
  if (!space.ok) {
    return {
      ok: false,
      reason: 'no-space',
      message: `Not enough room on the phone — ${Math.ceil(space.shortBy / 1024 / 1024)} MB short.`,
    };
  }

  bookLayout.ensureStagingRoot();
  const staging = bookLayout.staging(bookId);
  /*
   * Started clean every time, unlike the USB path.
   *
   * That one re-uses staged parts left by a kill, proved by a manifest of
   * names and sizes. Here the equivalent proof would be an ino, and an ino
   * is exactly the thing that is not stable between runs — so a part left
   * over from a previous attempt cannot be shown to be a part of this book.
   * Within one run, pause and resume keep their bytes; across a kill, the
   * download starts again.
   */
  bookLayout.removeQuietly(staging);
  bookLayout.ensure(staging);

  let cancelled = false;
  let paused = false;
  let current: DownloadTask | null = null;
  let bytesDone = 0;

  const controls: DownloadControls = {
    pause: () => {
      paused = true;
      current?.pause();
    },
    resume: () => {
      paused = false;
    },
    cancel: () => {
      cancelled = true;
      paused = false;
      current?.cancel();
    },
    paused: () => paused,
  };
  options.onControls?.(controls);

  const abandon = (reason: 'cancelled' | 'failed' | 'no-space', message: string): CopyOutcome => {
    bookLayout.removeQuietly(staging);
    return { ok: false, reason, message };
  };

  try {
    for (let i = 0; i < parts.length; i += 1) {
      if (cancelled) return abandon('cancelled', 'Download stopped. Nothing was saved.');

      const part = parts[i];
      const target = new File(staging, bookLayout.partFileName(i, part.name));
      const base = bytesDone;

      const task = new DownloadTask(fileDownloadUrl(serverUrl, itemId, part.ino), target, {
        headers: { Authorization: `Bearer ${token}` },
        onProgress: ({ bytesWritten }) => {
          options.onProgress?.({
            bytesWritten: Math.min(totalBytes, base + bytesWritten),
            totalBytes,
            partIndex: i,
            partCount: parts.length,
          });
        },
      });
      current = task;

      /*
       * `downloadAsync` resolves with null when the task was paused rather
       * than finished, so a pause is a loop here and not an error. Resuming
       * is the caller's business: until `resume()` is called the task simply
       * stays paused, and the await below waits on it.
       */
      let landed: File | null = null;
      landed = await task.downloadAsync();
      while (landed === null && !cancelled) {
        await waitUntilResumed(() => paused, () => cancelled);
        if (cancelled) break;
        landed = await task.resumeAsync();
      }
      current = null;

      if (cancelled) return abandon('cancelled', 'Download stopped. Nothing was saved.');

      /*
       * A 404 here is the stale-ino case: the server still has the book, but
       * not under the inode we were handed. Distinguished from a real failure
       * so the caller can re-fetch the item once and try again.
       */
      if (!landed || !target.exists) {
        throw new StaleInoError(i, part.name);
      }

      /*
       * Size verification, and the one place a stale ino is actually
       * caught.
       *
       * A stale ino answers 404 — proved against 2.37.1 — and it is not
       * certain that `DownloadTask` rejects on a non-2xx rather than
       * writing the error body to the file and calling it a completed
       * transfer. Either way the file is the wrong size, so a mismatch is
       * treated as "the server did not give us this file" and sent back to
       * the caller to re-read the item and try once more. A genuinely
       * truncated transfer takes the same path and fails plainly on the
       * second attempt, which is the right outcome for both.
       */
      const written = target.size ?? 0;
      if (part.sizeBytes > 0 && written !== part.sizeBytes) {
        bookLayout.removeQuietly(staging);
        throw new StaleInoError(i, part.name);
      }

      bytesDone += written;
      options.onProgress?.({
        bytesWritten: bytesDone,
        totalBytes,
        partIndex: i,
        partCount: parts.length,
      });
    }

    if (cancelled) return abandon('cancelled', 'Download stopped. Nothing was saved.');

    await swapIntoPlace(bookId, staging);

    return {
      ok: true,
      bytes: bytesDone,
      localRelPaths: parts.map((p, i) => bookLayout.relPath(bookId, i, p.name)),
    };
  } catch (error) {
    bookLayout.removeQuietly(staging);
    if (error instanceof StaleInoError) throw error;

    const detail = (error as Error)?.message ?? '';
    // A cancel rejects the pending promise; that is this code's own doing.
    if (cancelled || /abort/i.test(detail)) {
      return { ok: false, reason: 'cancelled', message: 'Download stopped. Nothing was saved.' };
    }
    if (/ENOSPC|No space left/i.test(detail)) {
      return { ok: false, reason: 'no-space', message: plainFailure(detail) };
    }
    return { ok: false, reason: 'failed', message: plainFailure(detail) };
  } finally {
    current = null;
  }
}

/** Blocks while the transfer is paused, waking when it is resumed or killed. */
function waitUntilResumed(isPaused: () => boolean, isCancelled: () => boolean): Promise<void> {
  if (!isPaused() || isCancelled()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!isPaused() || isCancelled()) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

/** Re-exported so callers do not need two imports to clean up after a failure. */
export function discardStaging(bookId: string) {
  bookLayout.removeQuietly(bookLayout.staging(bookId) as Directory);
}
