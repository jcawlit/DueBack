/**
 * Copying a book from the drive onto the phone.
 *
 * All-or-nothing: parts are copied into a temporary folder and verified by
 * size, and only a complete set is moved into place, so a half-copied book is
 * never visible as a book. Any interrupt discards the folder.
 *
 * The exception is the app being killed, where no code runs to discard
 * anything: those staged files are kept and re-used, on terms set out in
 * `stagingIsFor` below. `npm run kb resume`.
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
 * Deletes everything in the temp folder, staged or not.
 *
 * For "forget this library" and for tests. Startup uses `sweepTempCopies`,
 * which keeps what an interrupted copy can still use.
 */
export function clearTempCopies() {
  removeQuietly(tmpRoot());
}

/**
 * Tidies the temp folder on launch, keeping staged files for a book that still
 * exists and whose staging is recent, so checking it out again carries on from
 * where it stopped. Everything else goes.
 */
export function sweepTempCopies(knownBookIds: string[]) {
  const known = new Set(knownBookIds);
  try {
    const root = tmpRoot();
    if (!root.exists) return;
    for (const entry of root.list()) {
      if (!(entry instanceof Directory) || !known.has(entry.name)) {
        removeQuietly(entry);
        continue;
      }
      let staledAt = 0;
      try {
        const manifest = new File(entry, MANIFEST_NAME);
        staledAt = manifest.exists ? (manifest.modificationTime ?? 0) : 0;
      } catch {
        staledAt = 0;
      }
      if (Date.now() - staledAt > STAGING_KEEP_MS) removeQuietly(entry);
    }
  } catch {
    // The temp folder is not there, or cannot be listed. Nothing to do.
  }
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
 * Resolves a stored relative path to a playable `file://` URI. Paths are
 * stored relative to the documents directory because the app's data directory
 * can move between installs and OS upgrades.
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

/** Records which parts a staged folder was built for. */
export const MANIFEST_NAME = 'manifest.json';

/**
 * How long staged files from an interrupted copy are kept.
 *
 * They are only ever re-used by a check-out of the same book, and a book the
 * user never asks for again should not hold on to gigabytes for ever.
 */
export const STAGING_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function manifestFor(parts: CopyPart[]): string {
  return JSON.stringify(parts.map((p) => [p.name, p.sizeBytes]));
}

/**
 * Whether a staged folder was left by an interrupted copy of exactly these
 * parts.
 *
 * Staged files are named by index, so without this two parts that swapped
 * places on the drive would be read back under each other's names — and if
 * they were the same length, even the size check would pass.
 */
async function stagingIsFor(staging: Directory, parts: CopyPart[]): Promise<boolean> {
  try {
    const file = new File(staging, MANIFEST_NAME);
    if (!file.exists) return false;
    return (await file.text()) === manifestFor(parts);
  } catch {
    return false;
  }
}

/** The bytes of a staged part, if it is complete. Null if it is not there. */
function stagedBytes(target: File, expected: number): number | null {
  try {
    if (!target.exists) return null;
    const size = target.size ?? 0;
    // Only an exact match counts. Short means the write was cut off; longer
    // means it is not this file at all.
    return expected > 0 && size === expected ? size : null;
  } catch {
    return null;
  }
}

/** Whether a file is still there. A drive that has gone answers false. */
function exists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/**
 * A sentence a person can read, from whatever the platform threw. Expo's own
 * wrapping ("Call to function … has been rejected") is no use on screen, so
 * the detail goes to the log and the screen gets the plain version.
 */
function plainCopyFailure(detail: string): string {
  if (detail) console.warn('[dueback] copy failed:', detail);
  if (/ENOENT|No such file|EIO|Input\/output error|bad file descriptor|EBADF/i.test(detail)) {
    return 'The drive stopped responding partway through. Nothing was saved.';
  }
  if (/EACCES|permission/i.test(detail)) {
    return 'The phone was not allowed to read that file. Nothing was saved.';
  }
  return 'The copy stopped unexpectedly. Nothing was saved.';
}

/**
 * Copies every part into place. `onProgress` reports real bytes, measured from
 * the destination file as it grows: the native copy runs off the JS thread,
 * and pushing the bytes through JavaScript would be far slower.
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
  const missingNames = parts.filter((part) => !exists(part.uri)).map((part) => part.name);

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

  ensure(tmpRoot());
  const staging = new Directory(tmpRoot(), bookId);

  /*
   * Keep what an interrupted copy of this same book already landed. Only ever
   * reached after a kill — every other exit discards the folder — and only
   * believed when the manifest matches.
   */
  const resuming = staging.exists && (await stagingIsFor(staging, parts));
  if (!resuming) {
    removeQuietly(staging);
    ensure(staging);
    try {
      const manifest = new File(staging, MANIFEST_NAME);
      manifest.create();
      manifest.write(manifestFor(parts));
    } catch {
      // Without a manifest the next run simply starts over, which is the
      // behaviour this replaced. Not worth failing a copy for.
    }
  }

  /**
   * What an interrupted run already landed, per part. `null` means copy it.
   *
   * Worked out up front because it decides how much room is still needed: a
   * resume is charged for the bytes still to come, not for the whole book.
   */
  const staged = parts.map((part, i) =>
    resuming ? stagedBytes(new File(staging, partFileName(i, part.name)), part.sizeBytes) : null,
  );
  const alreadyStaged = staged.reduce<number>((n, bytes) => n + (bytes ?? 0), 0);

  const space = checkFreeSpace(totalBytes - alreadyStaged);
  if (!space.ok) {
    return {
      ok: false,
      reason: 'no-space',
      message: `Not enough room on the phone — ${Math.ceil(space.shortBy / 1024 / 1024)} MB short.`,
    };
  }

  let bytesDone = 0;
  let resumedParts = 0;
  /** The part being read when something went wrong. */
  let inFlight = -1;

  try {
    for (let i = 0; i < parts.length; i += 1) {
      if (options.shouldCancel?.()) {
        removeQuietly(staging);
        return { ok: false, reason: 'cancelled', message: 'Copy stopped. Nothing was saved.' };
      }

      const part = parts[i];
      inFlight = i;
      const target = new File(staging, partFileName(i, part.name));
      const source = new File(part.uri);

      // Already here, and exactly the right size: an earlier run got this far.
      const already = staged[i];
      if (already !== null) {
        resumedParts += 1;
        bytesDone += already;
        options.onProgress?.({
          bytesCopied: bytesDone,
          totalBytes,
          partIndex: i,
          partCount: parts.length,
        });
        continue;
      }
      // A short file is the tail of a write that was cut off; `copy` would
      // refuse to write over it anyway.
      removeQuietly(target);

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
    // The manifest has done its job and must not travel with the audio.
    removeQuietly(new File(staging, MANIFEST_NAME));
    if (resumedParts > 0) {
      console.log(`[dueback] resumed ${resumedParts}/${parts.length} staged parts for ${bookId}`);
    }
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

    /*
     * A read that died because its source went away is not a fault. The error
     * text is no way to tell — the honest test is whether the file is still
     * there — and the caller asks the root to separate a pulled drive from a
     * deleted book.
     */
    const part = parts[inFlight];
    if (part && !exists(part.uri)) {
      return {
        ok: false,
        reason: 'source-missing',
        missingNames: [part.name],
        message: `${part.name} could not be read any more. Nothing was saved.`,
      };
    }

    return { ok: false, reason: 'failed', message: plainCopyFailure(detail) };
  }
}
