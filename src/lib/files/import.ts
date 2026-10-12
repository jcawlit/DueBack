/**
 * Adding a book that lives on the phone rather than on the library drive.
 *
 * The picked audio is copied into the app's own storage straight away. That is
 * not merely tidy: a file picked through the system picker carries a permission
 * that may not survive a restart, and the user can delete or move the original
 * at any time. Once copied, the book is ours to index, play and later push
 * across to the drive.
 */

import { Directory, File, Paths } from 'expo-file-system';
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

/**
 * Copies an imported book onto the library drive.
 *
 * Returns the new on-drive URIs so the book's parts can be re-pointed at the
 * drive, which is what makes it an ordinary library book from then on.
 */
export async function copyImportToDrive(
  libraryRootUri: string,
  folderName: string,
  files: { relPath: string; name: string; sizeBytes: number }[],
): Promise<{ ok: true; uris: string[] } | { ok: false; message: string }> {
  // Staged under a hidden sibling, then moved into place in one step.
  //
  // This used to write straight into the destination folder, so a copy that
  // failed halfway — the drive pulled out, the card full — left a folder of
  // half a book on the drive, indistinguishable from a real one to the next
  // scan. Copying onto the phone has always staged and then moved; the drive
  // is the user's own library and deserves the same care, more so because
  // nothing else holds a copy of what is written there.
  //
  // The staging folder is named with the book's folder name so two imports
  // running back to back cannot collide, and it is swept away on every exit
  // path, including the failures.
  let staging: Directory | null = null;

  try {
    const root = new Directory(libraryRootUri);
    if (!root.exists) return { ok: false, message: 'The drive is not reachable.' };

    const entries = root.list();
    const taken = new Set(entries.map((e) => e.name));

    // Never write over a folder that is already there. A name that is taken
    // gets a numbered suffix, the way a desktop would do it, because the
    // existing folder may be a different book that happens to share a name —
    // or this same book, in which case the user still has the original.
    let finalName = folderName;
    for (let n = 2; taken.has(finalName); n += 1) {
      finalName = `${folderName} (${n})`;
    }

    const stagingName = `.dueback-tmp-${finalName}`;
    const leftover = entries.find(
      (e): e is Directory => e instanceof Directory && e.name === stagingName,
    );
    if (leftover) removeQuietly(leftover);

    staging = root.createDirectory(stagingName);

    for (const file of files) {
      const source = new File(Paths.document, file.relPath);
      if (!source.exists) return { ok: false, message: `${file.name} is missing from the phone.` };
      // Constructed, not created. `createFile` makes a zero-byte file and
      // `copy` then refuses to write over it — the copy onto the phone has
      // always built its destination this way, and this path had quietly kept
      // the older pattern. Nothing covered it, so nothing caught it.
      const created = new File(staging, file.name);
      await source.copy(created);
      const written = created.exists ? (created.size ?? 0) : 0;
      if (file.sizeBytes > 0 && written !== file.sizeBytes) {
        return { ok: false, message: `${file.name} copied incompletely to the drive.` };
      }
    }

    // Everything landed and verified: now it becomes a book on the drive.
    const target = new Directory(root, finalName);
    staging.move(target);
    // Nothing is swept up after the move. `move` updates the instance it was
    // called on to point at the new location, so deleting "the staging folder"
    // afterwards deletes the book that was just put in place — which is
    // exactly what happened here until a test caught it. Anything a failed run
    // does leave behind is named `.dueback-tmp-…` and is cleared by the next
    // attempt at the same book.
    staging = null;

    const uris = target
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => f.uri);

    return { ok: true, uris };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? 'The copy to the drive failed.' };
  } finally {
    // Any path that did not complete the move leaves nothing behind.
    if (staging) removeQuietly(staging);
  }
}
