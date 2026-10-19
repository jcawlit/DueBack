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
import { fingerprintKey, groupIntoBooks, type FileGroup } from '@/lib/library/grouping';
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
  book: string;
  file: string;
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
  books: FileGroup[],
  limit = 5,
): Promise<MetadataSample[]> {
  const samples: MetadataSample[] = [];
  for (const book of books.slice(0, limit)) {
    const file = book.files[0];
    if (!file) continue;
    const read = await readFileMetadata(file.uri, file.name);
    samples.push({
      book: book.folderRelPath || '(root)',
      file: file.name,
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
  book: FileGroup,
  options: { shouldCancel?: () => boolean; onProgress?: (fraction: number) => void } = {},
): Promise<CopyReport> {
  const id = 'spike-drive-copy';
  const parts: CopyPart[] = book.files.map((file) => ({
    uri: file.uri,
    name: file.name,
    sizeBytes: file.sizeBytes,
  }));
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
