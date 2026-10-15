import { getSetting, setSetting, adoptLibraryId, ensureDeviceId } from '@/db/schema';
import { newUuid } from '@/lib/library/ids';
import { readDriveLibrary } from './driveFolder';
import { recoverDriveLibraryId, syncToDrive } from './driveSync';
import { emptyPayload } from './records';

/**
 * Which library this root is.
 *
 * The drive's own answer wins. A drive carries its identity in `.dueback`, so
 * the same stick reached through a different mount — or picked again after
 * the app forgot it — is still the same library, and its books keep their
 * uuids. A drive that has never been asked is told, once; a drive that cannot
 * be written to simply keeps whatever this phone already had.
 */
export async function resolveLibraryId(rootUri: string): Promise<string> {
  const key = `library.rootIdentity.${rootUri}`;
  const recovered = recoverDriveLibraryId(rootUri);
  const onDrive = recovered ?? readDriveLibrary(rootUri)?.libraryId;
  const mine = onDrive ?? await getSetting(key) ?? newUuid();
  await setSetting(key, mine);
  await adoptLibraryId(mine);
  // Establish identity in a complete generation before scanning new books.
  // Read-only libraries retain the per-root local mapping until they can be backed up.
  if (!recovered) await syncToDrive(rootUri, mine, await ensureDeviceId(), emptyPayload());
  return mine;
}
