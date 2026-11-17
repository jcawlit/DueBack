/**
 * The sorts that answer a question rather than rearrange the whole library:
 * by series, by narrator, what has been gathering dust, what is unfinished.
 *
 * The cases here are the ones a real library throws up. Series tags are a
 * convention rather than a standard, so plenty of books have none and plenty
 * have a name with no number. Narrators are often missing entirely. And a
 * book can carry a last-played date that does not parse.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildShelves,
  DEFAULT_SORT,
  dustBand,
  effectiveSort,
  progressBand,
} from '../src/lib/shelves.ts';
import type { Book } from '../src/data/types.ts';

function book(overrides: Partial<Book> & { id: string }): Book {
  return {
    title: 'A Title',
    author: 'Eleanor Vance',
    durationSec: 3600,
    sizeBytes: 1024,
    sourceRelPath: overrides.id,
    files: [`${overrides.id}/01.mp3`],
    chapters: [],
    local: { status: 'on-shelf' },
    progressSec: 0,
    checkouts: [],
    ...overrides,
  } as Book;
}

const ids = (shelves: { books: Book[] }[]) => shelves.flatMap((s) => s.books.map((b) => b.id));
const labelled = (shelves: { label: string; books: Book[] }[]) =>
  shelves.map((s) => `${s.label}: ${s.books.map((b) => b.id).join(',')}`);

describe('by series', () => {
  it('runs a series in story order, not alphabetical', () => {
    // The whole reason the number is read from the tags: "The Fall of
    // Hyperion" sorts before "Hyperion", which is a list and not a series.
    const books = [
      book({ id: 'fall', title: 'The Fall of Hyperion', series: 'Hyperion', seriesIndex: 2 }),
      book({ id: 'first', title: 'Hyperion', series: 'Hyperion', seriesIndex: 1 }),
    ];
    assert.deepEqual(ids(buildShelves(books, 'series')), ['first', 'fall']);
  });

  it('puts a book with no number at the end of its own series', () => {
    const books = [
      book({ id: 'extra', title: 'A Companion', series: 'Hyperion' }),
      book({ id: 'one', title: 'Hyperion', series: 'Hyperion', seriesIndex: 1 }),
    ];
    assert.deepEqual(ids(buildShelves(books, 'series')), ['one', 'extra']);
  });

  it('gathers the books with no series at the end, under their own label', () => {
    const books = [
      book({ id: 'loose', title: 'Standalone' }),
      book({ id: 'in', title: 'Hyperion', series: 'Hyperion', seriesIndex: 1 }),
    ];
    const shelves = buildShelves(books, 'series');
    assert.deepEqual(labelled(shelves), ['Hyperion: in', 'NOT IN A SERIES: loose']);
  });

  it('treats a blank or whitespace series as no series at all', () => {
    const books = [
      book({ id: 'blank', series: '' }),
      book({ id: 'spaces', series: '   ' }),
    ];
    const shelves = buildShelves(books, 'series');
    assert.equal(shelves.length, 1);
    assert.equal(shelves[0].label, 'NOT IN A SERIES');
  });

  it('loses no books', () => {
    const books = [
      book({ id: 'a', series: 'One', seriesIndex: 1 }),
      book({ id: 'b', series: 'Two' }),
      book({ id: 'c' }),
    ];
    assert.deepEqual(ids(buildShelves(books, 'series')).sort(), ['a', 'b', 'c']);
  });
});

describe('by narrator', () => {
  it('gives each narrator their own shelf, in name order', () => {
    const books = [
      book({ id: 'z', narrator: 'Zora Bell' }),
      book({ id: 'a', narrator: 'Adam Finch' }),
    ];
    assert.deepEqual(labelled(buildShelves(books, 'narrator')), [
      'Adam Finch: a',
      'Zora Bell: z',
    ]);
  });

  it('orders a narrator\'s own books by title', () => {
    const books = [
      book({ id: 'second', title: 'Beta', narrator: 'Adam Finch' }),
      book({ id: 'first', title: 'Alpha', narrator: 'Adam Finch' }),
    ];
    assert.deepEqual(ids(buildShelves(books, 'narrator')), ['first', 'second']);
  });

  it('puts the books with no narrator last', () => {
    const books = [
      book({ id: 'none' }),
      book({ id: 'known', narrator: 'Adam Finch' }),
    ];
    const shelves = buildShelves(books, 'narrator');
    assert.deepEqual(labelled(shelves), ['Adam Finch: known', 'NARRATOR UNKNOWN: none']);
  });

  it('loses no books', () => {
    const books = [
      book({ id: 'a', narrator: 'Adam Finch' }),
      book({ id: 'b', narrator: 'Zora Bell' }),
      book({ id: 'c' }),
    ];
    assert.deepEqual(ids(buildShelves(books, 'narrator')).sort(), ['a', 'b', 'c']);
  });
});

describe('gathering dust', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  const ago = (days: number) =>
    new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  it('bands a book by how long it has been left', () => {
    assert.equal(dustBand(undefined, now), 'NEVER OPENED');
    assert.equal(dustBand(ago(400), now), 'OVER A YEAR');
    assert.equal(dustBand(ago(200), now), 'SIX MONTHS TO A YEAR');
    assert.equal(dustBand(ago(120), now), 'THREE TO SIX MONTHS');
    assert.equal(dustBand(ago(45), now), 'ONE TO THREE MONTHS');
    assert.equal(dustBand(ago(3), now), 'THIS MONTH');
  });

  it('treats a date it cannot read as never opened', () => {
    // Not evidence of listening, and not evidence of neglect either — but
    // somewhere it will be seen and can be put right.
    assert.equal(dustBand('not a date', now), 'NEVER OPENED');
    assert.equal(dustBand('', now), 'NEVER OPENED');
  });

  it('puts the longest-neglected first', () => {
    const books = [
      book({ id: 'recent', lastPlayedAt: ago(2) }),
      book({ id: 'never' }),
      book({ id: 'old', lastPlayedAt: ago(400) }),
    ];
    assert.deepEqual(ids(buildShelves(books, 'dust')), ['never', 'old', 'recent']);
  });

  it('loses no books', () => {
    const books = [book({ id: 'a' }), book({ id: 'b', lastPlayedAt: ago(10) })];
    assert.deepEqual(ids(buildShelves(books, 'dust')).sort(), ['a', 'b']);
  });
});

describe('unfinished', () => {
  it('bands a book by how far through it is', () => {
    assert.equal(progressBand(book({ id: 'a', progressSec: 3400, durationSec: 3600 })), 'NEARLY DONE');
    assert.equal(progressBand(book({ id: 'b', progressSec: 1800, durationSec: 3600 })), 'PART WAY');
    assert.equal(progressBand(book({ id: 'c', progressSec: 200, durationSec: 3600 })), 'JUST STARTED');
  });

  it('survives a book whose duration could not be read', () => {
    // `progressSec / 0` is NaN, and NaN comparisons are all false.
    assert.equal(progressBand(book({ id: 'z', progressSec: 60, durationSec: 0 })), 'JUST STARTED');
  });

  it('leaves out what was never started and what is already done', () => {
    /*
     * The one sort that drops books, deliberately. It answers "what am I in
     * the middle of", and a book never opened is not an answer to it.
     */
    const books = [
      book({ id: 'untouched', progressSec: 0 }),
      book({ id: 'barely', progressSec: 20 }),
      book({ id: 'reading', progressSec: 1800, lastPlayedAt: '2026-11-16T00:00:00Z' }),
      book({ id: 'done', progressSec: 3600, finishedAt: '2026-11-01T00:00:00Z' }),
      book({ id: 'at-the-end', progressSec: 3600 }),
    ];
    assert.deepEqual(ids(buildShelves(books, 'unfinished')), ['reading']);
  });

  it('puts the most recently put down first', () => {
    const books = [
      book({ id: 'older', progressSec: 1800, lastPlayedAt: '2026-11-01T00:00:00Z' }),
      book({ id: 'newer', progressSec: 1800, lastPlayedAt: '2026-11-16T00:00:00Z' }),
    ];
    assert.deepEqual(ids(buildShelves(books, 'unfinished')), ['newer', 'older']);
  });

  it('gives an empty answer rather than an empty shelf', () => {
    assert.deepEqual(buildShelves([book({ id: 'a' })], 'unfinished'), []);
  });
});

describe('when custom mode has nothing to show', () => {
  /*
   * Shelves hold books by id, and a rescan that re-mints ids leaves every
   * assignment pointing at a book that is gone: shelves with their names and
   * not one cover on them. The arrangement is repaired by the next seeding,
   * but a reader staring at an empty library wants their books back now.
   */
  it('gives way to the default sort', () => {
    const custom = [{ id: 's1', name: 'Sci-fi', bookIds: ['gone', 'also-gone'] }];
    const live = new Set(['a', 'b']);
    assert.equal(effectiveSort('custom', live, custom), DEFAULT_SORT);
  });

  it('stays custom as soon as one book is on a shelf', () => {
    const custom = [{ id: 's1', name: 'Sci-fi', bookIds: ['a'] }];
    assert.equal(effectiveSort('custom', new Set(['a', 'b']), custom), 'custom');
  });

  it('stays custom for an empty library, where every mode is empty', () => {
    // Falling back here would hide the real reason the shelves are bare.
    assert.equal(effectiveSort('custom', new Set<string>(), []), 'custom');
  });

  it('leaves every other sort alone', () => {
    for (const sort of ['length', 'author', 'series', 'narrator', 'dust'] as const) {
      assert.equal(effectiveSort(sort, new Set(['a']), []), sort);
    }
  });

  it('does not rescue unfinished, which is honestly empty', () => {
    // Nothing part-read is the true answer to "what am I in the middle of".
    assert.equal(effectiveSort('unfinished', new Set(['a']), []), 'unfinished');
  });
});
