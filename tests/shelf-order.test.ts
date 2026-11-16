/**
 * The arithmetic behind dragging a book to a new place.
 *
 * Positions are fractional so a drop is one write rather than a renumbering.
 * What that has to get right: a midpoint always lands strictly between its
 * neighbours, the ends of a list work, and the precision running out is
 * noticed rather than silently collapsing two books onto one position.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_GAP,
  moveWithin,
  needsRenumber,
  positionBetween,
  renumbered,
  STEP,
} from '../src/lib/library/shelfOrder.ts';

describe('where a dropped book lands', () => {
  it('lands between its two neighbours', () => {
    const at = positionBetween(1, 2);
    assert.ok(at > 1 && at < 2, `expected strictly between, got ${at}`);
    assert.equal(at, 1.5);
  });

  it('lands before the first book when dropped at the top', () => {
    assert.equal(positionBetween(null, 0), -STEP);
    assert.ok(positionBetween(null, 5) < 5);
  });

  it('lands after the last book when dropped at the bottom', () => {
    assert.equal(positionBetween(9, null), 9 + STEP);
    assert.ok(positionBetween(9, null) > 9);
  });

  it('starts somewhere sane on an empty shelf', () => {
    assert.equal(positionBetween(null, null), 0);
  });

  it('stays strictly between across repeated halvings', () => {
    // Dragging into the same gap over and over is the case that eventually
    // runs out of room, so each step has to still be a real gap.
    let before = 0;
    const after = 1;
    for (let i = 0; i < 20; i += 1) {
      const at = positionBetween(before, after);
      assert.ok(at > before && at < after, `halving ${i} collapsed: ${at}`);
      before = at;
    }
  });

  it('handles negative and unordered neighbours without inventing an order', () => {
    assert.equal(positionBetween(-4, -2), -3);
    // Given backwards, the midpoint is still between them.
    const at = positionBetween(2, 1);
    assert.ok(at > 1 && at < 2);
  });
});

describe('noticing when the gaps run out', () => {
  it('says nothing is wrong with ordinary gaps', () => {
    assert.equal(needsRenumber(0, 1), false);
    assert.equal(needsRenumber(0, 0.001), false);
  });

  it('asks for a renumber once the gap is too small to split', () => {
    assert.equal(needsRenumber(0, MIN_GAP), true);
    assert.equal(needsRenumber(1, 1 + MIN_GAP / 2), true);
  });

  it('never asks at the ends of a list, where there is always room', () => {
    assert.equal(needsRenumber(null, 0), false);
    assert.equal(needsRenumber(0, null), false);
    assert.equal(needsRenumber(null, null), false);
  });

  it('spreads a squeezed shelf back out', () => {
    assert.deepEqual(renumbered(4), [0, 1, 2, 3]);
    assert.deepEqual(renumbered(0), []);
    // And the result has room to split again everywhere.
    const spread = renumbered(3);
    assert.equal(needsRenumber(spread[0], spread[1]), false);
  });
});

describe('moving an item within its own shelf', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('moves a book down the shelf', () => {
    // Index read against the list with the dragged item already removed.
    assert.deepEqual(moveWithin(list, 0, 2), ['b', 'c', 'a', 'd']);
  });

  it('moves a book up the shelf', () => {
    assert.deepEqual(moveWithin(list, 3, 1), ['a', 'd', 'b', 'c']);
  });

  it('moves a book to either end', () => {
    assert.deepEqual(moveWithin(list, 2, 0), ['c', 'a', 'b', 'd']);
    assert.deepEqual(moveWithin(list, 0, 3), ['b', 'c', 'd', 'a']);
  });

  it('leaves the list alone when nothing moved', () => {
    assert.deepEqual(moveWithin(list, 1, 1), list);
  });

  it('clamps a drop past the end rather than leaving a hole', () => {
    assert.deepEqual(moveWithin(list, 0, 99), ['b', 'c', 'd', 'a']);
    assert.deepEqual(moveWithin(list, 0, -5), ['a', 'b', 'c', 'd']);
  });

  it('ignores an index that is not in the list', () => {
    assert.deepEqual(moveWithin(list, 9, 0), list);
    assert.deepEqual(moveWithin(list, -1, 0), list);
  });
});
