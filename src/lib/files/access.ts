/**
 * The one place that knows how files are reached on each platform.
 *
 * Screens and scan logic depend on this interface and never branch on
 * `Platform.OS`. Today it is backed entirely by `expo-file-system`, whose
 * `Directory.pickDirectoryAsync()` and seekable `FileHandle` cover both
 * platforms; the known gap is that iOS does not persist access across app
 * restarts, which surfaces here as `restoreAccess()` returning false and the
 * app showing the drive as not connected.
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

/** What a walk of the library root found. */
export type TreeListing = {
  files: ScannedFile[];
  /** Audio we recognise but do not support in v1. */
  unsupportedCount: number;
  /** Folders that could not be listed, by relative path. */
  unreadableFolders: string[];
};

export type LibraryRoot = {
  uri: string;
  /** The folder's own name, for display. */
  name: string;
};

/**
 * Normalises a folder URI so it ends in a slash.
 *
 * `expo-file-system` treats a `Directory` URI without a trailing slash as a
 * file: listing one throws, and the scan reports the root as unreadable and
 * finds nothing at all — silently, because an unreadable folder is not an
 * error. The system picker happens to return the slash, so this only bites a
 * root that arrives from anywhere else, which is exactly the sort of thing that
 * should not depend on luck.
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
 * Re-establishes access to a saved root. On Android the persisted permission
 * makes this a reachability check; on iOS access is not persisted, so this
 * returns false after a restart and the user is asked to pick again.
 */
export async function restoreAccess(rootUri: string): Promise<boolean> {
  return isReachable(rootUri);
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
  let unsupportedCount = 0;

  const root = new Directory(asDirectoryUri(rootUri));

  const visit = (dir: Directory, relPrefix: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: (File | Directory)[];
    try {
      entries = dir.list();
    } catch (err) {
      // The reason matters. A folder that cannot be listed used to be recorded
      // as a bare path, which left "scanned no books" with nothing to act on.
      const reason = (err as Error)?.message ?? 'unreadable';
      unreadableFolders.push(`${relPrefix || '.'}: ${reason}`);
      return;
    }
    for (const entry of entries) {
      const name = safDisplayName(entry.name);
      // Dropped here rather than later, so junk is never counted as a skipped
      // file, never warned about, and never offered as cover art.
      if (isJunkFile(name)) continue;
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;
      if (entry instanceof Directory) {
        visit(entry, relPath, depth + 1);
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

  visit(root, '', 0);
  options.onProgress?.(files.length);
  return { files, unsupportedCount, unreadableFolders };
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
        return handle.readBytes(length);
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
 * Failures worth a second attempt: a handle that went bad rather than a file we
 * genuinely cannot parse.
 *
 * Scanning 551 files off a USB drive turned up a few `java.io.IOException: Bad
 * file descriptor` failures thrown by the very first seek, on files that read
 * perfectly in isolation — the descriptor the storage provider handed back was
 * already dead. Narrowed to that class deliberately: a corrupt container should
 * be parsed once and reported, not read twice.
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
export function writeCoverBytes(fileName: string, bytes: Uint8Array): string | null {
  try {
    const file = new File(coversDirectory(), fileName);
    if (file.exists) file.delete();
    file.create();
    file.write(bytes);
    return file.uri;
  } catch {
    return null;
  }
}

export function coverUri(fileName: string): string {
  return new File(coversDirectory(), fileName).uri;
}

export { isSupportedAudio, isUnsupportedAudio, isDrmContainer };

export { safDisplayName };
