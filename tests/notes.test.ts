/**
 * The margins: bookmarks, notes, the people they are about, and the page of
 * writing a listener can take away with them.
 *
 * Everything here is the pure half — the arithmetic of where a bookmark lands
 * and which chapter it belongs to, reading tags back out of typed text, and
 * the autosave that decides when writing reaches the database. The SQLite
 * round trip is covered on a device, in `src/dev/suites.ts`, because that is
 * the only place a real database exists.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bioWith,
  bookmarkPositionFor,
  chapterIndexFor,
  charactersByFirstHeard,
  firstHeardSec,
  groupNotesByChapter,
  isBookmark,
  noteCountFor,
  notesForCharacter,
  type Character,
  type Note,
} from '../src/data/notes.ts';
import {
  insertMention,
  mentionQueryAt,
  mentionedCharacterIds,
  namesFor,
  suggestCharacters,
} from '../src/lib/notes/mentions.ts';
import { exportNotes } from '../src/lib/notes/export.ts';
import { createAutosave } from '../src/lib/notes/autosave.ts';

const CHAPTERS = [
  { title: 'One', startSec: 0 },
  { title: 'Two', startSec: 600 },
  { title: 'Three', startSec: 1200 },
];

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    bookId: 'b1',
    positionSec: 0,
    chapterIndex: 0,
    text: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    characterIds: [],
    ...over,
  };
}

function character(over: Partial<Character> = {}): Character {
  return {
    id: 'c1',
    bookId: 'b1',
    name: 'Logen',
    aliases: '',
    bio: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('a bookmark is a note with nothing in it', () => {
  it('counts empty and blank text as a bookmark', () => {
    assert.equal(isBookmark({ text: '' }), true);
    assert.equal(isBookmark({ text: '   \n ' }), true);
  });

  it('stops being one the moment something is written', () => {
    assert.equal(isBookmark({ text: 'the wolf' }), false);
  });
});

describe('where a bookmark lands', () => {
  it('goes back ten seconds, because the moment has already passed', () => {
    assert.equal(bookmarkPositionFor(100), 90);
  });

  it('clamps at the start of the book rather than going negative', () => {
    assert.equal(bookmarkPositionFor(4), 0);
    assert.equal(bookmarkPositionFor(0), 0);
    assert.equal(bookmarkPositionFor(10), 0);
  });
});

describe('which chapter a note belongs to', () => {
  it('is the chapter the adjusted position falls in', () => {
    assert.equal(chapterIndexFor(CHAPTERS, 0), 0);
    assert.equal(chapterIndexFor(CHAPTERS, 599), 0);
    assert.equal(chapterIndexFor(CHAPTERS, 600), 1);
    assert.equal(chapterIndexFor(CHAPTERS, 5000), 2);
  });

  it('is derived at a boundary from where the bookmark lands, not the tap', () => {
    /*
     * Tapping five seconds into chapter two marks something said at the end of
     * chapter one. Filing it under chapter two would put it in the wrong place
     * in the margins and break the grouping.
     */
    const tappedAt = 605;
    const landed = bookmarkPositionFor(tappedAt);
    assert.equal(chapterIndexFor(CHAPTERS, tappedAt), 1);
    assert.equal(landed, 595);
    assert.equal(chapterIndexFor(CHAPTERS, landed), 0);
  });

  it('is chapter zero for a book with no chapter marks', () => {
    assert.equal(chapterIndexFor([], 9999), 0);
  });
});

describe('tagging people with @', () => {
  const cast = [
    character({ id: 'c1', name: 'Logen' }),
    character({ id: 'c2', name: 'Logen Ninefingers' }),
    character({ id: 'c3', name: 'Ferro', aliases: 'Maljinn, The Ghost' }),
  ];

  it('collects every name a character answers to', () => {
    assert.deepEqual(namesFor(cast[2]), ['Ferro', 'Maljinn', 'The Ghost']);
  });

  it('finds the mention being typed at the cursor', () => {
    const text = 'the duel with @Fer';
    assert.deepEqual(mentionQueryAt(text, text.length), { start: 14, query: 'Fer' });
  });

  it('ignores an @ in the middle of a word, so email is not a tag', () => {
    const text = 'write to me@example.com';
    assert.equal(mentionQueryAt(text, text.length), null);
  });

  it('offers names that start with what was typed first', () => {
    const names = suggestCharacters('log', cast).map((c) => c.name);
    assert.deepEqual(names, ['Logen', 'Logen Ninefingers']);
  });

  it('matches an alias as readily as a name', () => {
    assert.deepEqual(suggestCharacters('ghost', cast).map((c) => c.id), ['c3']);
  });

  it('replaces the partial with the whole name and a space', () => {
    const typed = 'the duel with @Fer';
    const result = insertMention(typed, typed.length, 'Ferro');
    assert.equal(result.text, 'the duel with @Ferro ');
    assert.equal(result.cursor, result.text.length);
  });

  it('keeps what follows the cursor when a mention is completed', () => {
    const typed = 'the duel with @Fer was long';
    const result = insertMention(typed, 18, 'Ferro');
    assert.equal(result.text, 'the duel with @Ferro  was long');
  });

  it('reads the tags back out of the text', () => {
    const ids = mentionedCharacterIds('@Ferro fought @Logen here', cast);
    assert.deepEqual(ids.sort(), ['c1', 'c3']);
  });

  it('prefers the longest matching name', () => {
    assert.deepEqual(mentionedCharacterIds('@Logen Ninefingers speaks', cast), ['c2']);
  });

  it('does not match a name that is only the start of the word written', () => {
    assert.deepEqual(mentionedCharacterIds('@Ferrous metal', cast), []);
  });

  it('matches an alias, and folds case for dictation', () => {
    assert.deepEqual(mentionedCharacterIds('@maljinn again', cast), ['c3']);
  });

  it('loses the tag when the mention is deleted from the text', () => {
    const before = mentionedCharacterIds('@Ferro and @Logen', cast);
    assert.deepEqual(before.sort(), ['c1', 'c3']);
    const after = mentionedCharacterIds('and @Logen', cast);
    assert.deepEqual(after, ['c1']);
  });
});

describe('first heard', () => {
  const cast = [character({ id: 'c1', name: 'Logen' }), character({ id: 'c2', name: 'Ferro' })];

  it('is the earliest note tagging them', () => {
    const notes = [
      note({ id: 'n1', positionSec: 900, characterIds: ['c1'] }),
      note({ id: 'n2', positionSec: 300, characterIds: ['c1'] }),
    ];
    assert.equal(firstHeardSec('c1', notes), 300);
  });

  it('is nothing at all for a character nobody has written about', () => {
    assert.equal(firstHeardSec('c2', [note({ characterIds: ['c1'] })]), null);
  });

  it('moves earlier when a note is taken further back', () => {
    const notes = [note({ id: 'n1', positionSec: 900, characterIds: ['c1'] })];
    assert.equal(firstHeardSec('c1', notes), 900);
    notes.push(note({ id: 'n2', positionSec: 120, characterIds: ['c1'] }));
    assert.equal(firstHeardSec('c1', notes), 120);
  });

  it('orders the index by it, with the unheard last', () => {
    const notes = [
      note({ id: 'n1', positionSec: 800, characterIds: ['c1'] }),
      note({ id: 'n2', positionSec: 100, characterIds: ['c2'] }),
    ];
    const unknown = character({ id: 'c3', name: 'Bayaz' });
    const order = charactersByFirstHeard([...cast, unknown], notes).map((c) => c.id);
    assert.deepEqual(order, ['c2', 'c1', 'c3']);
  });

  it('counts the notes about someone', () => {
    const notes = [
      note({ id: 'n1', characterIds: ['c1'] }),
      note({ id: 'n2', characterIds: ['c1', 'c2'] }),
    ];
    assert.equal(noteCountFor('c1', notes), 2);
    assert.equal(noteCountFor('c2', notes), 1);
  });

  it('lists a character’s notes in story order', () => {
    const notes = [
      note({ id: 'late', positionSec: 900, characterIds: ['c1'] }),
      note({ id: 'early', positionSec: 10, characterIds: ['c1'] }),
      note({ id: 'other', positionSec: 50, characterIds: ['c2'] }),
    ];
    assert.deepEqual(notesForCharacter('c1', notes).map((n) => n.id), ['early', 'late']);
  });
});

describe('grouping the margins by chapter', () => {
  it('gathers notes under their chapter, in story order', () => {
    const notes = [
      note({ id: 'b', positionSec: 700, chapterIndex: 1 }),
      note({ id: 'a', positionSec: 100, chapterIndex: 0 }),
      note({ id: 'c', positionSec: 650, chapterIndex: 1 }),
    ];
    const groups = groupNotesByChapter(notes, CHAPTERS, 'A Book');
    assert.deepEqual(groups.map((g) => g.title), ['One', 'Two']);
    assert.deepEqual(groups[1].notes.map((n) => n.id), ['c', 'b']);
  });

  it('falls back to the book’s title when there are no chapters', () => {
    const groups = groupNotesByChapter([note()], [], 'A Book');
    assert.equal(groups[0].title, 'A Book');
  });
});

describe('adding a note to a bio', () => {
  it('starts the bio when there is none', () => {
    assert.equal(bioWith('', 'A northman.'), 'A northman.');
  });

  it('appends with a blank line between', () => {
    assert.equal(bioWith('A northman.', 'Nine fingers.'), 'A northman.\n\nNine fingers.');
  });

  it('does not add the same sentence twice', () => {
    assert.equal(bioWith('A northman.', 'A northman.'), 'A northman.');
  });

  it('ignores an empty addition', () => {
    assert.equal(bioWith('A northman.', '   '), 'A northman.');
  });
});

describe('autosave', () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('does not write on every keystroke', async () => {
    const written: string[] = [];
    const save = createAutosave(async (_id, text) => void written.push(text), 30);
    save.queue('n1', 'a');
    save.queue('n1', 'ab');
    save.queue('n1', 'abc');
    assert.deepEqual(written, []);
    await tick(60);
    assert.deepEqual(written, ['abc']);
  });

  it('writes immediately when flushed, as closing the sheet does', async () => {
    const written: string[] = [];
    const save = createAutosave(async (_id, text) => void written.push(text), 10_000);
    save.queue('n1', 'half a thought');
    await save.flush();
    assert.deepEqual(written, ['half a thought']);
    assert.equal(save.pendingCount(), 0);
  });

  it('writes everything outstanding, not just the last note touched', async () => {
    const written: string[] = [];
    const save = createAutosave(async (id, text) => void written.push(`${id}:${text}`), 10_000);
    save.queue('n1', 'one');
    save.queue('n2', 'two');
    await save.flush();
    assert.deepEqual(written.sort(), ['n1:one', 'n2:two']);
  });

  it('keeps the text when a write fails, rather than dropping it', async () => {
    let attempts = 0;
    const save = createAutosave(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('database is locked');
    }, 10_000);
    save.queue('n1', 'precious');
    await save.flush();
    assert.equal(save.pendingCount(), 1, 'a failed write must not lose the text');
    await save.flush();
    assert.equal(attempts, 2);
    assert.equal(save.pendingCount(), 0);
  });

  it('flushing with nothing pending is harmless', async () => {
    const save = createAutosave(async () => {}, 10);
    await save.flush();
    assert.equal(save.pendingCount(), 0);
  });
});

describe('the page you can take away', () => {
  const cast = [
    character({ id: 'c1', name: 'Logen', aliases: 'Ninefingers', bio: 'A northman.' }),
    character({ id: 'c2', name: 'Ferro' }),
  ];
  const notes = [
    note({ id: 'n1', positionSec: 95, chapterIndex: 0, text: 'the duel with @Logen' }),
    note({ id: 'n2', positionSec: 3725, chapterIndex: 2, text: '' }),
  ];
  notes[0].characterIds = ['c1'];

  const page = exportNotes({
    title: 'The Blade Itself',
    author: 'Joe Abercrombie',
    chapters: CHAPTERS,
    notes,
    characters: cast,
    includeCharacters: true,
  });

  it('names the book and its author', () => {
    assert.match(page, /^# The Blade Itself/);
    assert.match(page, /Joe Abercrombie/);
  });

  it('puts notes under their chapter', () => {
    assert.match(page, /## One/);
    assert.match(page, /## Three/);
  });

  it('stamps the time, in hours once a book is long enough', () => {
    assert.match(page, /\*\*1:35\*\*/);
    assert.match(page, /\*\*1:02:05\*\*/);
  });

  it('says which notes are only bookmarks', () => {
    assert.match(page, /\*\*1:02:05\*\* — bookmark/);
  });

  it('carries the tags on a note', () => {
    assert.match(page, /_Logen_/);
  });

  it('includes the characters, their aliases, bios and first heard', () => {
    assert.match(page, /## Who's who/);
    assert.match(page, /### Logen/);
    assert.match(page, /_also Ninefingers_/);
    assert.match(page, /A northman\./);
    assert.match(page, /first heard 1:35 · 1 note/);
    assert.match(page, /### Ferro/);
    assert.match(page, /not heard yet · 0 notes/);
  });

  it('leaves the characters out when they are not included', () => {
    const free = exportNotes({
      title: 'The Blade Itself',
      author: 'Joe Abercrombie',
      chapters: CHAPTERS,
      notes,
      characters: cast,
      includeCharacters: false,
    });
    assert.ok(!free.includes("Who's who"));
    assert.match(free, /the duel with @Logen/);
  });

  it('says so plainly when there is nothing written yet', () => {
    const empty = exportNotes({
      title: 'A Book',
      author: '',
      chapters: CHAPTERS,
      notes: [],
      characters: [],
      includeCharacters: true,
    });
    assert.match(empty, /No notes yet/);
  });
});
