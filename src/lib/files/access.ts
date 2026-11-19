/**
 * The one place that knows how files are reached on each platform. Screens and
 * scan logic depend on this interface and never branch on `Platform.OS`.
 *
 * Backed entirely by `expo-file-system`. The known gap is that iOS does not
 * persist access across restarts, so a picked folder is lost on relaunch.
 */

import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { DEFAULT_BLOCK_SIZE, CachingReader, type ByteReader } from '@/lib/metadata/reader';
import {
  isDrmContainer,
  isSupportedAudio,
  isUnsupportedAudio,
  readMetadata,
  type FileMetadata,
  type ReadOptions,
} from '@/lib/metadata';
import { isJunkFile, type ScannedFile } from '@/lib/library/grouping';
import { safDisplayName } from './safNames';
import { shouldSweep } from './coverNames';

/** What a walk of the library root found. */
export type TreeListing = {
  files: ScannedFile[];
  /** Audio we recognise but do not support in v1. */
  unsupportedCount: number;
  /** Folders that could not be listed, as "relative path: reason". */
  unreadableFolders: string[];
  /**
   * Folders the walk did not see all of, by relative path alone.
   *
   * The same set as `unreadableFolders`, plus any subtree cut off by the depth
   * limit — which used to return silently, so a library nested deeper than the
   * limit lost books with nothing anywhere to say so.
   *
   * Paths rather than sentences, because this one is read by code: a book
   * whose folder sits under one of these was not looked for, and a scan that
   * did not look for it is no evidence that it has gone.
   */
  unseenFolders: string[];
  /**
   * Whether the root folder itself could be listed. A separate flag, not
   * `files.length === 0`: an empty folder is a legitimate, readable answer,
   * and an unreadable root must never be mistaken for one.
   */
  rootReadable: boolean;
};

export type LibraryRoot = {
  uri: string;
  /** The folder's own name, for display. */
  name: string;
};

/**
 * Normalises a folder URI so it ends in a slash. `expo-file-system` treats one
 * without as a file, and listing it throws — silently reporting the root
 * unreadable. The picker happens to return the slash; nothing else need.
 */
export function asDirectoryUri(uri: string): string {
  return uri.endsWith('/') ? uri : `${uri}/`;
}

/** Where cover thumbnails are cached. */
export const COVERS_DIR = 'covers';

function coversDirectory(): Directory {
  const dir = new Directory(Paths.document, COVERS_DIR);
  try {
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    // Already there, or created concurrently by another scan.
  }
  return dir;
}

/**
 * Opens the system folder picker and returns the chosen root.
 *
 * On Android this takes a persistable URI permission, so the same folder is
 * reachable after a restart. Returns null if the user cancels.
 */
export async function pickLibraryRoot(): Promise<LibraryRoot | null> {
  try {
    const dir = await Directory.pickDirectoryAsync();
    if (!dir) return null;
    return { uri: asDirectoryUri(dir.uri), name: safDisplayName(dir.name) || dir.uri };
  } catch {
    // The picker throws rather than resolving when dismissed on some versions.
    return null;
  }
}

/**
 * Checks whether a previously picked root can still be read. This is the
 * drive-connected test, and it runs on launch and on every return to foreground.
 */
export async function isReachable(rootUri: string): Promise<boolean> {
  try {
    const dir = new Directory(asDirectoryUri(rootUri));
    if (!dir.exists) return false;
    // `exists` can be true for a stale permission, so prove we can list it.
    dir.list();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the root is there, without proving it can be read. One existence
 * check, because this runs on a timer while the app is in front of you.
 *
 * Deliberately the weaker test — a stale SAF permission can report a folder
 * that has gone — so a *change* here is a reason to ask `isReachable`
 * properly, never the answer itself.
 */
export function isPresent(rootUri: string): boolean {
  try {
    return new Directory(asDirectoryUri(rootUri)).exists;
  } catch {
    return false;
  }
}

/**
 * Walks the tree under `rootUri`, returning every file with the facts the
 * scanner needs to decide whether it has changed.
 *
 * `onProgress` is called as folders are entered so a long walk can show
 * something; errors listing one folder never abort the walk.
 */
export async function listTree(
  rootUri: string,
  options: { maxDepth?: number; onProgress?: (filesSoFar: number) => void } = {},
): Promise<TreeListing> {
  const maxDepth = options.maxDepth ?? 8;
  const files: ScannedFile[] = [];
  const unreadableFolders: string[] = [];
  const unseenFolders: string[] = [];
  let unsupportedCount = 0;

  const root = new Directory(asDirectoryUri(rootUri));

  /*
   * Ask outright, rather than inferring from a thrown error: `list()` does not
   * throw for a folder that has gone, it returns nothing. `exists` alone is
   * not enough either, so listing is still attempted. `npm run kb missing root`.
   */
  let rootReadable = true;
  try {
    if (!root.exists) {
      rootReadable = false;
    } else {
      root.list();
    }
  } catch {
    rootReadable = false;
  }

  if (!rootReadable) {
    unreadableFolders.push('.: the library folder could not be read');
    unseenFolders.push('');
    return { files, unsupportedCount, unreadableFolders, unseenFolders, rootReadable };
  }

  /*
   * Yielded between folders, because every call in here is synchronous: a walk
   * of a real library would otherwise run start to finish inside one turn, and
   * no progress message could be painted until it had already finished.
   */
  let sinceYield = 0;
  const breathe = async () => {
    if (sinceYield < 64) return;
    sinceYield = 0;
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const visit = async (dir: Directory, relPrefix: string, depth: number) => {
    if (depth > maxDepth) {
      /*
       * Recorded, not just skipped.
       *
       * This returned silently, so a book nested deeper than the limit was
       * absent from the listing with nothing to explain it — and absent from
       * a scan's `seenIds`, which is what `markMissingExcept` reads as proof
       * the book has gone from the drive.
       */
      unreadableFolders.push(
        `${relPrefix || '.'}: nested deeper than the scan goes (${maxDepth} folders)`,
      );
      unseenFolders.push(relPrefix);
      return;
    }
    let entries: (File | Directory)[];
    try {
      entries = dir.list();
    } catch (err) {
      if (depth === 0) rootReadable = false;
      // The reason matters. A folder that cannot be listed used to be recorded
      // as a bare path, which left "scanned no books" with nothing to act on.
      const reason = (err as Error)?.message ?? 'unreadable';
      unreadableFolders.push(`${relPrefix || '.'}: ${reason}`);
      unseenFolders.push(relPrefix);
      return;
    }
    await breathe();

    for (const entry of entries) {
      sinceYield += 1;
      const name = safDisplayName(entry.name);
      // Dropped here rather than later, so junk is never counted as a skipped
      // file, never warned about, and never offered as cover art.
      if (isJunkFile(name)) continue;
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;
      if (entry instanceof Directory) {
        await visit(entry, relPath, depth + 1);
        continue;
      }
      if (isUnsupportedAudio(name)) {
        unsupportedCount += 1;
        continue;
      }
      // Non-audio files are kept in the listing: cover images are found from
      // it, and grouping needs to see DRM containers to mark their books.
      let sizeBytes = 0;
      let modifiedMs = 0;
      try {
        sizeBytes = entry.size ?? 0;
        modifiedMs = entry.modificationTime ?? 0;
      } catch {
        // A file we cannot stat is still worth listing by name.
      }
      files.push({ relPath, name, uri: entry.uri, sizeBytes, modifiedMs });
      if (files.length % 50 === 0) options.onProgress?.(files.length);
    }
  };

  await visit(root, '', 0);
  options.onProgress?.(files.length);
  return { files, unsupportedCount, unreadableFolders, unseenFolders, rootReadable };
}

/** Opens a seekable reader over one file. */
export function openReader(uri: string, blockSize = DEFAULT_BLOCK_SIZE): ByteReader {
  const file = new File(uri);
  // SAF content:// URIs reject ReadWrite, and reading never writes.
  const handle = file.open(FileMode.ReadOnly);
  return new CachingReader(
    {
      async size() {
        return handle.size ?? file.size ?? 0;
      },
      async read(offset: number, length: number) {
        handle.offset = offset;
        const bytes = handle.readBytes(length);
        if (bytes.length === 0 && length > 0) {
          throw new Error(`Empty native read: offset ${offset}, requested ${length}, handle size ${handle.size}, file size ${file.size}`);
        }
        return bytes;
      },
      async close() {
        handle.close();
      },
    },
    blockSize,
  );
}

export type FileRead = {
  metadata: FileMetadata;
  bytesRead: number;
  readCount: number;
  ms: number;
};

/**
 * Failures worth a second attempt: a handle that went bad, rather than a file
 * we genuinely cannot parse. USB hands back dead descriptors now and then.
 *
 * Narrowed to that class deliberately: a corrupt container should be parsed
 * once and reported, not read twice.
 */
function isStaleHandleError(message: string): boolean {
  return /bad file descriptor|EBADF|closed|invalid file handle/i.test(message);
}

/**
 * Reads one file's metadata, reporting what it cost. Never throws: a file that
 * cannot be parsed comes back with an `error` so one bad file cannot stop a
 * scan.
 */
export async function readFileMetadata(
  uri: string,
  fileName: string,
  options: ReadOptions = {},
): Promise<FileRead & { error?: string }> {
  const first = await readOnce(uri, fileName, options);
  if (!first.error || !isStaleHandleError(first.error)) return first;

  const second = await readOnce(uri, fileName, options);
  // Charge both attempts, so the scan report shows what the drive actually cost.
  const bytesRead = first.bytesRead + second.bytesRead;
  const readCount = first.readCount + second.readCount;
  const ms = first.ms + second.ms;
  return { ...second, bytesRead, readCount, ms };
}

async function readOnce(
  uri: string,
  fileName: string,
  options: ReadOptions,
): Promise<FileRead & { error?: string }> {
  const started = Date.now();
  let reader: ByteReader | null = null;
  try {
    reader = openReader(uri);
    const metadata = await readMetadata(reader, fileName, options);
    return {
      metadata,
      bytesRead: reader.bytesRead,
      readCount: reader.readCount,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      metadata: { durationSec: 0, chapters: [], chapterSource: 'none' },
      bytesRead: reader?.bytesRead ?? 0,
      readCount: reader?.readCount ?? 0,
      ms: Date.now() - started,
      error: (err as Error)?.message ?? 'Unreadable',
    };
  } finally {
    try {
      await reader?.close();
    } catch {
      // Closing a handle for a drive that vanished mid-read is not an error.
    }
  }
}

/** Reads an image file beside the audio, for use as the cover. */
export async function readImageFile(uri: string, maxBytes = 8 * 1024 * 1024): Promise<Uint8Array | null> {
  try {
    const file = new File(uri);
    const size = file.size ?? 0;
    if (size <= 0 || size > maxBytes) return null;
    return file.bytes();
  } catch {
    return null;
  }
}

/**
 * Deletes every cached thumbnail belonging to a book, except `keep`.
 * Thumbnails are named for their artwork, so deleting by prefix is what clears
 * a book's covers without having to know what the current one is called.
 *
 * A cover the listener picked is left alone unless `includeUser` says
 * otherwise. Without that exception the next scan to store the drive's
 * artwork would sweep away a picked cover while the book's correction went on
 * naming it — a book with no picture, and nothing on screen to explain it.
 */
export function deleteCoversFor(
  bookId: string,
  keep?: string,
  options: { includeUser?: boolean } = {},
) {
  try {
    const dir = coversDirectory();
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (!(entry instanceof File)) continue;
      if (!shouldSweep(entry.name, bookId, keep, options.includeUser)) continue;
      try {
        entry.delete();
      } catch {
        // Already gone, or in use. The next store tries again.
      }
    }
  } catch {
    // No covers directory yet.
  }
}

/** Deletes a cached cover thumbnail, ignoring one that has already gone. */
export function deleteCover(fileName: string) {
  try {
    const f = new File(coversDirectory(), fileName);
    if (f.exists) f.delete();
  } catch {
    // Nothing to do.
  }
}

/**
 * Writes raw image bytes into the covers directory and returns the file's URI.
 * Downscaling happens in `covers.ts`, which needs a URI to work from.
 */
export async function writeCoverBytes(
  fileName: string,
  bytes: Uint8Array,
): Promise<string | null> {
  try {
    const target = new File(coversDirectory(), fileName);
    /*
     * Written beside the real name and swapped in, because the old file was
     * deleted before the new one was created: a write interrupted between the
     * two left the database pointing at a cover that no longer existed.
     * Nothing is destroyed until the replacement is whole and the right size.
     */
    const scratch = new File(coversDirectory(), `${fileName}.part`);
    if (scratch.exists) scratch.delete();
    scratch.create();
    scratch.write(bytes);
    if ((scratch.size ?? 0) !== bytes.length) {
      scratch.delete();
      return null;
    }
    await scratch.move(target, { overwrite: true });
    return target.uri;
  } catch {
    return null;
  }
}

export function coverUri(fileName: string): string {
  return new File(coversDirectory(), fileName).uri;
}

export { isSupportedAudio, isUnsupportedAudio, isDrmContainer };

export { safDisplayName };
