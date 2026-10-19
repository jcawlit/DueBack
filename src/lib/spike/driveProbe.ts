/**
 * SPIKE — throwaway. Does a Google Drive folder behave like the drawer?
 *
 * Not a feature. This measures whether the Storage Access Framework over
 * Google Drive's provider can carry the pipeline the USB library already
 * uses, and the answer decides whether the Drive build is SAF or the Drive
 * REST API. Delete the whole `src/lib/spike/` folder once that is decided.
 *
 * It deliberately does **not** run `scanLibrary`. That writes books into
 * the one library, binds them to `library_id`, and sweeps anything it did
 * not find as missing — so pointing it at a second root would mix a Drive
 * folder into the USB shelves and mark the drive's books gone. Making that
 * safe means per-source libraries and a scoped sweep, which is the Drive
 * build itself; the point of a spike is to decide whether to do that work.
 *
 * Instead it runs the same primitives the scanner runs, in the same order,
 * and reports what each one cost:
 *
 *   listTree          → how long a listing takes, and what it finds
 *   readFileMetadata  → bytes actually pulled per book (the deciding number)
 *   groupIntoBooks    → whether books come out the same twice running
 *   copyBookToDevice  → whether a checkout completes at a sane speed
 */

import { isReachable, listTree, pickLibraryRoot, readFileMetadata } from '@/lib/files/access';
import { copyBookToDevice, deleteLocalCopy, type CopyPart } from '@/lib/files/copy';
import {
  fingerprintKey,
  groupIntoBooks,
  type FileGroup,
  type ScannedFile,
} from '@/lib/library/grouping';
import { getSetting, setSetting } from '@/db/schema';

export { sameBooks } from './identity';

/** Where the probe remembers the folder it was pointed at. */
const URI_KEY = 'spike.drive.uri';
const NAME_KEY = 'spike.drive.name';

export type ProbeFolder = { uri: string; name: string };

export async function savedFolder(): Promise<ProbeFolder | null> {
  const [uri, name] = await Promise.all([getSetting(URI_KEY), getSetting(NAME_KEY)]);
  return uri ? { uri, name: name ?? uri } : null;
}

/**
 * Opens the system picker and remembers what came back.
 *
 * The same call the drawer uses, which is the point: if Drive appears here
 * and hands back a tree, nothing below this line has to know the
 * difference between a memory stick and a cloud.
 */
export async function pickFolder(): Promise<ProbeFolder | null> {
  const root = await pickLibraryRoot();
  if (!root) return null;
  await setSetting(URI_KEY, root.uri);
  await setSetting(NAME_KEY, root.name);
  return { uri: root.uri, name: root.name };
}

export async function forgetFolder(): Promise<void> {
  await setSetting(URI_KEY, null);
  await setSetting(NAME_KEY, null);
}

/**
 * Whether the grant is still good.
 *
 * Question (a) turns on this telling the truth: a permission that did not
 * survive a reboot has to be distinguishable from a folder that is simply
 * empty, or the app cannot say anything useful about either.
 */
export async function checkGrant(uri: string): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  const ok = await isReachable(uri);
  return { ok, ms: Date.now() - started };
}

export type ListingReport = {
  ms: number;
  rootReadable: boolean;
  fileCount: number;
  unsupportedCount: number;
  unreadableFolders: string[];
  bookCount: number;
  /** Books whose identity key collides — a provider handing back dupes. */
  duplicateKeys: string[];
  /** The identity key of every book, in order, for comparing two runs. */
  keys: string[];
  books: FileGroup[];
  /**
   * Everything the walk found, books or not.
   *
   * Carried separately because grouping can legitimately produce nothing:
   * over Google Drive the provider hands back opaque document ids as
   * names, so no entry looks like audio and no book forms. The files are
   * still there and still readable, and the measurement that decides the
   * architecture has to be able to reach them regardless.
   */
  files: ScannedFile[];
};

/** One listing of the folder, timed. */
export async function probeListing(uri: string): Promise<ListingReport> {
  const started = Date.now();
  const listing = await listTree(uri);
  const ms = Date.now() - started;

  const books = groupIntoBooks(listing.files);
  const keys = books.map((book) =>
    fingerprintKey(book.folderRelPath, book.files[0]?.relPath ?? ''),
  );

  const seen = new Set<string>();
  const duplicateKeys: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) duplicateKeys.push(key);
    seen.add(key);
  }

  return {
    files: listing.files,
    ms,
    rootReadable: listing.rootReadable,
    fileCount: listing.files.length,
    unsupportedCount: listing.unsupportedCount,
    unreadableFolders: listing.unreadableFolders,
    bookCount: books.length,
    duplicateKeys,
    keys,
    books,
  };
}

export type MetadataSample = {
  /** Where it sits, which over Drive is a string of ids. */
  where: string;
  file: string;
  /** What the provider called it. Opaque here is the whole finding. */
  extension: string;
  /** What the file actually is, so a whole-file pull is obvious. */
  sizeBytes: number;
  /** What the provider made us read to get the tags out. */
  bytesRead: number;
  readCount: number;
  ms: number;
  error?: string;
};

/**
 * The deciding measurement.
 *
 * The scanner reads tags out of the first and last few hundred kilobytes of
 * a file and never the middle. Over USB that is what happens. A cloud
 * provider may instead download the whole file to satisfy the first read,
 * which would turn indexing a library into downloading it — and that is
 * the difference between SAF being viable here and not.
 *
 * `bytesRead` against `sizeBytes` is the evidence, per file.
 */
export async function probeMetadata(
  files: ScannedFile[],
  limit = 5,
): Promise<MetadataSample[]> {
  /*
   * Largest first, deliberately.
   *
   * A whole-file pull on a three-minute track costs nothing and proves
   * nothing. The question is what happens to a two-gigabyte m4b, because
   * that is where the difference between reading a header and downloading
   * a library actually shows up.
   */
  const biggest = [...files].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, limit);

  const samples: MetadataSample[] = [];
  for (const file of biggest) {
    const read = await readFileMetadata(file.uri, file.name);
    const dot = file.name.lastIndexOf('.');
    samples.push({
      where: file.relPath.slice(0, file.relPath.lastIndexOf('/') + 1) || '(root)',
      file: file.name,
      extension: dot > 0 ? file.name.slice(dot) : '(none)',
      sizeBytes: file.sizeBytes,
      bytesRead: read.bytesRead,
      readCount: read.readCount,
      ms: read.ms,
      error: read.error,
    });
  }
  return samples;
}

export type CopyReport = {
  ok: boolean;
  bytes: number;
  ms: number;
  /** Bytes per second, for comparing against a USB copy of the same size. */
  rate: number;
  message: string;
};

/**
 * One real checkout, through the real copy path.
 *
 * Into a scratch id rather than a book's, and deleted afterwards: this is a
 * measurement, and leaving gigabytes on the phone would be a poor way to
 * take one. Cancellation is driven from the caller the same way the
 * library's own Stop button drives it.
 */
export async function probeCopy(
  files: ScannedFile[],
  options: { shouldCancel?: () => boolean; onProgress?: (fraction: number) => void } = {},
): Promise<CopyReport> {
  const id = 'spike-drive-copy';
  const parts: CopyPart[] = files.map((file) => ({
    uri: file.uri,
    name: file.name,
    sizeBytes: file.sizeBytes,
  }));
  if (parts.length === 0) {
    return { ok: false, bytes: 0, ms: 0, rate: 0, message: 'nothing to copy' };
  }
  const total = parts.reduce((n, p) => n + p.sizeBytes, 0);

  const started = Date.now();
  const outcome = await copyBookToDevice(id, parts, {
    shouldCancel: options.shouldCancel,
    onProgress: ({ bytesCopied, totalBytes }) =>
      options.onProgress?.(totalBytes > 0 ? bytesCopied / totalBytes : 0),
  });
  const ms = Date.now() - started;

  // Measured, not kept.
  deleteLocalCopy(id);

  if (!outcome.ok) {
    return { ok: false, bytes: 0, ms, rate: 0, message: `${outcome.reason}: ${outcome.message}` };
  }
  return {
    ok: true,
    bytes: outcome.bytes,
    ms,
    rate: ms > 0 ? (outcome.bytes / ms) * 1000 : 0,
    message: `${outcome.localRelPaths.length} file(s), ${outcome.bytes} of ${total} bytes`,
  };
}
