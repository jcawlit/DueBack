/**
 * Shelves travelling between two copies of the backup.
 *
 * Plain last-write-wins, unlike notes: a note holds sentences somebody
 * composed, so a two-sided edit keeps a conflicted copy rather than losing
 * writing. A shelf holds a name and an order, and the newer answer to "what
 * is this shelf called" is simply the answer.
 *
 * The case that matters most here is the oldest one: a generation already
 * sitting on a drive was written by a build that had never heard of shelves,
 * and reading one is how a restore works.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyPayload,
  isDeleted,
  laterOf,
  mergePayloads,
  type ShelfBookRecord,
  type ShelfRecord,
  type SyncPayload,
} from '../src/lib/sync/records.ts';

function shelf(over: Partial<ShelfRecord> = {}): ShelfRecord {
  return {
    id: 'sh-1',
    sourceId: null,
    name: 'Sci-fi',
    position: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    writerDevice: 'phone-a',
    mutationId: 'mut-a',
    ...over,
  };
}

function placed(over: Partial<ShelfBookRecord> = {}): ShelfBookRecord {
  return {
    bookId: 'book-1',
    shelfId: 'sh-1',
    position: 0,
    updatedAt: '2026-11-01T00:00:00.000Z',
    writerDevice: 'phone-a',
    mutationId: 'mut-a',
    ...over,
  };
}

const payload = (over: Partial<SyncPayload> = {}): SyncPayload => ({
  ...emptyPayload(),
  ...over,
});

describe('merging shelves', () => {
  it('takes the newer name, whichever side it is on', () => {
    const mine = payload({ shelves: [shelf({ name: 'Sci-fi' })] });
    const theirs = payload({
      shelves: [shelf({ name: 'Science fiction', updatedAt: '2026-11-02T00:00:00.000Z', writerDevice: 'phone-b' })],
    });

    assert.equal(mergePayloads(mine, theirs).shelves[0].name, 'Science fiction');
    // And the other way round, because order must not matter.
    assert.equal(mergePayloads(theirs, mine).shelves[0].name, 'Science fiction');
  });

  it('keeps a renamed shelf rather than making a second one', () => {
    const mine = payload({ shelves: [shelf({ name: 'Sci-fi' })] });
    const theirs = payload({
      shelves: [shelf({ name: 'Re-reads', updatedAt: '2026-11-03T00:00:00.000Z' })],
    });
    const merged = mergePayloads(mine, theirs);
    assert.equal(merged.shelves.length, 1, 'one shelf, one name');
  });

  it('settles where a book goes when two phones disagree', () => {
    // Keyed on the book, so it lands on one shelf rather than both.
    const mine = payload({ shelfBooks: [placed({ shelfId: 'sh-1' })] });
    const theirs = payload({
      shelfBooks: [placed({ shelfId: 'sh-2', updatedAt: '2026-11-04T00:00:00.000Z' })],
    });
    const merged = mergePayloads(mine, theirs);
    assert.equal(merged.shelfBooks.length, 1);
    assert.equal(merged.shelfBooks[0].shelfId, 'sh-2');
  });

  it('carries a deleted shelf as a tombstone, so the deletion travels', () => {
    const mine = payload({ shelves: [shelf()] });
    const theirs = payload({
      shelves: [shelf({ deletedAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' })],
    });
    const merged = mergePayloads(mine, theirs);
    assert.equal(merged.shelves.length, 1, 'the row stays');
    assert.ok(isDeleted(merged.shelves[0]), 'and it is a tombstone');
  });

  it('breaks a same-millisecond tie the same way on both phones', () => {
    const at = '2026-11-06T00:00:00.000Z';
    const a = shelf({ name: 'A', updatedAt: at, writerDevice: 'phone-a' });
    const b = shelf({ name: 'B', updatedAt: at, writerDevice: 'phone-b' });
    // The clock has nothing to say, so the writer decides — identically on
    // both sides, which is the whole requirement.
    assert.equal(laterOf(a, b).name, laterOf(b, a).name);
    assert.equal(mergePayloads(payload({ shelves: [a] }), payload({ shelves: [b] })).shelves[0].name,
      mergePayloads(payload({ shelves: [b] }), payload({ shelves: [a] })).shelves[0].name);
  });
});

describe('a backup written before shelves existed', () => {
  it('merges without throwing, and keeps the side that has them', () => {
    /*
     * The real case: every `.dueback` generation already on a drive. The
     * fields are simply absent from the JSON, and a restore reads one.
     */
    const old = JSON.parse(
      JSON.stringify({
        identity: [], notes: [], characters: [], tags: [], progress: [], history: [],
      }),
    ) as SyncPayload;
    const mine = payload({ shelves: [shelf()], shelfBooks: [placed()] });

    const merged = mergePayloads(mine, old);
    assert.equal(merged.shelves.length, 1, 'mine survive an old drive');
    assert.equal(merged.shelfBooks.length, 1);

    // And from the other direction, which is what a fresh install reads.
    const back = mergePayloads(old, mine);
    assert.equal(back.shelves.length, 1);
    assert.equal(back.shelfBooks.length, 1);
  });

  it('merges two old payloads to an empty pair rather than undefined', () => {
    // Cast through `unknown`: the point is that these two fields are absent,
    // which is exactly what the type says cannot happen.
    const old = {
      identity: [], notes: [], characters: [], tags: [], progress: [], history: [],
    } as unknown as SyncPayload;
    const merged = mergePayloads(old, old);
    assert.deepEqual(merged.shelves, []);
    assert.deepEqual(merged.shelfBooks, []);
  });
});
