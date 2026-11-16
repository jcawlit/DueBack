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
  UNSHELVED_LABEL,
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
  it('puts a book on its shelf and the rest in the loose pile', () => {
    const books = [book('a'), book('b'), book('c')];
    const rows = buildCustomShelves(books, [shelf('s1', 'Sci-fi', ['b'])]);

    assert.equal(rows[0].label, 'Sci-fi');
    assert.deepEqual(rows[0].books.map((b) => b.id), ['b']);
    assert.equal(rows[0].shelfId, 's1');

    const loose = rows.filter((r) => r.unshelved);
    assert.deepEqual(shown(loose), ['a', 'c']);
    assert.equal(loose[0].label, UNSHELVED_LABEL);
    assert.equal(loose[0].shelfId, undefined, 'the pile is not a shelf');
  });

  it('shows every book exactly once', () => {
    const books = ['a', 'b', 'c', 'd', 'e'].map((id) => book(id));
    const rows = buildCustomShelves(books, [
      shelf('s1', 'Sci-fi', ['a', 'c']),
      shelf('s2', 'Re-reads', ['e']),
    ]);
    const ids = shown(rows).sort();
    assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e'], 'nothing lost, nothing doubled');
  });

  it('keeps the order the books were arranged in', () => {
    const books = [book('a'), book('b'), book('c')];
    const rows = buildCustomShelves(books, [shelf('s1', 'Sci-fi', ['c', 'a', 'b'])]);
    assert.deepEqual(shown(rows), ['c', 'a', 'b']);
  });

  it('splits a long shelf into rows that are all the same drop target', () => {
    const books = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => book(id));
    const rows = buildCustomShelves(books, [
      shelf('s1', 'Sci-fi', ['a', 'b', 'c', 'd', 'e', 'f', 'g']),
    ]);
    assert.equal(rows.length, 3, 'three covers to a ledge');
    assert.deepEqual(rows.map((r) => r.shelfId), ['s1', 's1', 's1']);
    assert.equal(rows[0].label, 'Sci-fi');
    assert.equal(rows[1].label, 'Sci-fi · CONT.');
    assert.deepEqual(shown(rows), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
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
    assert.equal(rows.filter((r) => r.unshelved).length, 0);
  });

  it('has no loose row when everything is on a shelf', () => {
    const rows = buildCustomShelves([book('a')], [shelf('s1', 'Sci-fi', ['a'])]);
    assert.equal(rows.filter((r) => r.unshelved).length, 0);
  });

  it('is reached through buildShelves, and needs no shelves to work', () => {
    const books = [book('a'), book('b')];
    // No shelves yet: everything is loose, which is what a first visit to
    // custom mode looks like and has to be draggable from.
    const rows = buildShelves(books, 'custom', []);
    assert.deepEqual(shown(rows), ['a', 'b']);
    assert.ok(rows.every((r) => r.unshelved));
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
