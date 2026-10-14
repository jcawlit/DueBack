/**
 * Book identity, against a real database and a real folder.
 *
 * The decisions — what counts as a candidate, when to ask rather than decide —
 * are covered by `tests/identity.test.ts`, which needs nothing. What only a
 * device can answer is whether a book that moves keeps everything hanging off
 * its id: its place in the audio, its library-card history, and the notes and
 * characters someone wrote about it.
 */

import { Directory } from 'expo-file-system';
import {
  check,
  ensureScan,
  equal,
  oneBookIn,
  parkFolder,
  type Suite,
} from './harness';
import { loadDevBooks } from '@/db/books';
import { ensureLibraryId, loadPathKeyIndex, reconnectBook } from '@/db/identity';
import { useNotes } from '@/store/notes';
import { getDb } from '@/db/schema';

const notes = () => useNotes.getState();

/** Reads a book's row straight from the database, past any store caching. */
async function row(id: string) {
  const db = await getDb();
  return db.getFirstAsync<{
    id: string;
    progress_sec: number;
    path_key: string | null;
    part_sizes: string | null;
    sample_hash: string | null;
    folder_rel_path: string;
  }>(
    `SELECT id, progress_sec, path_key, part_sizes, sample_hash, folder_rel_path
       FROM books WHERE id = ?`,
    id,
  );
}

export const a13Identity: Suite = {
  id: 'A13',
  name: 'Book identity across a move',
  cases: [
    {
      id: 'ID-01',
      name: 'every book has a uuid and a path key, and they are not the same',
      async run() {
        const all = await loadDevBooks();
        check(all.length > 0, 'no books to check');
        const index = await loadPathKeyIndex(await ensureLibraryId());
        check(index.size > 0, 'no book recorded where it was found');

        for (const book of all.slice(0, 20)) {
          const saved = await row(book.id);
          check(!!saved, `${book.title} has no row`);
          check(!!saved!.path_key, `${book.title} has no path key`);
          check(saved!.path_key !== saved!.id, `${book.title} is still identified by its path`);
        }
        return `${all.length} books, ${index.size} path keys`;
      },
    },
    {
      id: 'ID-02',
      name: 'a scan records the shape and a content sample',
      async run() {
        const book = await oneBookIn('Natural Sort');
        const saved = await row(book.id);
        check(!!saved?.part_sizes, 'no part sizes recorded');
        const sizes = JSON.parse(saved!.part_sizes!);
        check(Array.isArray(sizes) && sizes.length > 0, 'part sizes are empty');
        check(!!saved!.sample_hash, 'no content sample recorded');
        return `${sizes.length} parts, sample ${saved!.sample_hash!.slice(0, 8)}`;
      },
    },
    {
      id: 'ID-03',
      name: 'the same scan twice keeps the same uuid',
      async run() {
        const before = await oneBookIn('Natural Sort');
        await ensureScan({ force: true });
        const after = await oneBookIn('Natural Sort');
        equal(after.id, before.id, 'the book was given a new identity by a rescan');
        return `kept ${before.id.slice(0, 8)}`;
      },
    },
    {
      id: 'ID-04',
      name: 'a renamed folder keeps its place, history and notes',
      async run(ctx) {
        const book = await oneBookIn('Natural Sort');
        const originalId = book.id;

        // Something to lose: a position, and a note.
        const db = await getDb();
        await db.runAsync('UPDATE books SET progress_sec = ? WHERE id = ?', 1234, originalId);
        await notes().load(originalId);
        const made = await notes().addBookmark(originalId, 600, book.chapters);
        check(!!made, 'no note was made');
        notes().setNoteText(made!.id, 'written before the move');
        await notes().flush();

        const parked = parkFolder(ctx.rootPath, 'Natural Sort');
        check(await parked.park(), 'could not move the folder aside');
        try {
          // Put it back under a different name, which is what a rename looks
          // like to a scan: one folder gone, one folder new.
          const from = new Directory(`${ctx.rootPath}/../Natural Sort.parked`);
          check(from.exists, 'the parked folder is not where it was expected');
          await from.move(new Directory(`${ctx.rootPath}/Natural Sort Renamed`));

          await ensureScan({ force: true });

          const after = await row(originalId);
          check(!!after, 'the book lost its identity in the rename');
          equal(after!.progress_sec, 1234, 'the listening position');
          check(
            after!.folder_rel_path.includes('Renamed'),
            `the row still points at ${after!.folder_rel_path}`,
          );

          await notes().load(originalId);
          const note = notes().notes.find((n) => n.id === made!.id);
          equal(note?.text, 'written before the move', 'the note did not survive the rename');
          return 'place and notes kept';
        } finally {
          const renamed = new Directory(`${ctx.rootPath}/Natural Sort Renamed`);
          if (renamed.exists) {
            await renamed.move(new Directory(`${ctx.rootPath}/Natural Sort`));
          }
          await ensureScan({ force: true });
        }
      },
    },
    {
      id: 'ID-05',
      name: 'reconnecting moves the audio and keeps everything written',
      async run() {
        const keep = await oneBookIn('Natural Sort');
        const found = await oneBookIn('Embedded Only');
        check(keep.id !== found.id, 'needs two different books');

        const db = await getDb();
        await db.runAsync('UPDATE books SET progress_sec = ? WHERE id = ?', 777, keep.id);
        await notes().load(keep.id);
        const made = await notes().addBookmark(keep.id, 60, keep.chapters);
        check(!!made, 'no note was made');

        const foundFolder = found.sourceRelPath;
        await reconnectBook(found.id, keep.id);

        const joined = await row(keep.id);
        check(!!joined, 'the kept identity disappeared');
        equal(joined!.progress_sec, 777, 'the position was lost');
        equal(joined!.folder_rel_path, foundFolder, 'the audio did not move across');
        check(!(await row(found.id)), 'the found row was left behind');

        await notes().load(keep.id);
        check(
          notes().notes.some((n) => n.id === made!.id),
          'the note did not stay with the identity',
        );

        // Put the library back the way it was found.
        await ensureScan({ force: true });
        return 'identity kept, audio moved';
      },
    },
  ],
};
