/**
 * Book identity: recognising a book that has moved, and never guessing.
 *
 * The rule the whole feature turns on is that reconnecting the wrong book
 * moves someone's place, their history and everything they wrote onto a book
 * that is not theirs. There is no undo for that worth the name, so the bar for
 * doing it without asking is deliberately high: exactly one candidate, proved
 * by its content.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_PART_LIMIT,
  couldBeSame,
  planReconnection,
  sampleHash,
  samplePartIndexes,
  sampleRanges,
  shapeOf,
  type BookShape,
  type Candidate,
} from '../src/lib/library/identity.ts';
import { newUuid, pathKeyFor } from '../src/lib/library/ids.ts';
import { rewriteBookIdsToUuids } from '../src/db/identityMigration.ts';

function shape(over: Partial<BookShape> = {}): BookShape {
  const partSizes = over.partSizes ?? [1000, 2000];
  return {
    sizeBytes: over.sizeBytes ?? partSizes.reduce((n, s) => n + s, 0),
    durationSec: over.durationSec ?? 3600,
    partCount: partSizes.length,
    partSizes,
  };
}

const named = (id: string) => ({ id });

function candidate(id: string, over: Partial<BookShape> = {}, hash: string | null = null) {
  return { book: named(id), shape: shape(over), sampleHash: hash } as Candidate<{ id: string }>;
}

describe('a uuid is not a path', () => {
  it('mints something different every time', () => {
    const seen = new Set(Array.from({ length: 500 }, () => newUuid()));
    assert.equal(seen.size, 500);
  });

  it('keys a folder by where it is, so a rescan finds the same row', () => {
    const files = [{ relPath: 'A Book/01.mp3' }];
    assert.equal(pathKeyFor('A Book', files), pathKeyFor('A Book', files));
  });

  it('gives a renamed folder a different key — which is the whole problem', () => {
    const before = pathKeyFor('A Book', [{ relPath: 'A Book/01.mp3' }]);
    const after = pathKeyFor('Series/A Book', [{ relPath: 'Series/A Book/01.mp3' }]);
    assert.notEqual(before, after);
  });

  it('tells apart two books split out of one folder', () => {
    const left = pathKeyFor('Shelf', [{ relPath: 'Shelf/a.mp3' }], { split: true });
    const right = pathKeyFor('Shelf', [{ relPath: 'Shelf/b.mp3' }], { split: true });
    assert.notEqual(left, right);
  });

  it('keys a file loose in the library root without colliding with the root', () => {
    const loose = pathKeyFor('', [{ relPath: 'loose.mp3' }], { split: true });
    const other = pathKeyFor('', [{ relPath: 'another.mp3' }], { split: true });
    assert.notEqual(loose, other);
    assert.notEqual(loose, pathKeyFor('', [], {}));
  });
});

describe('sampling a book', () => {
  it('reads both ends of a part', () => {
    const ranges = sampleRanges(10 * 1024 * 1024);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0].offset, 0);
    assert.equal(ranges[1].offset, 10 * 1024 * 1024 - 64 * 1024);
  });

  it('reads a short part once, whole', () => {
    const ranges = sampleRanges(1000);
    assert.deepEqual(ranges, [{ offset: 0, length: 1000 }]);
  });

  it('reads nothing from an empty part', () => {
    assert.deepEqual(sampleRanges(0), []);
  });

  it('samples every part of a short book', () => {
    assert.deepEqual(samplePartIndexes(3), [0, 1, 2]);
  });

  it('bounds the work on a long one, and always picks both ends', () => {
    const picks = samplePartIndexes(148);
    assert.equal(picks.length, SAMPLE_PART_LIMIT);
    assert.equal(picks[0], 0);
    assert.equal(picks[picks.length - 1], 147);
  });

  it('picks the same parts every time, so a hash is comparable', () => {
    assert.deepEqual(samplePartIndexes(148), samplePartIndexes(148));
  });

  const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

  it('is the same for the same content', () => {
    const samples = [{ partIndex: 0, offset: 0, bytes: bytes(16, 7) }];
    assert.equal(sampleHash([100], samples), sampleHash([100], samples));
  });

  it('changes when the bytes change', () => {
    const left = sampleHash([100], [{ partIndex: 0, offset: 0, bytes: bytes(16, 7) }]);
    const right = sampleHash([100], [{ partIndex: 0, offset: 0, bytes: bytes(16, 8) }]);
    assert.notEqual(left, right);
  });

  it('changes when the parts change, even if the sampled bytes do not', () => {
    const samples = [{ partIndex: 0, offset: 0, bytes: bytes(16, 7) }];
    assert.notEqual(sampleHash([100, 200], samples), sampleHash([100, 300], samples));
  });

  it('notices the same bytes read from a different place', () => {
    const left = sampleHash([100], [{ partIndex: 0, offset: 0, bytes: bytes(16, 7) }]);
    const right = sampleHash([100], [{ partIndex: 0, offset: 64, bytes: bytes(16, 7) }]);
    assert.notEqual(left, right);
  });
});

describe('could two books be the same audio', () => {
  it('yes when the bytes and the parts agree', () => {
    assert.equal(couldBeSame(shape(), shape()), true);
  });

  it('no when a part is a different size', () => {
    assert.equal(couldBeSame(shape(), shape({ partSizes: [1000, 2001] })), false);
  });

  it('no when there are more parts', () => {
    assert.equal(couldBeSame(shape(), shape({ partSizes: [1000, 2000, 3000] })), false);
  });

  it('forgives a second of duration, because tags round differently', () => {
    assert.equal(couldBeSame(shape(), shape({ durationSec: 3601 })), true);
    assert.equal(couldBeSame(shape(), shape({ durationSec: 3700 })), false);
  });

  it('takes the shape from a book without being told the part count', () => {
    const made = shapeOf({ sizeBytes: 300, durationSec: 60, partSizes: [100, 200] });
    assert.equal(made.partCount, 2);
  });
});

describe('deciding whether to reconnect a book that has gone', () => {
  const gone = { shape: shape(), sampleHash: 'abc123' };

  it('reconnects one candidate whose content matches', () => {
    const plan = planReconnection(gone, [candidate('found', {}, 'abc123')]);
    assert.equal(plan.kind, 'reconnect');
    assert.equal(plan.kind === 'reconnect' ? plan.to.id : null, 'found');
  });

  it('asks when the only candidate cannot be proved', () => {
    const plan = planReconnection(gone, [candidate('found', {}, 'different')]);
    assert.equal(plan.kind, 'ask');
    assert.equal(plan.kind === 'ask' ? plan.reason : null, 'unverified');
  });

  it('asks when the candidate was never sampled', () => {
    const plan = planReconnection(gone, [candidate('found', {}, null)]);
    assert.equal(plan.kind, 'ask');
    assert.equal(plan.kind === 'ask' ? plan.reason : null, 'unverified');
  });

  it('asks when the missing book was never sampled', () => {
    const unsampled = { shape: shape(), sampleHash: null };
    const plan = planReconnection(unsampled, [candidate('found', {}, 'abc123')]);
    assert.equal(plan.kind, 'ask');
  });

  it('asks when two candidates have the same shape, even if one matches', () => {
    /*
     * The usual cause is the same rip sitting in two folders. Which one was
     * meant is not something a hash can answer, because both are the same
     * audio — and picking wrongly puts someone's place on the other copy.
     */
    const plan = planReconnection(gone, [
      candidate('left', {}, 'abc123'),
      candidate('right', {}, 'abc123'),
    ]);
    assert.equal(plan.kind, 'ask');
    assert.equal(plan.kind === 'ask' ? plan.reason : null, 'ambiguous');
    assert.equal(plan.kind === 'ask' ? plan.candidates.length : 0, 2);
  });

  it('does nothing at all when nothing resembles it', () => {
    const plan = planReconnection(gone, [candidate('other', { partSizes: [99] }, 'abc123')]);
    assert.equal(plan.kind, 'none');
  });

  it('ignores books of a different shape when counting candidates', () => {
    const plan = planReconnection(gone, [
      candidate('right', {}, 'abc123'),
      candidate('wrong', { partSizes: [5] }, 'abc123'),
    ]);
    assert.equal(plan.kind, 'reconnect');
  });

  it('never reconnects on shape alone, however exact the shape', () => {
    const plan = planReconnection({ shape: shape(), sampleHash: null }, [
      candidate('found', {}, null),
    ]);
    assert.notEqual(plan.kind, 'reconnect');
  });
});

/**
 * The migration, against a database stood in for by a recorder.
 *
 * What matters is not the SQL dialect but that every table naming a book is
 * renamed to the same new id, and that the old id survives as the path key —
 * a half-done rename would leave someone's progress and writing attached to a
 * book that no longer exists.
 */
function fakeDb(bookIds: string[]) {
  const statements: { sql: string; args: unknown[] }[] = [];
  return {
    statements,
    async getAllAsync() {
      return bookIds.map((id) => ({ id }));
    },
    async runAsync(sql: string, ...args: unknown[]) {
      statements.push({ sql, args });
    },
  };
}

describe('migrating path-derived ids to uuids', () => {
  it('renames the book and every reference to it, to the same uuid', async () => {
    const db = fakeDb(['aaaa1111']);
    let n = 0;
    const count = await rewriteBookIdsToUuids(db as never, () => `uuid-${(n += 1)}`);
    assert.equal(count, 1);

    const touched = db.statements.map((s) => s.sql.split(' ')[1]);
    for (const table of ['parts', 'chapters', 'checkouts', 'notes', 'characters', 'books']) {
      assert.ok(touched.includes(table), `${table} was not migrated`);
    }
    for (const statement of db.statements) {
      assert.ok(
        statement.args.includes('uuid-1'),
        `a statement did not carry the new id: ${statement.sql}`,
      );
      assert.ok(
        statement.args.includes('aaaa1111'),
        `a statement did not target the old id: ${statement.sql}`,
      );
    }
  });

  it('keeps the old id as the path key, so a scan still finds the row', async () => {
    const db = fakeDb(['aaaa1111']);
    await rewriteBookIdsToUuids(db as never, () => 'uuid-1');
    const update = db.statements.find((s) => s.sql.includes('UPDATE books SET id'));
    assert.ok(update, 'the book itself was never updated');
    assert.deepEqual(update!.args, ['uuid-1', 'aaaa1111', 'aaaa1111']);
  });

  it('gives every book its own uuid', async () => {
    const db = fakeDb(['one', 'two', 'three']);
    let n = 0;
    const count = await rewriteBookIdsToUuids(db as never, () => `uuid-${(n += 1)}`);
    assert.equal(count, 3);
    const minted = new Set(
      db.statements
        .filter((s) => s.sql.includes('UPDATE books SET id'))
        .map((s) => s.args[0]),
    );
    assert.deepEqual([...minted].sort(), ['uuid-1', 'uuid-2', 'uuid-3']);
  });

  it('does nothing to an empty library', async () => {
    const db = fakeDb([]);
    assert.equal(await rewriteBookIdsToUuids(db as never, () => 'uuid-1'), 0);
    assert.equal(db.statements.length, 0);
  });
});
