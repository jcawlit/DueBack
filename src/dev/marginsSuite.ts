/**
 * The margins, against a real database.
 *
 * The arithmetic — where a bookmark lands, which chapter it belongs to,
 * reading tags back out of typed text — is covered by `tests/notes.test.ts`,
 * which runs in milliseconds and needs nothing at all. What only a device can
 * answer is whether the rows survive the round trip: soft deletes that stay
 * deleted and come back when asked, tags rewritten from the text, and a
 * character removed without taking the writing with it.
 */

import { check, equal, oneBookIn, type Suite } from './harness';
import { useNotes } from '@/store/notes';
import { countMarginsFor } from '@/db/notes';

const notes = () => useNotes.getState();

/** A name no earlier run can have used, so repeats do not collide. */
const unique = (stem: string) => `${stem} ${Date.now().toString(36)}`;

export const a12Margins: Suite = {
  id: 'A12',
  name: 'Notes, bookmarks and characters',
  cases: [
    {
      id: 'N-01',
      name: 'a bookmark is saved, read back, and is still a bookmark',
      async run() {
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);
        const made = await notes().addBookmark(book.id, 100, book.chapters);
        check(!!made, 'no bookmark was made');
        equal(made!.positionSec, 90, 'position, ten seconds back');
        equal(made!.text, '', 'a bookmark has no text');

        await notes().load(book.id);
        const back = notes().notes.find((n) => n.id === made!.id);
        check(!!back, 'the bookmark did not survive a reload');
        equal(back!.positionSec, 90, 'position after reload');
        return `saved at ${back!.positionSec}s`;
      },
    },
    {
      id: 'N-02',
      name: 'typing is saved, and survives a reload',
      async run() {
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);
        const made = await notes().addBookmark(book.id, 300, book.chapters);
        check(!!made, 'no note was made');

        notes().setNoteText(made!.id, 'the wolf at the door');
        await notes().flush();
        await notes().load(book.id);
        const back = notes().notes.find((n) => n.id === made!.id);
        equal(back?.text, 'the wolf at the door', 'text after reload');
        return 'text round-tripped';
      },
    },
    {
      id: 'N-03',
      name: 'a deleted note stays deleted, and undo brings it back',
      async run() {
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);

        const gone = await notes().addBookmark(book.id, 500, book.chapters);
        check(!!gone, 'no note was made');
        await notes().deleteNote(gone!.id);
        check(!notes().notes.some((n) => n.id === gone!.id), 'still listed after delete');
        await notes().load(book.id);
        check(!notes().notes.some((n) => n.id === gone!.id), 'came back after a reload');

        const kept = await notes().addBookmark(book.id, 520, book.chapters);
        check(!!kept, 'no second note was made');
        await notes().deleteNote(kept!.id);
        await notes().undoDelete();
        await notes().load(book.id);
        check(notes().notes.some((n) => n.id === kept!.id), 'undo did not restore the note');
        return 'deleted, and restored';
      },
    },
    {
      id: 'N-04',
      name: 'tagging writes the links, and deleting the mention removes them',
      async run() {
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);
        const who = await notes().addCharacter(book.id, unique('Ferro'));
        check(!!who, 'no character was made');
        const made = await notes().addBookmark(book.id, 700, book.chapters);
        check(!!made, 'no note was made');

        notes().setNoteText(made!.id, `a word from @${who!.name}`);
        await notes().flush();
        await notes().load(book.id);
        const tagged = notes().notes.find((n) => n.id === made!.id);
        check(tagged?.characterIds.includes(who!.id) === true, 'the tag was not saved');

        notes().setNoteText(made!.id, 'a word from nobody');
        await notes().flush();
        await notes().load(book.id);
        const untagged = notes().notes.find((n) => n.id === made!.id);
        equal(untagged?.characterIds.length, 0, 'the tag outlived the mention');
        return 'tagged, then untagged';
      },
    },
    {
      id: 'N-05',
      name: 'deleting a character keeps the notes about them',
      async run() {
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);
        const who = await notes().addCharacter(book.id, unique('Bayaz'));
        const made = await notes().addBookmark(book.id, 900, book.chapters);
        check(!!who && !!made, 'setup failed');

        const words = `@${who!.name} lies`;
        notes().setNoteText(made!.id, words);
        await notes().flush();

        await notes().deleteCharacter(who!.id);
        await notes().load(book.id);
        const kept = notes().notes.find((n) => n.id === made!.id);
        check(!!kept, 'the note went with the character');
        equal(kept!.text, words, 'the words were changed');
        equal(kept!.characterIds.length, 0, 'the tag outlived the character');
        check(!notes().characters.some((c) => c.id === who!.id), 'the character is still listed');
        return 'note kept, tag gone';
      },
    },
    {
      id: 'N-06',
      name: 'a bio is saved, and a note can be added to it',
      async run() {
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);
        const who = await notes().addCharacter(book.id, unique('Logen'));
        check(!!who, 'no character was made');

        await notes().updateCharacter(who!.id, {
          name: who!.name,
          aliases: 'Ninefingers',
          bio: 'A northman.',
        });
        await notes().addToBio(who!.id, 'Nine fingers.');
        await notes().load(book.id);
        const back = notes().characters.find((c) => c.id === who!.id);
        equal(back?.aliases, 'Ninefingers', 'aliases');
        equal(back?.bio, ['A northman.', '', 'Nine fingers.'].join('\n'), 'bio after adding');
        return 'bio round-tripped';
      },
    },
    {
      id: 'N-07',
      name: 'forgetting a book can tell how much writing it would take with it',
      async run() {
        const book = await oneBookIn('Natural Sort');
        await notes().load(book.id);
        const made = await notes().addBookmark(book.id, 1100, book.chapters);
        check(!!made, 'no note was made');
        notes().setNoteText(made!.id, 'something worth keeping');
        await notes().flush();

        const counts = await countMarginsFor([book.id]);
        check(counts.notes > 0, 'the warning would have said there was nothing to lose');
        const none = await countMarginsFor(['no-such-book']);
        equal(none.notes, 0, 'counted notes for a book with none');
        return `${counts.notes} notes, ${counts.characters} characters`;
      },
    },
  ],
};
