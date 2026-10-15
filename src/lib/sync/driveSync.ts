/**
 * Reading and writing the backup on the drive.
 *
 * The order is always the same and it matters: **read and merge first, then
 * write.** A phone that has been away writes what it learned on top of what
 * it brought, never instead of it, so plugging in a drive can only ever add
 * to what is on it.
 *
 * Writing is a whole new generation, read back and validated in full before
 * anything older is touched. Everything that can go wrong — the drive pulled
 * out, the app killed, a file truncated — leaves the previous generation
 * exactly as it was, and a half-written new one is simply never trusted.
 */

import { Directory, File } from 'expo-file-system';
import {
  MANIFEST_FILE,
  PART_FILES,
  buildGeneration,
  folderNameFor,
  generationOf,
  prunable,
  validateGeneration,
  type Manifest,
  type PartFile,
  type PartName,
} from './generations';
import { mergePayloads, type SyncPayload } from './records';
import { childByName, ensureDriveFolder, findDriveFolder } from './driveFolder';
import { safDisplayName } from '@/lib/files/safNames';

export type SyncOutcome = {
  ok: boolean;
  /** The generation now on the drive, when one was written. */
  generation?: number;
  /** What came back off the drive and was merged in. */
  merged?: SyncPayload;
  /** Set when the drive holds something this app must not touch. */
  needsNewerApp?: boolean;
  message: string;
};

function readJsonFile<T>(file: File): T | null {
  try {
    if (!file.exists) return null;
    return JSON.parse(file.textSync()) as T;
  } catch {
    // Truncated, half-written, or not JSON. Indistinguishable from absent,
    // and treated the same: this generation does not validate.
    return null;
  }
}

/** The generation folders on the drive, newest first. */
function generationFolders(driveFolder: Directory): { n: number; dir: Directory }[] {
  const found: { n: number; dir: Directory }[] = [];
  try {
    for (const entry of driveFolder.list()) {
      if (!(entry instanceof Directory)) continue;
      const n = generationOf(safDisplayName(entry.name));
      if (n !== null) found.push({ n, dir: entry });
    }
  } catch {
    // An unreadable folder is an empty one for these purposes.
  }
  return found.sort((a, b) => b.n - a.n);
}

function readGeneration(dir: Directory, libraryId: string) {
  const manifestFile = childByName<File>(dir, MANIFEST_FILE, 'file');
  const manifest = manifestFile ? readJsonFile<Manifest>(manifestFile) : null;
  const parts: Partial<Record<PartName, PartFile | null>> = {};
  for (const part of PART_FILES) {
    const file = childByName<File>(dir, `${part}.json`, 'file');
    parts[part] = file ? readJsonFile<PartFile>(file) : null;
  }
  return validateGeneration(libraryId, manifest, parts);
}

export type DriveRead = {
  /** The newest generation that validated, if any. */
  payload: SyncPayload | null;
  /** The generation it came from. */
  generation: number;
  /** Every generation folder present, validated or not. */
  all: number[];
  /** Those that validated, newest first. */
  validated: number[];
  /** True when something on the drive was written by a newer app. */
  newerSchema: boolean;
  /** Why the newest generation was not used, when it was not. */
  skipped: string[];
};

/**
 * Reads the newest generation that validates completely.
 *
 * Walking back through older ones is the point of keeping them: a latest
 * generation damaged by a pulled cable costs the writing done since the one
 * before it, and nothing else.
 */
export function readDrive(rootUri: string, libraryId: string): DriveRead {
  const result: DriveRead = {
    payload: null,
    generation: 0,
    all: [],
    validated: [],
    newerSchema: false,
    skipped: [],
  };

  const folder = findDriveFolder(rootUri);
  if (!folder) return result;

  const folders = generationFolders(folder);
  result.all = folders.map((f) => f.n);

  for (const { n, dir } of folders) {
    let validation;
    try { validation = readGeneration(dir, libraryId); } catch {
      result.skipped.push(`gen-${n}: malformed generation`);
      continue;
    }
    if (validation.ok) {
      result.validated.push(n);
      if (!result.payload) {
        result.payload = validation.payload;
        result.generation = n;
      }
      // Keep walking: `prunable` needs to know how many are known good.
      continue;
    }
    if (validation.reason === 'newer-schema') {
      result.newerSchema = true;
      // Not merely skipped — never written over either. `nextGeneration`
      // counts from the highest folder present, so a newer app's work is
      // left where it is.
    }
    result.skipped.push(`gen-${n}: ${validation.detail}`);
  }

  return result;
}

/**
 * Writes a generation, then proves it.
 *
 * The new folder is only ever a *new* number, so nothing already on the drive
 * is modified at any point. If the read-back fails, the half-written folder
 * is left alone rather than deleted: the next write takes the number after
 * it, and a folder that does not validate is never used for anything.
 */
function writeGeneration(
  driveFolder: Directory,
  payload: SyncPayload,
  options: { libraryId: string; generation: number; writerDevice: string },
): { ok: boolean; message: string } {
  const { manifest, parts } = buildGeneration(payload, options);
  let dir: Directory;
  try {
    dir = driveFolder.createDirectory(folderNameFor(options.generation));
  } catch (err) {
    return { ok: false, message: `could not make room on the drive: ${describe(err)}` };
  }

  try {
    for (const part of parts) {
      const file = dir.createFile(`${part.part}.json`, 'application/json');
      file.write(JSON.stringify(part));
    }
    /*
     * The manifest goes last. Until it is there the generation cannot
     * validate, which is exactly what should happen to a folder whose data
     * files are still arriving — so an interrupted write is indistinguishable
     * from one that never began.
     */
    const manifestFile = dir.createFile(MANIFEST_FILE, 'application/json');
    manifestFile.write(JSON.stringify(manifest));
  } catch (err) {
    return { ok: false, message: `the backup could not be written: ${describe(err)}` };
  }

  // Read the whole thing back off the drive, not out of memory.
  const check = readGeneration(dir, options.libraryId);
  if (!check.ok) {
    return { ok: false, message: `the backup did not read back correctly: ${check.detail}` };
  }
  return { ok: true, message: 'written' };
}

function describe(err: unknown): string {
  return (err as Error)?.message ?? 'unknown error';
}

function removeQuietly(dir: Directory) {
  try {
    dir.delete();
  } catch {
    // An old generation that will not go is harmless; it is simply not used.
  }
}

/**
 * One round of backup: read what is there, merge, write, validate, prune.
 *
 * `mine` is this phone's whole set. The merged result is handed back so the
 * caller can write it into the database — the drive and the phone end up
 * holding the same thing, which is what makes the next merge a no-op.
 */
export async function syncToDrive(
  rootUri: string,
  libraryId: string,
  writerDevice: string,
  mine: SyncPayload,
): Promise<SyncOutcome & { read: DriveRead }> {
  const read = readDrive(rootUri, libraryId);
  const merged = read.payload ? mergePayloads(mine, read.payload) : mine;

  if (read.newerSchema) {
    return { ok: false, read, merged, needsNewerApp: true,
      message: 'Update the app before writing to this drive backup.' };
  }

  if (read.all.length && !read.payload) {
    return { ok: false, read, message: 'No complete backup could be read; existing generations were left untouched.' };
  }
  const folder = ensureDriveFolder(rootUri);
  if (!folder) {
    return {
      ok: false,
      merged,
      read,
      needsNewerApp: read.newerSchema,
      message: 'The drive would not let the app make its folder.',
    };
  }

  /*
   * Counted from every folder present, not from the newest that validated.
   * A generation written by a newer version of the app, or one left
   * half-written by an interrupted run, must not have its number reused.
   */
  const highest = read.all.length > 0 ? Math.max(...read.all) : 0;
  const generation = highest + 1;

  const written = writeGeneration(folder, merged, { libraryId, generation, writerDevice });
  if (!written.ok) {
    return { ok: false, merged, read, needsNewerApp: read.newerSchema, message: written.message };
  }

  /*
   * Only now. Everything older goes once a newer complete generation has been
   * read back and validated, and never before — and `prunable` keeps the last
   * two good ones, so a damaged write still has somewhere to fall back to.
   */
  const validated = [generation, ...read.validated];
  const remove = prunable([...read.all, generation], validated);
  for (const n of remove) {
    const dir = childByName<Directory>(folder, folderNameFor(n), 'dir');
    if (dir) removeQuietly(dir);
  }

  return {
    ok: true,
    generation,
    merged,
    read,
    needsNewerApp: read.newerSchema,
    message: `Backed up to the drive (generation ${generation}).`,
  };
}

/** Recover the bootstrap identity from a complete generation, not a single marker. */
export function recoverDriveLibraryId(rootUri: string): string | null {
  const folder = findDriveFolder(rootUri);
  if (!folder) return null;
  const folders = generationFolders(folder);
  const ids = new Set<string>();
  for (const { dir } of folders) {
    const file = childByName<File>(dir, MANIFEST_FILE, 'file');
    const manifest = file ? readJsonFile<Manifest>(file) : null;
    if (!manifest || typeof manifest.libraryId !== 'string') continue;
    try {
      const result = readGeneration(dir, manifest.libraryId);
      if (result.ok || result.reason === 'newer-schema') ids.add(manifest.libraryId);
    } catch { /* A malformed generation cannot establish identity. */ }
  }
  if (ids.size > 1) throw new Error('The drive contains conflicting library identities. Choose the correct backup before scanning.');
  if (ids.size === 1) return [...ids][0];
  if (folders.length) throw new Error('No complete drive backup could establish this library?s identity. Restore a valid generation before scanning.');
  return null;
}
