/**
 * Adding a book that lives on the phone rather than on the library drive.
 *
 * The picked audio is copied into app storage straight away: a picked file's
 * permission may not survive a restart, and the user can move or delete the
 * original at any time.
 */

import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { INCOMPLETE_MARKER } from '@/lib/library/grouping';
import { isSupportedAudio } from '@/lib/metadata';
import { naturalCompare } from '@/lib/library/names';
import { safeLocalName } from './localNames';
import { safDisplayName } from './safNames';

/** Imported audio lives here, beside `books/` and `books-tmp/`. */
export const IMPORTS_DIR = 'imported';

export type ImportedFile = {
  /** Path relative to the documents directory. */
  relPath: string;
  uri: string;
  name: string;
  sizeBytes: number;
};

/** Reports staging progress, so a folder of twelve parts is not a dead screen. */
export type ImportProgress = (step: { done: number; total: number; name: string }) => void;

export type ImportResult =
  | { ok: true; bookId: string; folderName: string; files: ImportedFile[] }
  | { ok: false; reason: 'cancelled' | 'no-audio' | 'failed'; message: string };

function importsDir() {
  const dir = new Directory(Paths.document, IMPORTS_DIR);
  try {
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    // Already there.
  }
  return dir;
}

function removeQuietly(entry: Directory | File) {
  try {
    if (entry.exists) entry.delete();
  } catch {
    // Nothing to do.
  }
}

/** A folder name for the import, derived from what the user picked. */
function safeFolderName(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'Imported book';
}

/** A stable id for an imported book — it has no library-relative path. */
function importId(): string {
  return `imp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Copies a set of source files into `imported/<id>/`.
 * Returns the files as they now exist inside app storage.
 */
async function stageFiles(
  bookId: string,
  sources: { uri: string; name: string }[],
  onProgress?: ImportProgress,
): Promise<ImportedFile[]> {
  const target = new Directory(importsDir(), bookId);
  removeQuietly(target);
  target.create({ intermediates: true });

  const staged: ImportedFile[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    const src = sources[i];
    // The picked file's own name is not safe to put in a local path; see
    // `safeLocalName`. The readable name is kept in `name` below, which is what
    // the database and the drive both use.
    const fileName = safeLocalName(i, src.name);
    const dest = new File(target, fileName);
    onProgress?.({ done: i, total: sources.length, name: src.name });
    await new File(src.uri).copy(dest);
    staged.push({
      relPath: `${IMPORTS_DIR}/${bookId}/${fileName}`,
      uri: dest.uri,
      name: src.name,
      sizeBytes: dest.size ?? 0,
    });
  }
  return staged;
}

/** Lets the user pick one audio file and brings it into the library. */
export async function importBookFromFile(onProgress?: ImportProgress): Promise<ImportResult> {
  let picked: File | null = null;
  try {
    const result = await File.pickFileAsync({
      mimeTypes: ['audio/*'],
    });
    if (result.canceled) return { ok: false, reason: 'cancelled', message: 'Nothing added.' };
    picked = result.result;
  } catch {
    return { ok: false, reason: 'cancelled', message: 'Nothing added.' };
  }

  const pickedName = picked ? safDisplayName(picked.name) : '';
  if (!picked || !isSupportedAudio(pickedName)) {
    return {
      ok: false,
      reason: 'no-audio',
      message: 'That file is not an .m4b, .m4a or .mp3.',
    };
  }

  const bookId = importId();
  try {
    const files = await stageFiles(
      bookId,
      [{ uri: picked.uri, name: pickedName }],
      onProgress,
    );
    return {
      ok: true,
      bookId,
      folderName: safeFolderName(pickedName.replace(/\.[^.]+$/, '')),
      files,
    };
  } catch (err) {
    removeQuietly(new Directory(importsDir(), bookId));
    return { ok: false, reason: 'failed', message: (err as Error)?.message ?? 'The copy failed.' };
  }
}

/** Lets the user pick a folder of audio and brings the whole book in. */
export async function importBookFromFolder(onProgress?: ImportProgress): Promise<ImportResult> {
  let dir: Directory | null = null;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch {
    return { ok: false, reason: 'cancelled', message: 'Nothing added.' };
  }
  if (!dir) return { ok: false, reason: 'cancelled', message: 'Nothing added.' };

  let audio: { uri: string; name: string }[] = [];
  try {
    // Names come back as SAF document ids — `primary:Download/My Book/01.mp3`
    // rather than `01.mp3` — so they are trimmed before anything reads them as
    // a filename. Untrimmed, the volume prefix ended up in the book's title and
    // in every one of its chapter names.
    audio = dir
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => ({ uri: f.uri, name: safDisplayName(f.name) }))
      .filter((f) => isSupportedAudio(f.name))
      .sort((a, b) => naturalCompare(a.name, b.name));
  } catch {
    return { ok: false, reason: 'failed', message: 'That folder could not be read.' };
  }

  if (audio.length === 0) {
    return {
      ok: false,
      reason: 'no-audio',
      message: 'No .m4b, .m4a or .mp3 files in that folder.',
    };
  }

  const bookId = importId();
  try {
    const files = await stageFiles(bookId, audio, onProgress);
    return {
      ok: true,
      bookId,
      folderName: safeFolderName(safDisplayName(dir.name)),
      files,
    };
  } catch (err) {
    removeQuietly(new Directory(importsDir(), bookId));
    return { ok: false, reason: 'failed', message: (err as Error)?.message ?? 'The copy failed.' };
  }
}

/** Whether a folder on the drive is the wreckage of a push that never finished. */
function isIncompleteFolder(dir: Directory): boolean {
  try {
    return dir.list().some((e) => safDisplayName(e.name) === INCOMPLETE_MARKER);
  } catch {
    return false;
  }
}

export function deleteImport(bookId: string) {
  removeQuietly(new Directory(importsDir(), bookId));
}

/** Resolves a stored relative import path to a playable URI. */
export function importedUriFor(relPath: string): string | null {
  try {
    const file = new File(Paths.document, relPath);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

/** How much of a file moves per turn. Big enough to be quick, small enough to yield. */
const DRIVE_CHUNK_BYTES = 4 * 1024 * 1024;

/** Reports how far a push to the drive has got, so a 1 GB book is not a dead screen. */
export type DrivePushProgress = (step: {
  fileIndex: number;
  fileCount: number;
  name: string;
  bytesCopied: number;
  totalBytes: number;
}) => void;

/** The content type to hand the storage provider when creating a document. */
function audioMimeFor(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4b' || ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  return 'application/octet-stream';
}

/**
 * Writes one file onto the drive under a readable name.
 *
 * Deliberately not `copy()`, which cannot be told what to call its destination
 * on a `content://` volume. `Directory.createFile` is the one supported way to
 * make a named document there, and the bytes then have to be put through it by
 * hand. `npm run kb saf rename`.
 *
 * `readBytes` and `writeBytes` are synchronous, so the await between chunks is
 * not decoration: without it nothing on screen moves until the file is done.
 */
async function streamOntoDrive(
  source: File,
  dest: File,
  onBytes?: (copied: number) => void,
): Promise<number> {
  const read = source.open(FileMode.ReadOnly);
  const write = dest.open(FileMode.WriteOnly);
  let copied = 0;
  try {
    for (;;) {
      const chunk = read.readBytes(DRIVE_CHUNK_BYTES);
      if (chunk.length === 0) break;
      write.writeBytes(chunk);
      copied += chunk.length;
      onBytes?.(copied);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    try {
      write.close();
    } catch {
      // Already released.
    }
    try {
      read.close();
    } catch {
      // Already released.
    }
  }
  return copied;
}

/**
 * Copies an imported book onto the library drive, returning where each file
 * landed so the book's parts can be re-pointed at it.
 *
 * There is no staging folder here, unlike the copy onto the phone: SAF has no
 * rename and no cheap move, so the folder is created under its final name and
 * written into directly, and any failure deletes the whole folder.
 * `npm run kb saf rename`.
 *
 * The exposure that buys is worth naming: if the app is killed mid-push, part
 * of a book is left on the drive and the next scan indexes it as a short book.
 * The import stays on the phone and unmarked, so nothing is lost.
 */
export async function copyImportToDrive(
  libraryRootUri: string,
  folderName: string,
  files: { relPath: string; name: string; sizeBytes: number }[],
  onProgress?: DrivePushProgress,
): Promise<
  | {
      ok: true;
      /** The new folder's path relative to the library root. */
      folderRelPath: string;
      /** The files as they now exist on the drive, in part order. */
      files: { uri: string; name: string; modifiedMs: number }[];
    }
  | { ok: false; message: string }
> {
  let target: Directory | null = null;
  let marker: File | null = null;
  let committed = false;

  try {
    const root = new Directory(libraryRootUri);
    if (!root.exists) return { ok: false, message: 'The drive is not reachable.' };

    // By display name: a folder directly inside a volume root reports its name
    // as `BC72-B058:Some Book`, which would match nothing and defeat the
    // collision check below.
    const entries = root.list();
    const byName = new Map(entries.map((e) => [safDisplayName(e.name), e]));

    /*
     * Never write over a folder that is already there — unless it is the
     * wreckage of a push that died, which is ours to clear.
     *
     * Without reclaiming it, a retry would take the next free number and the
     * part-written folder would stay on the drive for ever: the scan skips it,
     * so it is invisible from inside the app and only a computer could find it.
     */
    let finalName = folderName;
    for (let n = 2; byName.has(finalName); n += 1) {
      const existing = byName.get(finalName);
      if (existing instanceof Directory && isIncompleteFolder(existing)) {
        removeQuietly(existing);
        break;
      }
      finalName = `${folderName} (${n})`;
    }

    target = root.createDirectory(finalName);

    /*
     * The marker goes in before any audio does.
     *
     * From here until it is removed, a scan treats this folder as nothing at
     * all. That is the whole protection against the app being killed mid-copy:
     * every other exit from this function deletes the folder outright.
     */
    marker = target.createFile(INCOMPLETE_MARKER, 'text/plain');
    marker.write('Due Back is still writing this book. Safe to delete.');
    const totalBytes = files.reduce((n, f) => n + f.sizeBytes, 0);
    /** What the provider actually called each file, in part order. */
    const createdNames: string[] = [];
    let done = 0;

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const source = new File(Paths.document, file.relPath);
      if (!source.exists) return { ok: false, message: `${file.name} is missing from the phone.` };

      const base = done;
      onProgress?.({
        fileIndex: i,
        fileCount: files.length,
        name: file.name,
        bytesCopied: base,
        totalBytes,
      });

      // The provider may hand back a different display name than the one asked
      // for — a clash gets a suffix — so everything downstream uses the file it
      // returns rather than the name we wanted.
      const created = target.createFile(file.name, audioMimeFor(file.name));
      createdNames.push(safDisplayName(created.name));
      const written = await streamOntoDrive(source, created, (copied) =>
        onProgress?.({
          fileIndex: i,
          fileCount: files.length,
          name: file.name,
          bytesCopied: base + copied,
          totalBytes,
        }),
      );

      // Size is the only integrity check that is free, and the drive filling up
      // partway through is exactly what it catches.
      const landed = created.exists ? (created.size ?? written) : 0;
      if (file.sizeBytes > 0 && landed !== file.sizeBytes) {
        return {
          ok: false,
          message: `${file.name} copied incompletely — ${landed} of ${file.sizeBytes} bytes. Is the drive full?`,
        };
      }
      done = base + written;
    }

    /*
     * Read back what landed, by display name, in part order — not in the order
     * `list()` happens to return, which is the provider's business and would
     * scramble a multi-part book's timeline.
     */
    const landed = new Map(
      target
        .list()
        .filter((e): e is File => e instanceof File)
        .map((f) => [safDisplayName(f.name), f]),
    );
    const written: { uri: string; name: string; modifiedMs: number }[] = [];
    for (const name of createdNames) {
      const file = landed.get(name);
      if (!file) return { ok: false, message: `${name} did not reach the drive.` };
      written.push({ uri: file.uri, name, modifiedMs: file.modificationTime ?? 0 });
    }

    /*
     * The folder becomes a book the moment the marker goes, so it goes first —
     * before the listing above is turned into a result, and before anything
     * else can fail. Dying after this point leaves a complete, correct book.
     */
    removeQuietly(marker);
    marker = null;
    committed = true;
    return { ok: true, folderRelPath: safDisplayName(target.name), files: written };
  } catch (err) {
    const detail = (err as Error)?.message ?? '';
    console.warn('[dueback] copy to drive failed:', detail);
    if (/ENOSPC|No space left|EFBIG/i.test(detail)) {
      return { ok: false, message: 'The drive ran out of room. Nothing was copied.' };
    }
    if (/read-only|EROFS|EACCES|permission/i.test(detail)) {
      return { ok: false, message: 'The drive would not accept new files — it may be read-only.' };
    }
    return { ok: false, message: detail || 'The copy to the drive failed.' };
  } finally {
    // Anything that did not run to the end leaves nothing behind.
    if (target && !committed) removeQuietly(target);
  }
}
