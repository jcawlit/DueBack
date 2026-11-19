/**
 * How a tree of files becomes books.
 *
 * The cases here are the shapes real libraries arrive in: CD rips split across
 * disc folders, a folder that is really a shelf of short works, artwork kept
 * one level up, placeholder author tags, and the junk every operating system
 * sprinkles over a drive.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintKey,
  INCOMPLETE_MARKER,
  isIncompleteMarker,
  discParentOf,
  findCoverFile,
  groupIntoBooks,
  isDiscFolder,
  isJunkFile,
  orderParts,
  type ScannedFile,
} from '../src/lib/library/grouping.ts';
import { isPlaceholderAuthor, resolveName } from '../src/lib/library/names.ts';
import { sanitiseChapters } from '../src/lib/library/chapters.ts';
import { searchBooks } from '../src/lib/library/search.ts';
import {
  duplicateSets,
  duplicatesOf,
  folderLabel,
} from '../src/lib/library/duplicates.ts';

/** A file at `relPath`, with a size so cover selection has something to rank. */
function f(relPath: string, sizeBytes = 1000): ScannedFile {
  return {
    relPath,
    name: relPath.slice(relPath.lastIndexOf('/') + 1),
    uri: `file:///lib/${relPath}`,
    sizeBytes,
    modifiedMs: 1,
  };
}

const folders = (files: ScannedFile[]) =>
  groupIntoBooks(files).map((g) => g.folderRelPath).sort();

describe('disc folders', () => {
  it('recognises the disc naming people actually use', () => {
    for (const name of ['CD 1', 'cd1', 'Disc 2', 'disk_03', 'CD 1 of 3', 'Disc-10']) {
      assert.ok(isDiscFolder(name), `${name} should be a disc folder`);
    }
  });

  it('leaves ambiguous names alone', () => {
    // "Part 1" is as likely to be book one of a series as half of one book,
    // and merging two books is much harder to spot than failing to merge.
    for (const name of ['Part 1', 'Book 2', 'Dune', 'CD Projekt', 'Discworld', 'Disc']) {
      assert.ok(!isDiscFolder(name), `${name} should not be a disc folder`);
    }
  });

  it('merges every disc of a set into one book', () => {
    const files = [
      f('Dune/CD 1/Track 01.mp3'),
      f('Dune/CD 1/Track 02.mp3'),
      f('Dune/CD 2/Track 01.mp3'),
      f('Dune/CD 2/Track 02.mp3'),
    ];
    const groups = groupIntoBooks(files);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].folderRelPath, 'Dune');
    assert.equal(groups[0].folderName, 'Dune');
    assert.equal(groups[0].files.length, 4);
  });

  it('orders a merged set disc by disc, not by repeated filename', () => {
    const files = [
      f('Dune/CD 2/Track 01.mp3'),
      f('Dune/CD 10/Track 01.mp3'),
      f('Dune/CD 1/Track 01.mp3'),
    ];
    const [group] = groupIntoBooks(files);
    assert.deepEqual(
      group.files.map((x) => x.relPath),
      ['Dune/CD 1/Track 01.mp3', 'Dune/CD 2/Track 01.mp3', 'Dune/CD 10/Track 01.mp3'],
    );
  });

  it('orders parts across discs when track numbers restart on each one', () => {
    // Both discs number their tracks from 1, so the tags are not distinct and
    // the path has to carry the ordering.
    const parts = [
      { file: f('Dune/CD 2/Track 01.mp3'), trackNumber: 1 },
      { file: f('Dune/CD 1/Track 02.mp3'), trackNumber: 2 },
      { file: f('Dune/CD 1/Track 01.mp3'), trackNumber: 1 },
    ];
    const ordered = orderParts(parts);
    assert.deepEqual(
      ordered.parts.map((p) => p.file.relPath),
      ['Dune/CD 1/Track 01.mp3', 'Dune/CD 1/Track 02.mp3', 'Dune/CD 2/Track 01.mp3'],
    );
  });

  it('keeps a non-disc sibling as its own book', () => {
    const files = [
      f('Dune/CD 1/a.mp3'),
      f('Dune/CD 2/b.mp3'),
      f('Dune/Bonus Interview/c.mp3'),
    ];
    assert.deepEqual(folders(files), ['Dune', 'Dune/Bonus Interview']);
  });

  it('does not collapse a top-level disc folder into the library root', () => {
    // There is no parent book for it to join.
    assert.equal(discParentOf('CD 1'), 'CD 1');
    assert.deepEqual(folders([f('CD 1/a.mp3')]), ['CD 1']);
  });

  it('collapses nested disc folders', () => {
    assert.equal(discParentOf('Dune/Disc 1/CD 2'), 'Dune');
  });
});

describe('a series folder of books', () => {
  // The commonest real layout: a folder named for the series, with one folder
  // per book inside it. The series folder holds no audio of its own and must
  // not become a book, and each book must be named for its own folder rather
  // than for the series.
  const files = [
    f('Red Rising/cover.jpg', 5000),
    f('Red Rising/Red Rising/Red Rising.m4b'),
    f('Red Rising/Golden Son/Golden Son.m4b'),
    f('Red Rising/Golden Son/cover.jpg', 400),
    f('Red Rising/Morning Star/CD 1/Track 01.mp3'),
    f('Red Rising/Morning Star/CD 2/Track 01.mp3'),
    f('Red Rising/Iron Gold/part1.mp3'),
    f('Red Rising/Iron Gold/part2.mp3'),
    f('Red Rising/.DS_Store'),
  ];

  it('makes one book per inner folder and none for the series', () => {
    assert.deepEqual(folders(files), [
      'Red Rising/Golden Son',
      'Red Rising/Iron Gold',
      'Red Rising/Morning Star',
      'Red Rising/Red Rising',
    ]);
  });

  it('names each book after its own folder, not the series', () => {
    const names = groupIntoBooks(files).map((g) => g.folderName).sort();
    assert.deepEqual(names, ['Golden Son', 'Iron Gold', 'Morning Star', 'Red Rising']);
  });

  it('gives a book sharing its name with the series its own identity', () => {
    // `Red Rising/Red Rising` must not collide with the series folder.
    const inner = groupIntoBooks(files).find((g) => g.folderRelPath === 'Red Rising/Red Rising');
    assert.ok(inner);
    assert.equal(inner!.files.length, 1);
  });

  it('still merges disc folders one level deeper', () => {
    const morning = groupIntoBooks(files).find((g) => g.folderRelPath === 'Red Rising/Morning Star');
    assert.equal(morning?.files.length, 2);
  });

  it('shares the series cover only with books that have none', () => {
    assert.equal(
      findCoverFile(files, 'Red Rising/Golden Son')?.relPath,
      'Red Rising/Golden Son/cover.jpg',
    );
    assert.equal(
      findCoverFile(files, 'Red Rising/Iron Gold')?.relPath,
      'Red Rising/cover.jpg',
    );
  });
});

describe('junk files', () => {
  it('recognises the usual operating-system litter', () => {
    for (const name of ['._Dune.mp3', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.hidden']) {
      assert.ok(isJunkFile(name), `${name} should be junk`);
    }
    for (const name of ['Dune.mp3', 'cover.jpg', 'notes.txt']) {
      assert.ok(!isJunkFile(name), `${name} should not be junk`);
    }
  });

  it('never lets junk become a book, a part, or a skipped file', () => {
    const files = [
      f('Dune/book.mp3'),
      f('Dune/._book.mp3'),
      f('Dune/.DS_Store'),
      f('Dune/Thumbs.db'),
    ];
    const groups = groupIntoBooks(files);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].files.length, 1);
    assert.equal(groups[0].skippedUnsupported, 0);
  });

  it('does not let an AppleDouble sibling be mistaken for cover art', () => {
    const files = [f('Dune/book.mp3'), f('Dune/._cover.jpg', 9999), f('Dune/cover.jpg', 500)];
    const cover = findCoverFile(files, 'Dune');
    assert.equal(cover?.name, 'cover.jpg');
  });
});

describe('cover art lookup', () => {
  it('prefers a cover in the book’s own folder', () => {
    const files = [f('Series/cover.jpg', 5000), f('Series/Book/cover.jpg', 100), f('Series/Book/a.mp3')];
    assert.equal(findCoverFile(files, 'Series/Book')?.relPath, 'Series/Book/cover.jpg');
  });

  it('falls back to a parent folder’s cover', () => {
    const files = [f('Series/cover.jpg', 5000), f('Series/Book/a.mp3')];
    assert.equal(findCoverFile(files, 'Series/Book')?.relPath, 'Series/cover.jpg');
  });

  it('ignores an image at the library root', () => {
    // A picture at the top of a drive is usually a logo or a stray download,
    // not artwork for every book below it.
    const files = [f('logo.png', 5000), f('Book/a.mp3')];
    assert.equal(findCoverFile(files, 'Book'), null);
  });
});

describe('placeholder authors', () => {
  it('recognises the values rippers write when they have nothing', () => {
    for (const a of ['Various Artists', 'various', 'Unknown Artist', 'unknown', 'VA', 'N/A']) {
      assert.ok(isPlaceholderAuthor(a), `${a} should be a placeholder`);
    }
    for (const a of ['Dan Simmons', 'Various Authors Press', 'Vance']) {
      assert.ok(!isPlaceholderAuthor(a), `${a} should be a real author`);
    }
  });

  it('drops a placeholder and lets the folder supply the author', () => {
    // Folders follow the "Author - Title" convention, so the author is on the
    // left; see `splitAuthorTitle`.
    const name = resolveName({
      folderName: 'Dan Simmons - Hyperion',
      embeddedTitle: 'Hyperion',
      embeddedAuthor: 'Various Artists',
    });
    assert.equal(name.author, 'Dan Simmons');
    assert.equal(name.authorSource, 'folder-split');
  });

  it('leaves the author empty when the folder has none either', () => {
    const name = resolveName({
      folderName: 'Dune',
      embeddedTitle: 'Dune',
      embeddedAuthor: 'Unknown Artist',
    });
    assert.equal(name.author, undefined);
    assert.equal(name.authorSource, 'none');
    assert.equal(name.title, 'Dune');
  });
});

describe('one book per folder, with the root as the exception', () => {
  it('keeps a self-recorded folder of varied filenames as one book', () => {
    // These used to split into three: the old heuristic stripped digits and
    // part markers, then split whenever the remaining text varied.
    const files = [
      f('My Memoir/recording 2023-01-05.m4a'),
      f('My Memoir/recording 2023-01-12.m4a'),
      f('My Memoir/New Recording 3.m4a'),
      f('My Memoir/final final.m4a'),
    ];
    const groups = groupIntoBooks(files);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].files.length, 4);
  });

  it('keeps an intro and a credits track with the book they belong to', () => {
    const files = [
      f('Book/00 - Intro.mp3'),
      f('Book/01.mp3'),
      f('Book/02.mp3'),
      f('Book/99 - Credits.mp3'),
    ];
    const groups = groupIntoBooks(files);
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].files.map((x) => x.name),
      ['00 - Intro.mp3', '01.mp3', '02.mp3', '99 - Credits.mp3'],
    );
  });

  it('keeps parts named for their chapters together', () => {
    const files = [
      f('Book/01 Prologue.m4b'),
      f('Book/02 Chapter 1.m4b'),
      f('Book/03 Chapter 2.m4b'),
    ];
    assert.equal(groupIntoBooks(files).length, 1);
  });

  it('makes each loose file in the library root its own book', () => {
    // The root is not a book folder, so two unrelated files there are two
    // books even with no tags to tell them apart.
    const files = [f('Some Book.m4b'), f('Another.mp3')];
    const groups = groupIntoBooks(files);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.folderName).sort(), ['Another', 'Some Book']);
    assert.ok(groups.every((g) => g.files.length === 1 && g.split));
  });
});

describe('sanitiseChapters', () => {
  const c = (startSec: number, title = 'Chapter') => ({ startSec, title });

  it('sorts by start time', () => {
    const out = sanitiseChapters([c(30), c(10), c(0)], 60);
    assert.deepEqual(out.map((x) => x.startSec), [0, 10, 30]);
  });

  it('collapses marks that share a start', () => {
    const out = sanitiseChapters([c(10), c(10), c(20)], 60);
    assert.deepEqual(out.map((x) => x.startSec), [10, 20]);
  });

  it('drops marks at or past the end of the book', () => {
    const out = sanitiseChapters([c(0), c(59), c(60), c(999)], 60);
    assert.deepEqual(out.map((x) => x.startSec), [0, 59]);
  });

  it('keeps every mark when the duration is not known yet', () => {
    const out = sanitiseChapters([c(0), c(999)], 0);
    assert.equal(out.length, 2);
  });

  it('names blank titles after their position', () => {
    const out = sanitiseChapters([{ startSec: 10, title: '' }, { startSec: 0, title: '  ' }], 60);
    assert.deepEqual(out.map((x) => x.title), ['Chapter 1', 'Chapter 2']);
  });

  it('leaves a clean list alone', () => {
    const input = [c(0, 'One'), c(10, 'Two')];
    assert.deepEqual(sanitiseChapters(input, 60), input);
  });
});

describe('searching the library', () => {
  const book = (title: string, author = '', narrator?: string) =>
    ({ id: title, title, author, narrator, chapters: [], files: [] }) as never;

  const titles = (list: ReturnType<typeof searchBooks>) =>
    list.map((b) => b.title).sort();

  const shelf = [
    book('Hyperion', 'Dan Simmons'),
    book('The Fall of Hyperion', 'Dan Simmons'),
    book('Les Misérables', 'Victor Hugo'),
    book('Война и мир', 'Лев Толстой'),
    book('The Blade Itself', 'Joe Abercrombie', 'Steven Pacey'),
  ];

  it('returns everything for an empty query', () => {
    assert.equal(searchBooks(shelf, '').length, shelf.length);
    assert.equal(searchBooks(shelf, '   ').length, shelf.length);
  });

  it('finds by title and by author', () => {
    assert.deepEqual(titles(searchBooks(shelf, 'hyperion')),
      ['Hyperion', 'The Fall of Hyperion']);
    assert.deepEqual(titles(searchBooks(shelf, 'simmons')),
      ['Hyperion', 'The Fall of Hyperion']);
  });

  it('finds by narrator', () => {
    assert.deepEqual(titles(searchBooks(shelf, 'pacey')), ['The Blade Itself']);
  });

  it('ignores accents, so a plain keyboard still finds the book', () => {
    assert.deepEqual(titles(searchBooks(shelf, 'les miserables')), ['Les Misérables']);
  });

  it('takes the words in any order', () => {
    assert.deepEqual(titles(searchBooks(shelf, 'simmons fall')), ['The Fall of Hyperion']);
  });

  it('matches word beginnings, not fragments inside them', () => {
    // "sim" is someone typing; "ons" is noise.
    assert.equal(searchBooks(shelf, 'sim').length, 2);
    assert.equal(searchBooks(shelf, 'ons').length, 0);
  });

  it('searches non-Latin text too', () => {
    assert.deepEqual(titles(searchBooks(shelf, 'толстой')), ['Война и мир']);
  });

  it('returns nothing when nothing matches', () => {
    assert.equal(searchBooks(shelf, 'zzz').length, 0);
  });
});

describe('spotting the same book twice', () => {
  const copy = (id: string, title: string, author: string, sourceRelPath: string) =>
    ({ id, title, author, sourceRelPath, chapters: [], files: [] }) as never;

  const shelf = [
    copy('a', 'Twice Over', 'Ditto', 'Dup A'),
    copy('b', 'Twice Over', 'Ditto', 'Boxed Set/Dup B'),
    copy('c', 'Hyperion', 'Dan Simmons', 'Hyperion - Dan Simmons'),
    copy('d', 'Twice Over', 'Someone Else', 'Elsewhere'),
  ];

  it('finds the other copy, and does not count the book itself', () => {
    const twins = duplicatesOf(shelf, shelf[0]);
    assert.deepEqual(twins.map((b) => b.id), ['b']);
  });

  it('is symmetrical', () => {
    assert.deepEqual(duplicatesOf(shelf, shelf[1]).map((b) => b.id), ['a']);
  });

  it('leaves a book that exists once alone', () => {
    assert.deepEqual(duplicatesOf(shelf, shelf[2]), []);
  });

  it('needs the author to match as well as the title', () => {
    // Same title, different author: a different book, however it is spelled.
    assert.deepEqual(duplicatesOf(shelf, shelf[3]), []);
  });

  it('ignores case, accents and punctuation', () => {
    const messy = [
      copy('x', 'Les Misérables', 'Victor Hugo', 'A'),
      copy('y', 'les miserables', 'victor hugo', 'B'),
    ];
    assert.deepEqual(duplicatesOf(messy, messy[0]).map((b) => b.id), ['y']);
  });

  it('says nothing about a book with no title to match on', () => {
    const blank = [copy('p', '', '', 'A'), copy('q', '', '', 'B')];
    assert.deepEqual(duplicatesOf(blank, blank[0]), []);
  });

  it('names the folder first and what it sits in second', () => {
    /*
     * The folder cannot be shown on its own — "Disc 1" names nothing — but
     * it used to be the full path, and that put the wrong word where the eye
     * lands. A second copy of The Hobbit inside a folder called
     * `Hyperion - Dan Simmons - 1989` was labelled with Hyperion's name, and
     * read as though the app were linking to the wrong book. It was not. The
     * label was simply unreadable.
     */
    assert.equal(folderLabel(shelf[1]), 'Dup B, in Boxed Set');
    assert.equal(
      folderLabel(copy('h', 'T', 'A', 'Hyperion - Dan Simmons - 1989/The Hobbit') as never),
      'The Hobbit, in Hyperion - Dan Simmons - 1989',
    );
    // A book at the top of the library has nothing to sit in, and says so.
    assert.equal(folderLabel(copy('s', 'T', 'A', '/Trimmed/') as never), 'Trimmed');
    assert.equal(folderLabel(copy('r', 'T', 'A', '') as never), 'the library folder');
  });

  it('groups the whole library into sets of more than one', () => {
    const sets = duplicateSets(shelf);
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0].map((b) => b.id).sort(), ['a', 'b']);
  });
});

describe('fingerprint keys for incremental scans', () => {
  it('keys a book in a folder by its folder', () => {
    assert.equal(fingerprintKey('Hyperion', 'Hyperion/01.mp3'), 'Hyperion');
    // Two books split out of one folder share a key on purpose: the decision
    // to re-read is made before the album tags have been read.
    assert.equal(
      fingerprintKey('Shorts', 'Shorts/a.mp3'),
      fingerprintKey('Shorts', 'Shorts/b.mp3'),
    );
  });

  it('keys a file loose in the root by its own path', () => {
    const a = fingerprintKey('', 'Another.mp3');
    const b = fingerprintKey('', 'Some Book.m4b');
    assert.notEqual(a, b);
  });

  it('cannot collide with a folder path', () => {
    // A folder path never starts with a null byte, so the two name spaces
    // stay apart even for a folder literally called "root:Another.mp3".
    assert.notEqual(fingerprintKey('', 'Another.mp3'), fingerprintKey('root:Another.mp3', 'x'));
  });
});

/**
 * The marker left inside a folder on the drive while a book is being written
 * into it.
 *
 * SAF has no rename, so an imported book cannot be assembled under a temporary
 * name and moved into place — it goes straight into its final folder. If the
 * app dies mid-copy, nothing runs to clean up, and this marker is the only
 * thing telling a later scan that the folder holds half a book rather than a
 * short one.
 */
describe('incomplete-copy marker', () => {
  const marked = (folder: string) => f(`${folder}/${INCOMPLETE_MARKER}`);
  const folders = (files: ScannedFile[]) =>
    groupIntoBooks(files).map((g) => g.folderRelPath).sort();

  it('still treats ordinary dotfiles as junk', () => {
    for (const name of ['.DS_Store', '._cover.jpg', '.Trashes']) {
      assert.equal(isJunkFile(name), true, `${name} should be junk`);
    }
  });

  it('lets the marker through, so grouping can act on it', () => {
    assert.equal(isJunkFile(INCOMPLETE_MARKER), false);
  });

  it('skips a folder that holds the marker', () => {
    assert.deepEqual(folders([marked('Book'), f('Book/01.mp3')]), []);
  });

  it('skips everything under a marked folder, discs included', () => {
    assert.deepEqual(
      folders([marked('Book'), f('Book/Disc 1/01.mp3'), f('Book/Disc 2/02.mp3')]),
      [],
    );
  });

  it('leaves the books beside it alone', () => {
    assert.deepEqual(
      folders([marked('Broken'), f('Broken/01.mp3'), f('Good/01.mp3')]),
      ['Good'],
    );
  });

  it('never becomes a book of its own', () => {
    // A marked folder yields no group at all — not an empty one, and not a
    // book made of the marker file.
    const groups = groupIntoBooks([marked('Book'), f('Book/01.mp3')]);
    assert.equal(groups.length, 0);
  });

  /*
   * The app only ever writes a marker inside a book's own folder. One loose in
   * the library root would mean "every book on this drive is incomplete",
   * which is never true and would empty the shelves in one go.
   */
  it('ignores a marker loose in the library root', () => {
    assert.deepEqual(
      folders([f(INCOMPLETE_MARKER), f('Good/01.mp3'), f('Also Good/01.mp3')]),
      ['Also Good', 'Good'],
    );
  });

  /*
   * The drive renames it. SAF runs the requested name through
   * `FileUtils.buildUniqueFile`, which appends an extension for the MIME type
   * when the name has none it recognises, so the marker lands as
   * `.dueback-incomplete.txt`. Matching the exact string found nothing, and a
   * half-written book was indexed as a short one.
   */
  it('recognises the marker under the name the drive gave it', () => {
    for (const name of [
      '.dueback-incomplete',
      '.dueback-incomplete.txt',
      '.dueback-incomplete (1).txt',
      '.DUEBACK-INCOMPLETE.TXT',
      'dueback-incomplete.txt',
    ]) {
      assert.equal(isIncompleteMarker(name), true, `${name} should be the marker`);
      assert.equal(isJunkFile(name), false, `${name} should not be junk`);
    }
  });

  it('is not fooled by a book that merely mentions it', () => {
    for (const name of ['incomplete.mp3', 'my-dueback-incomplete.txt', '.dueback.txt']) {
      assert.equal(isIncompleteMarker(name), false, `${name} is not the marker`);
    }
  });

  it('skips a folder whose marker the drive renamed', () => {
    assert.deepEqual(
      folders([f('Book/.dueback-incomplete.txt'), f('Book/01.mp3'), f('Good/01.mp3')]),
      ['Good'],
    );
  });
});
