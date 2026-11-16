/**
 * Pushing a book onto a full shelf.
 *
 * A shelf is one ledge of three. A fourth book sends the far one down to the
 * shelf below, which sends its own last book down in turn, and whatever falls
 * off the bottom goes back to the loose pile. The invariant underneath all of
 * it: no book is ever lost and none is ever duplicated.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cascade,
  placementChanges,
  SHELF_CAPACITY,
  withoutBook,
  withoutShelf,
  type Arrangement,
} from '../src/lib/library/cascade.ts';

const shelf = (id: string, ...bookIds: string[]): Arrangement => ({ id, bookIds });

/** Every book id the arrangement holds, plus whatever fell loose. */
const allBooks = (result: { shelves: Arrangement[]; loose: string[] }) =>
  [...result.shelves.flatMap((s) => s.bookIds), ...result.loose].sort();

describe('taking a book off its shelf', () => {
  it('leaves the others in order', () => {
    const out = withoutBook([shelf('s1', 'a', 'b', 'c')], 'b');
    assert.deepEqual(out[0].bookIds, ['a', 'c']);
  });

  it('does nothing for a book on no shelf', () => {
    const out = withoutBook([shelf('s1', 'a')], 'zz');
    assert.deepEqual(out[0].bookIds, ['a']);
  });
});

describe('pushing a book onto a shelf', () => {
  it('puts it on the front of a shelf with room', () => {
    const result = cascade([shelf('s1', 'a')], 'new', 's1');
    assert.deepEqual(result.shelves[0].bookIds, ['new', 'a']);
    assert.deepEqual(result.loose, []);
  });

  it('pushes the far book down when the shelf is full', () => {
    const before = [shelf('s1', 'a', 'b', 'c'), shelf('s2', 'd')];
    const result = cascade(before, 'new', 's1');
    assert.deepEqual(result.shelves[0].bookIds, ['new', 'a', 'b']);
    assert.deepEqual(result.shelves[1].bookIds, ['c', 'd'], 'c fell onto the next shelf');
    assert.deepEqual(result.loose, []);
  });

  it('never pushes off the book that was just dropped', () => {
    // The whole point of going on at the front: a drop that immediately
    // undid itself would be the one unforgivable outcome.
    const result = cascade([shelf('s1', 'a', 'b', 'c')], 'new', 's1');
    assert.ok(result.shelves[0].bookIds.includes('new'));
    assert.ok(!result.loose.includes('new'));
  });

  it('carries the overflow down through several full shelves', () => {
    const before = [
      shelf('s1', 'a', 'b', 'c'),
      shelf('s2', 'd', 'e', 'f'),
      shelf('s3', 'g'),
    ];
    const result = cascade(before, 'new', 's1');
    assert.deepEqual(result.shelves[0].bookIds, ['new', 'a', 'b']);
    assert.deepEqual(result.shelves[1].bookIds, ['c', 'd', 'e']);
    assert.deepEqual(result.shelves[2].bookIds, ['f', 'g']);
    assert.deepEqual(result.loose, []);
  });

  it('drops what falls off the bottom into the loose pile', () => {
    const before = [shelf('s1', 'a', 'b', 'c'), shelf('s2', 'd', 'e', 'f')];
    const result = cascade(before, 'new', 's2');
    assert.deepEqual(result.shelves[0].bookIds, ['a', 'b', 'c'], 'shelves above are untouched');
    assert.deepEqual(result.shelves[1].bookIds, ['new', 'd', 'e']);
    assert.deepEqual(result.loose, ['f'], 'nothing is created to catch it');
  });

  it('moves a book within its own shelf without pushing a neighbour off', () => {
    // Counted twice, this would overflow a shelf that is merely being
    // reordered — which is why every placement lifts the book first.
    const result = cascade([shelf('s1', 'a', 'b', 'c')], 'c', 's1');
    assert.deepEqual(result.shelves[0].bookIds, ['c', 'a', 'b']);
    assert.deepEqual(result.loose, []);
  });

  it('moves a book between shelves, leaving a gap behind', () => {
    const before = [shelf('s1', 'a', 'b', 'c'), shelf('s2', 'd')];
    const result = cascade(before, 'a', 's2');
    assert.deepEqual(result.shelves[0].bookIds, ['b', 'c']);
    assert.deepEqual(result.shelves[1].bookIds, ['a', 'd']);
  });

  it('leaves everything alone for a shelf that is not there', () => {
    const before = [shelf('s1', 'a')];
    const result = cascade(before, 'new', 'gone');
    assert.deepEqual(result.shelves[0].bookIds, ['a']);
    assert.deepEqual(result.loose, []);
  });

  it('never loses or duplicates a book, over every target', () => {
    const before = [
      shelf('s1', 'a', 'b', 'c'),
      shelf('s2', 'd', 'e', 'f'),
      shelf('s3', 'g', 'h', 'i'),
    ];
    for (const target of ['s1', 's2', 's3']) {
      const result = cascade(before, 'new', target);
      assert.deepEqual(
        allBooks(result),
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'new'],
        `target ${target}`,
      );
      for (const s of result.shelves) {
        assert.ok(s.bookIds.length <= SHELF_CAPACITY, `${s.id} holds ${s.bookIds.length}`);
      }
    }
  });

  it('repairs a shelf that arrived over capacity from another phone', () => {
    // A merge can hand us four on one ledge. The next drop should settle it
    // rather than carry the overfill forward.
    const before = [shelf('s1', 'a', 'b', 'c', 'd'), shelf('s2')];
    const result = cascade(before, 'new', 's1');
    assert.deepEqual(result.shelves[0].bookIds, ['new', 'a', 'b']);
    // Both of the extras move down together, in the order they were in.
    // Carrying one at a time would have left s1 holding four for ever.
    assert.deepEqual(result.shelves[1].bookIds, ['c', 'd']);
    assert.deepEqual(result.loose, [], 's2 had room for both');
  });
});

describe('what has to be written down', () => {
  it('reports only the books that actually moved', () => {
    const before = [shelf('s1', 'a', 'b', 'c'), shelf('s2', 'd')];
    const after = cascade(before, 'new', 's1');
    const changes = placementChanges(before, after);
    const moved = changes.map((c) => c.bookId).sort();
    // `new` arrives, `a` and `b` shift along, `c` moves shelf. `d` shifts to
    // make room for `c`, so it moves too — but nothing else does.
    assert.deepEqual(moved, ['a', 'b', 'c', 'd', 'new']);
  });

  it('writes nothing when nothing changed', () => {
    const before = [shelf('s1', 'a', 'b')];
    const after = cascade(before, 'a', 's1');
    // 'a' was already at the front of s1.
    assert.deepEqual(placementChanges(before, after), []);
  });

  it('marks a book that fell off the bottom as belonging to no shelf', () => {
    const before = [shelf('s1', 'a', 'b', 'c')];
    const after = cascade(before, 'new', 's1');
    const loose = placementChanges(before, after).filter((c) => c.shelfId === null);
    assert.deepEqual(loose, [{ bookId: 'c', shelfId: null, position: 0 }]);
  });

  it('does not write a book that was loose and stayed loose', () => {
    const before = [shelf('s1', 'a', 'b', 'c')];
    const after = cascade(before, 'wasLoose', 's1');
    // 'c' is pushed off; 'wasLoose' came from the pile and is now on a shelf.
    const ids = placementChanges(before, after).map((c) => c.bookId);
    assert.ok(ids.includes('wasLoose'));
    assert.ok(ids.includes('c'));
  });

  it('gives every shelved book its index as its position', () => {
    const before = [shelf('s1', 'a')];
    const after = cascade(before, 'new', 's1');
    const changes = placementChanges(before, after);
    const forNew = changes.find((c) => c.bookId === 'new');
    const forA = changes.find((c) => c.bookId === 'a');
    assert.deepEqual(forNew, { bookId: 'new', shelfId: 's1', position: 0 });
    assert.deepEqual(forA, { bookId: 'a', shelfId: 's1', position: 1 });
  });
});

describe('deleting a shelf', () => {
  it('keeps its books, moving them onto the shelf that takes its place', () => {
    // The books belonged to the listener; the shelf was a label on a ledge.
    const before = [shelf('s1', 'a'), shelf('s2', 'b'), shelf('s3', 'c')];
    const { shelves, overflow } = withoutShelf(before, 's2');

    assert.deepEqual(shelves.map((s) => s.id), ['s1', 's3']);
    assert.deepEqual(shelves[1].bookIds, ['b', 'c'], 'b moved down onto s3');
    assert.deepEqual(overflow, []);
  });

  it('pushes the surplus down the shelves below', () => {
    const before = [shelf('s1', 'a', 'b', 'c'), shelf('s2', 'd', 'e'), shelf('s3')];
    const { shelves, overflow } = withoutShelf(before, 's1');
    assert.deepEqual(shelves[0].bookIds, ['a', 'b', 'c'], 's2 took all three');
    assert.deepEqual(shelves[1].bookIds, ['d', 'e']);
    assert.deepEqual(overflow, []);
  });

  it('reports what will not fit, rather than losing it', () => {
    const before = [shelf('s1', 'a', 'b', 'c'), shelf('s2', 'd', 'e', 'f')];
    const { shelves, overflow } = withoutShelf(before, 's1');
    assert.deepEqual(shelves[0].bookIds, ['a', 'b', 'c']);
    assert.deepEqual(overflow, ['d', 'e', 'f'], 'the caller makes shelves for these');
  });

  it('uses the shelf above when the bottom one is deleted', () => {
    const before = [shelf('s1', 'a'), shelf('s2', 'b')];
    const { shelves, overflow } = withoutShelf(before, 's2');
    assert.deepEqual(shelves.map((s) => s.id), ['s1']);
    assert.deepEqual(shelves[0].bookIds, ['b', 'a']);
    assert.deepEqual(overflow, []);
  });

  it('hands back every book when the last shelf is deleted', () => {
    const { shelves, overflow } = withoutShelf([shelf('s1', 'a', 'b')], 's1');
    assert.deepEqual(shelves, []);
    assert.deepEqual(overflow, ['a', 'b']);
  });

  it('loses nothing, whichever shelf goes', () => {
    const before = [
      shelf('s1', 'a', 'b', 'c'),
      shelf('s2', 'd', 'e'),
      shelf('s3', 'f', 'g', 'h'),
    ];
    for (const id of ['s1', 's2', 's3']) {
      const { shelves, overflow } = withoutShelf(before, id);
      const all = [...shelves.flatMap((s) => s.bookIds), ...overflow].sort();
      assert.deepEqual(all, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], `deleting ${id}`);
    }
  });

  it('does nothing for a shelf that is not there', () => {
    const before = [shelf('s1', 'a')];
    const { shelves, overflow } = withoutShelf(before, 'gone');
    assert.deepEqual(shelves, before);
    assert.deepEqual(overflow, []);
  });
});
