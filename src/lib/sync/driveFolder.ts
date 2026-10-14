/**
 * The app's own folder at the top of a library drive.
 *
 * Hidden, because it is the app's bookkeeping and not part of anyone's
 * library. It holds who this library is, and — once backup is on — the
 * generations of reading data written beside it.
 *
 * Everything here tolerates a drive that will not answer. A library whose
 * identity cannot be read is simply one we have no extra information about,
 * and that must never be the difference between a scan working and not.
 */

import { Directory, File } from 'expo-file-system';
import { asDirectoryUri } from '@/lib/files/access';
import { safDisplayName } from '@/lib/files/safNames';

export const DRIVE_FOLDER = '.dueback';
export const LIBRARY_FILE = 'library.json';

/** What a drive says about itself. */
export type DriveLibrary = {
  libraryId: string;
  /** When this file was first written, for the curious reading it on a computer. */
  createdAt: string;
};

/**
 * Finds a child by display name.
 *
 * SAF hands back document ids rather than names — `BC72-B058:.dueback` — so
 * nothing here can compare `entry.name` directly. `npm run kb saf names`.
 */
export function childByName<T extends Directory | File>(
  parent: Directory,
  name: string,
  kind: 'dir' | 'file',
): T | null {
  try {
    for (const entry of parent.list()) {
      if (safDisplayName(entry.name) !== name) continue;
      if (kind === 'dir' && entry instanceof Directory) return entry as T;
      if (kind === 'file' && entry instanceof File) return entry as T;
    }
  } catch {
    // An unreadable parent is the same as an absent child.
  }
  return null;
}

/** The app's folder on this drive, or null when it is not there. */
export function findDriveFolder(rootUri: string): Directory | null {
  try {
    const root = new Directory(asDirectoryUri(rootUri));
    if (!root.exists) return null;
    return childByName<Directory>(root, DRIVE_FOLDER, 'dir');
  } catch {
    return null;
  }
}

/** The app's folder on this drive, created if it is not there yet. */
export function ensureDriveFolder(rootUri: string): Directory | null {
  const existing = findDriveFolder(rootUri);
  if (existing) return existing;
  try {
    const root = new Directory(asDirectoryUri(rootUri));
    if (!root.exists) return null;
    return root.createDirectory(DRIVE_FOLDER);
  } catch {
    // A read-only drive, or a provider that will not have a dotted name.
    return null;
  }
}

function readJson<T>(file: File): T | null {
  try {
    if (!file.exists) return null;
    const text = file.textSync();
    return JSON.parse(text) as T;
  } catch {
    // Truncated, half-written, or not JSON at all. Treated as absent, which
    // is what every caller here wants: carry on without it.
    return null;
  }
}

/** Who this drive says it is, or null if it has never been asked. */
export function readDriveLibrary(rootUri: string): DriveLibrary | null {
  const folder = findDriveFolder(rootUri);
  if (!folder) return null;
  const file = childByName<File>(folder, LIBRARY_FILE, 'file');
  if (!file) return null;
  const parsed = readJson<DriveLibrary>(file);
  if (!parsed || typeof parsed.libraryId !== 'string' || parsed.libraryId.length === 0) {
    return null;
  }
  return parsed;
}

/**
 * Tells the drive who it is, if it does not already know.
 *
 * Never overwrites: a drive that already has an identity keeps it, and this
 * phone adopts it. Two phones that have each minted their own id for the same
 * drive would otherwise take turns renaming it, and every book on it would
 * change libraries on every scan.
 */
export function writeDriveLibrary(rootUri: string, libraryId: string): DriveLibrary | null {
  const existing = readDriveLibrary(rootUri);
  if (existing) return existing;
  const folder = ensureDriveFolder(rootUri);
  if (!folder) return null;
  const record: DriveLibrary = { libraryId, createdAt: new Date().toISOString() };
  try {
    const file = folder.createFile(LIBRARY_FILE, 'application/json');
    file.write(JSON.stringify(record, null, 2));
    return record;
  } catch {
    return null;
  }
}
