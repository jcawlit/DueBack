/**
 * The drive backup, against a real folder and a real database.
 *
 * The merge rules and the validation are covered by `tests/sync.test.ts`,
 * which needs nothing. What only a device can answer is whether a generation
 * actually lands on a drive, reads back, and brings someone's writing home
 * after it has been wiped — and whether a damaged newest generation really
 * does fall back to the one before it rather than taking the library with it.
 */

import { Directory, File } from 'expo-file-system';
import { check, equal, library, oneBookIn, type Suite } from './harness';
import { getDb, ensureDeviceId, ensureLibraryId } from '@/db/schema';
import { applyPayload, collectPayload } from '@/db/sync';
import { useNotes } from '@/store/notes';
import { readDrive, syncToDrive } from '@/lib/sync/driveSync';
import { DRIVE_FOLDER, childByName } from '@/lib/sync/driveFolder';
import { MANIFEST_FILE, folderNameFor } from '@/lib/sync/generations';
import { mergePayloads } from '@/lib/sync/records';
import { asDirectoryUri } from '@/lib/files/access';

const notes = () => useNotes.getState();

function rootOf(ctx: { rootPath: string }) {
  return `file://${ctx.rootPath}`;
}

function driveFolderOf(ctx: { rootPath: string }): Directory | null {
  const root = new Directory(asDirectoryUri(rootOf(ctx)));
  return childByName<Directory>(root, DRIVE_FOLDER, 'dir');
}

/** One backup round, as the app runs it after a scan. */
async function runSync(ctx: { rootPath: string }) {
  const [device, libraryId, mine] = await Promise.all([
    ensureDeviceId(),
    ensureLibraryId(),
    collectPayload(),
  ]);
  return syncToDrive(rootOf(ctx), libraryId, device, mine);
}

export const a14Backup: Suite = {
  id: 'A14',
  name: 'Backing reading data up to the drive',
  cases: [
    {
      id: 'BK-01',
      name: 'a backup lands on the drive and reads back whole',
      async run(ctx) {
        await library().setLibraryRoot({ uri: rootOf(ctx), name: 'fixtures' });
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);
        const made = await notes().addBookmark(book.id, 300, book.chapters);
        check(!!made, 'no note was made');
        notes().setNoteText(made!.id, 'kept on the drive');
        await notes().flush();

        const outcome = await runSync(ctx);
        check(outcome.ok, `the backup failed: ${outcome.message}`);

        const folder = driveFolderOf(ctx);
        check(!!folder, 'no .dueback folder was made');
        const generation = childByName<Directory>(
          folder!,
          folderNameFor(outcome.generation!),
          'dir',
        );
        check(!!generation, 'the generation folder is not there');
        check(
          !!childByName<File>(generation!, MANIFEST_FILE, 'file'),
          'the generation has no manifest',
        );

        const libraryId = await ensureLibraryId();
        const read = readDrive(rootOf(ctx), libraryId);
        check(!!read.payload, 'the backup did not validate when read back');
        check(
          read.payload!.notes.some((n) => n.id === made!.id),
          'the note is not in the backup',
        );
        return `generation ${outcome.generation}, ${read.payload!.notes.length} notes`;
      },
    },
    {
      id: 'BK-02',
      name: 'wiping the phone’s notes and syncing brings them back',
      async run(ctx) {
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);
        const made = await notes().addBookmark(book.id, 900, book.chapters);
        check(!!made, 'no note was made');
        notes().setNoteText(made!.id, 'written before the wipe');
        await notes().flush();
        check((await runSync(ctx)).ok, 'the backup failed');

        // Gone from the phone entirely — not soft-deleted, which would be a
        // tombstone the merge would rightly honour.
        const db = await getDb();
        await db.runAsync('DELETE FROM notes WHERE id = ?', made!.id);
        await notes().load(book.id);
        check(!notes().notes.some((n) => n.id === made!.id), 'the note was not really wiped');

        const libraryId = await ensureLibraryId();
        const fromDrive = readDrive(rootOf(ctx), libraryId);
        check(!!fromDrive.payload, 'the drive copy did not validate');
        await applyPayload(mergePayloads(await collectPayload(), fromDrive.payload!));

        await notes().load(book.id);
        const back = notes().notes.find((n) => n.id === made!.id);
        equal(back?.text, 'written before the wipe', 'the note did not come back');
        return 'restored from the drive';
      },
    },
    {
      id: 'BK-03',
      name: 'a damaged newest generation falls back to the one before',
      async run(ctx) {
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);
        const made = await notes().addBookmark(book.id, 1500, book.chapters);
        notes().setNoteText(made!.id, 'in the good generation');
        await notes().flush();

        const good = await runSync(ctx);
        check(good.ok, 'the first backup failed');
        const next = await runSync(ctx);
        check(next.ok, 'the second backup failed');

        // Truncate the newest manifest, exactly as a pulled cable would.
        const folder = driveFolderOf(ctx);
        const newest = childByName<Directory>(folder!, folderNameFor(next.generation!), 'dir');
        check(!!newest, 'the newest generation is missing');
        const manifest = childByName<File>(newest!, MANIFEST_FILE, 'file');
        check(!!manifest, 'the newest generation has no manifest');
        manifest!.write('{"schemaVersion":1,"partial');

        const libraryId = await ensureLibraryId();
        const read = readDrive(rootOf(ctx), libraryId);
        check(!!read.payload, 'nothing validated, so the fallback did not happen');
        check(
          read.generation < next.generation!,
          `read generation ${read.generation}, which is the damaged one`,
        );
        check(
          read.payload!.notes.some((n) => n.id === made!.id),
          'the fallback generation is missing the note',
        );
        return `fell back to generation ${read.generation}`;
      },
    },
    {
      id: 'BK-04',
      name: 'a generation written by a newer app is never overwritten',
      async run(ctx) {
        const libraryId = await ensureLibraryId();
        const before = readDrive(rootOf(ctx), libraryId);
        const folder = driveFolderOf(ctx);
        check(!!folder, 'no .dueback folder');

        // A generation far in the future, claiming a schema we do not know.
        const futureNumber = Math.max(0, ...before.all) + 50;
        const future = folder!.createDirectory(folderNameFor(futureNumber));
        const manifest = future.createFile(MANIFEST_FILE, 'application/json');
        const body = JSON.stringify({
          schemaVersion: 99,
          libraryId,
          generation: futureNumber,
          checksum: 'x',
          writtenAt: new Date().toISOString(),
          writerDevice: 'a-newer-phone',
          parts: [],
        });
        manifest.write(body);

        try {
          const read = readDrive(rootOf(ctx), libraryId);
          check(read.newerSchema, 'the newer generation was not noticed');

          const outcome = await runSync(ctx);
          check(outcome.ok, `the backup failed: ${outcome.message}`);
          check(
            outcome.generation! > futureNumber,
            `wrote generation ${outcome.generation}, at or below the newer one`,
          );
          check(future.exists, 'the newer generation was deleted');
          equal(manifest.textSync(), body, "the newer app's manifest was rewritten");
          return `left generation ${futureNumber} alone`;
        } finally {
          try {
            future.delete();
          } catch {
            // Left behind; harmless, and never used.
          }
        }
      },
    },
    {
      id: 'BK-05',
      name: 'syncing twice over does not pile up generations',
      async run(ctx) {
        await runSync(ctx);
        await runSync(ctx);
        await runSync(ctx);
        const libraryId = await ensureLibraryId();
        const read = readDrive(rootOf(ctx), libraryId);
        check(
          read.all.length <= 3,
          `${read.all.length} generations are on the drive: ${read.all.join(', ')}`,
        );
        check(read.validated.length >= 1, 'no generation validates');
        return `${read.all.length} kept`;
      },
    },
  ],
};
