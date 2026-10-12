/**
 * Copying a book from the drive onto the phone.
 *
 * All-or-nothing, by design. Parts are copied into a temporary folder and each
 * one's size is verified; only when every part has landed does the folder move
 * into place. Anything else — a pulled drive, a cancel, a failed read — deletes
 * the temporary folder and leaves the book on the shelf. There is no resume and
 * no half-copied state to reason about later.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { safeLocalName } from './localNames';
import { ENOSPC_MESSAGE, diskFault } from '@/dev/faults';

/** Completed books live here; in-progress ones in the sibling temp folder. */
export const BOOKS_DIR = 'books';
export const BOOKS_TMP_DIR = 'books-tmp';

/**
 * Headroom the phone keeps for everything else. A book is refused if copying
 * it would leave less than this free, whatever the storage budget says.
 */
export const FREE_SPACE_MARGIN_BYTES = 1024 * 1024 * 1024;

/** How often the destination is measured while a native copy runs. */
const PROGRESS_POLL_MS = 400;

export type CopyPart = {
  /** Source on the drive. */
  uri: string;
  name: string;
  sizeBytes: number;
};

export type CopyProgress = {
  bytesCopied: number;
  totalBytes: number;
  partIndex: number;
  partCount: number;
};

export type CopyOutcome =
  | { ok: true; localRelPaths: string[]; bytes: number }
  | {
      ok: false;
      /**
       * `source-missing` is kept apart from `failed` because it is not a fault:
       * the book has been deleted from the drive since the last scan, and the
       * caller should say so and mark the book missing rather than reporting a
       * copy that went wrong.
       */
      reason: 'cancelled' | 'no-space' | 'failed' | 'source-missing';
      message: string;
      /** For `source-missing`: the parts that are no longer there. */
      missingNames?: string[];
    };

function booksDir() {
  return new Directory(Paths.document, BOOKS_DIR);
}

function tmpRoot() {
  return new Directory(Paths.document, BOOKS_TMP_DIR);
}

function ensure(dir: Directory) {
  try {
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    // Created concurrently, or already there.
  }
  return dir;
}

function removeQuietly(entry: Directory | File) {
  try {
    if (entry.exists) entry.delete();
  } catch {
    // Nothing to do — a leftover folder is cleaned on the next launch.
  }
}

/**
 * Deletes anything left in the temp folder.
 *
 * Called on every launch: if the app was killed mid-copy there is no process
 * left to clean up after itself, and a half-written book must never be
 * mistaken for a complete one.
 */
export function clearTempCopies() {
  removeQuietly(tmpRoot());
}

/** Free space on the phone right now, in bytes. */
export function availableBytes(): number {
  // A test can stand in a figure here; see src/dev/faults.ts.
  const faked = diskFault().freeBytes;
  if (faked !== undefined) return faked;
  try {
    return Paths.availableDiskSpace ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Whether `bytes` can be copied without taking the phone below the margin.
 * Returns the shortfall when it cannot.
 */
export function checkFreeSpace(bytes: number): { ok: true } | { ok: false; shortBy: number } {
  const free = availableBytes();
  const needed = bytes + FREE_SPACE_MARGIN_BYTES;
  if (free >= needed) return { ok: true };
  return { ok: false, shortBy: needed - free };
}

/**
 * Resolves a stored relative path to a playable `file://` URI.
 *
 * Paths are stored relative to the documents directory rather than as absolute
 * URIs, because the app's data directory can move between installs and OS
 * upgrades — an absolute URI recorded today may not exist tomorrow. Resolving
 * at the point of use keeps the database portable.
 */
export function localUriFor(relPath: string): string | null {
  try {
    const file = new File(Paths.document, relPath);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

/** Local files for a book, if a previous copy completed. */
export function localPathsFor(bookId: string): string[] {
  try {
    const dir = new Directory(booksDir(), bookId);
    if (!dir.exists) return [];
    return dir
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => f.uri);
  } catch {
    return [];
  }
}

export function deleteLocalCopy(bookId: string) {
  removeQuietly(new Directory(booksDir(), bookId));
}

/** The book ids that currently have a folder of copied audio on the phone. */
export function listLocalBookIds(): string[] {
  try {
    const dir = booksDir();
    if (!dir.exists) return [];
    return dir
      .list()
      .filter((e): e is Directory => e instanceof Directory)
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** See `safeLocalName`: the drive's own filenames cannot be trusted here. */
const partFileName = safeLocalName;

/**
 * Copies every part into place.
 *
 * `onProgress` reports real bytes: the native copy runs off the JS thread, so
 * progress comes from measuring the destination file as it grows rather than
 * from pushing the bytes through JavaScript, which would be far slower.
 */
export async function copyBookToDevice(
  bookId: string,
  parts: CopyPart[],
  options: {
    onProgress?: (progress: CopyProgress) => void;
    shouldCancel?: () => boolean;
  } = {},
): Promise<CopyOutcome> {
  const totalBytes = parts.reduce((n, p) => n + p.sizeBytes, 0);

  // The drive being reachable does not mean this book is still on it. A folder
  // deleted from the drive while the app was open leaves the index pointing at
  // files that have gone, and the copy would then die partway through with a
  // native error that means nothing to anyone. Ask first.
  const missingNames = parts
    .filter((part) => {
      try {
        return !new File(part.uri).exists;
      } catch {
        return true;
      }
    })
    .map((part) => part.name);

  if (missingNames.length > 0) {
    return {
      ok: false,
      reason: 'source-missing',
      missingNames,
      message:
        missingNames.length === parts.length
          ? 'This book is no longer in the library folder.'
          : `${missingNames.length} of ${parts.length} files are no longer in the library folder.`,
    };
  }

  const space = checkFreeSpace(totalBytes);
  if (!space.ok) {
    return {
      ok: false,
      reason: 'no-space',
      message: `Not enough room on the phone — ${Math.ceil(space.shortBy / 1024 / 1024)} MB short.`,
    };
  }

  ensure(tmpRoot());
  const staging = new Directory(tmpRoot(), bookId);
  removeQuietly(staging);
  ensure(staging);

  let bytesDone = 0;

  try {
    for (let i = 0; i < parts.length; i += 1) {
      if (options.shouldCancel?.()) {
        removeQuietly(staging);
        return { ok: false, reason: 'cancelled', message: 'Copy stopped. Nothing was saved.' };
      }

      const part = parts[i];
      const target = new File(staging, partFileName(i, part.name));
      const source = new File(part.uri);

      // Watch the destination grow while the native copy runs.
      let timer: ReturnType<typeof setInterval> | undefined;
      if (options.onProgress) {
        const base = bytesDone;
        timer = setInterval(() => {
          let written = 0;
          try {
            written = target.exists ? (target.size ?? 0) : 0;
          } catch {
            written = 0;
          }
          options.onProgress?.({
            bytesCopied: Math.min(totalBytes, base + written),
            totalBytes,
            partIndex: i,
            partCount: parts.length,
          });
        }, PROGRESS_POLL_MS);
      }

      try {
        if (diskFault().failWriteAtPart === i) throw new Error(ENOSPC_MESSAGE);
        await source.copy(target);
      } finally {
        clearInterval(timer);
      }

      // Size verification is the only integrity check that is free. A short
      // file means the drive went away mid-write.
      const written = target.exists ? (target.size ?? 0) : 0;
      if (part.sizeBytes > 0 && written !== part.sizeBytes) {
        removeQuietly(staging);
        return {
          ok: false,
          reason: 'failed',
          message: `${part.name} copied incompletely. Copy stopped. Nothing was saved.`,
        };
      }

      bytesDone += written;
      options.onProgress?.({
        bytesCopied: bytesDone,
        totalBytes,
        partIndex: i,
        partCount: parts.length,
      });
    }

    if (options.shouldCancel?.()) {
      removeQuietly(staging);
      return { ok: false, reason: 'cancelled', message: 'Copy stopped. Nothing was saved.' };
    }

    // Everything is here and the right size: now it becomes a checked-out book.
    const finalDir = new Directory(booksDir(), bookId);
    ensure(booksDir());
    removeQuietly(finalDir);
    staging.move(finalDir);

    return {
      ok: true,
      bytes: bytesDone,
      localRelPaths: parts.map((p, i) => `${BOOKS_DIR}/${bookId}/${partFileName(i, p.name)}`),
    };
  } catch (err) {
    removeQuietly(staging);
    const detail = (err as Error)?.message ?? '';

    // A disk that fills partway through surfaces as a native ENOSPC. That is
    // not a fault to report as one — the phone is simply full — and
    // "ENOSPC: No space left on device, write" is not a sentence to show
    // anyone. The free-space check before the copy cannot catch this: another
    // app may have taken the room while this copy was running.
    if (/ENOSPC|No space left/i.test(detail)) {
      return {
        ok: false,
        reason: 'no-space',
        message: 'The phone ran out of room partway through. Nothing was saved.',
      };
    }

    return {
      ok: false,
      reason: 'failed',
      message: `${detail || 'The copy failed'}. Nothing was saved.`,
    };
  }
}
