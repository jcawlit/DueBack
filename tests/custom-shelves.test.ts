/**
 * Laying out the shelves somebody arranged by hand.
 *
 * The drag itself is a finger on glass and cannot run here. This is the part
 * that can: that every book appears exactly once, that a shelf too long for
 * one ledge becomes several rows which are all the same drop target, and that
 * an empty shelf still gets a row — because an empty shelf is the one you
 * just made and are about to drag a book onto.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCustomShelves,
  buildShelves,
  PER_SHELF,
  seedShelvesFromLength,
  type CustomShelf,
} from '../src/lib/shelves.ts';
import type { Book } from '../src/data/types.ts';

function book(id: string, over: Partial<Book> = {}): Book {
  return {
    id,
    title: id,
    author: 'An Author',
    durationSec: 3600,
    sizeBytes: 1000,
    sourceRelPath: id,
    files: [`${id}/01.mp3`],
    chapters: [],
    local: { status: 'on-shelf' },
    progressSec: 0,
    checkouts: [],
    ...over,
  };
}

const shelf = (id: string, name: string, bookIds: string[]): CustomShelf => ({ id, name, bookIds });

/** Every book id the rows show, in order. */
const shown = (rows: { books: Book[] }[]) => rows.flatMap((r) => r.books.map((b) => b.id));

describe('rows for hand-arranged shelves', () => {
  it('shows a shelf and the books on it', () => {
    const books = [book('a'), book('b')];
    const rows = buildCustomShelves(books, [shelf('s1', 'Sci-fi', ['b'])]);

    assert.equal(rows.length, 1, 'no pile row for the unplaced book');
    assert.equal(rows[0].label, 'Sci-fi');
    assert.deepEqual(rows[0].books.map((b) => b.id), ['b']);
    assert.equal(rows[0].shelfId, 's1');
  });

  it('shows only what is on a shelf, since nothing is ever unplaced', () => {
    // Custom mode is seeded from the by-length shelves, so a book with no
    // shelf is a transient state rather than something to draw a row for.
    const books = ['a', 'b', 'c', 'd', 'e'].map((id) => book(id));
    const rows = buildCustomShelves(books, [
      shelf('s1', 'Sci-fi', ['a', 'c']),
      shelf('s2', 'Re-reads', ['e']),
    ]);
    assert.deepEqual(shown(rows).sort(), ['a', 'c', 'e']);
  });

  it('keeps the order the books were arranged in', () => {
    const books = [book('a'), book('b'), book('c')];
    const rows = buildCustomShelves(books, [shelf('s1', 'Sci-fi', ['c', 'a', 'b'])]);
    assert.deepEqual(shown(rows), ['c', 'a', 'b']);
  });

  it('keeps a shelf to one row, however many books are on it', () => {
    /*
     * One shelf is one ledge, and one ledge is one drop target. Splitting
     * an over-full shelf into extra rows moved every row below it mid-drag
     * and left the hit-testing aiming at positions that had shifted.
     */
    const books = ['a', 'b', 'c', 'd'].map((id) => book(id));
    const rows = buildCustomShelves(books, [shelf('s1', 'Sci-fi', ['a', 'b', 'c', 'd'])]);

    assert.equal(rows.length, 1, 'a transiently over-full shelf is still one row');
    assert.deepEqual(shown(rows), ['a', 'b', 'c', 'd']);
    assert.equal(rows[0].label, 'Sci-fi', 'and no · CONT. label');
  });

  it('gives one row per shelf, in the order the shelves are in', () => {
    const books = ['a', 'b', 'c'].map((id) => book(id));
    const rows = buildCustomShelves(books, [
      shelf('s1', 'One', ['a']),
      shelf('s2', 'Two', ['b']),
      shelf('s3', 'Three', ['c']),
    ]);
    assert.deepEqual(rows.map((r) => r.shelfId), ['s1', 's2', 's3']);
  });

  it('gives an empty shelf a row to drop onto', () => {
    const rows = buildCustomShelves([book('a')], [shelf('s1', 'Re-reads', [])]);
    assert.equal(rows[0].shelfId, 's1');
    assert.deepEqual(rows[0].books, [], 'empty, and still there');
    assert.equal(rows[0].label, 'Re-reads');
  });

  it('ignores an assignment whose book is not in this library', () => {
    // Which happens the moment a backup arrives before the scan that finds
    // the books, and on any library that has had a book removed.
    const rows = buildCustomShelves([book('a')], [shelf('s1', 'Sci-fi', ['gone', 'a'])]);
    assert.deepEqual(shown(rows), ['a']);
  });

  it('seeds from the by-length shelves, one ledge to a shelf', () => {
    // What custom mode starts from, so the first thing a listener does is
    // reorder and rename rather than build from nothing.
    const books = Array.from({ length: 7 }, (_, i) => book(`b${i}`));
    const seeded = seedShelvesFromLength(books);

    assert.equal(seeded.length, Math.ceil(7 / PER_SHELF));
    assert.ok(seeded.every((sh) => sh.bookIds.length <= PER_SHELF));
    assert.deepEqual(
      seeded.flatMap((sh) => sh.bookIds).sort(),
      books.map((b) => b.id).sort(),
      'every book is seeded exactly once',
    );
    assert.ok(seeded[0].name.length > 0, 'the band label becomes the first name');
  });

  it('seeds nothing from an empty library', () => {
    assert.deepEqual(seedShelvesFromLength([]), []);
  });

  it('gives every row a distinct key, including across shelves', () => {
    const books = ['a', 'b', 'c', 'd'].map((id) => book(id));
    const rows = buildShelves(books, 'custom', [
      shelf('s1', 'One', ['a', 'b']),
      shelf('s2', 'Two', ['c']),
      shelf('s3', 'Three', []),
    ]);
    const keys = rows.map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, `duplicate keys in ${keys.join(', ')}`);
  });
});
