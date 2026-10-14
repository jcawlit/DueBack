/**
 * Backing reading data up to the drive, and bringing two copies together.
 *
 * Two properties matter more than the rest and most of this file is about
 * them. A generation is only ever used when the whole of it validates, so a
 * write interrupted anywhere leaves the previous one intact. And a merge is
 * decided the same way whichever side runs it, so two phones that have never
 * met agree without negotiating.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION,
  conflictedCopyId,
  emptyPayload,
  laterOf,
  liveTags,
  mergeNote,
  mergePayloads,
  type CharacterRecord,
  type HistoryRecord,
  type NoteRecord,
  type ProgressRecord,
  type SyncPayload,
  type TagRecord,
} from '../src/lib/sync/records.ts';
import {
  buildGeneration,
  checksum,
  folderNameFor,
  generationOf,
  prunable,
  validateGeneration,
  type PartFile,
} from '../src/lib/sync/generations.ts';

const LIB = 'lib-1';

function note(over: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: 'n1',
    bookId: 'b1',
    positionSec: 100,
    chapterIndex: 0,
    text: 'a note',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    writerDevice: 'phone-a',
    mutationId: 'm1',
    ...over,
  };
}

function character(over: Partial<CharacterRecord> = {}): CharacterRecord {
  return {
    id: 'c1',
    bookId: 'b1',
    name: 'Logen',
    aliases: '',
    bio: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    writerDevice: 'phone-a',
    mutationId: 'm1',
    ...over,
  };
}

function tag(over: Partial<TagRecord> = {}): TagRecord {
  return {
    noteId: 'n1',
    characterId: 'c1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    writerDevice: 'phone-a',
    mutationId: 'm1',
    ...over,
  };
}

function progress(over: Partial<ProgressRecord> = {}): ProgressRecord {
  return {
    bookId: 'b1',
    positionSec: 100,
    updatedAt: '2026-01-01T00:00:00.000Z',
    writerDevice: 'phone-a',
    mutationId: 'm1',
    ...over,
  };
}

function history(over: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: 'h1',
    bookId: 'b1',
    outAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    writerDevice: 'phone-a',
    mutationId: 'm1',
    ...over,
  };
}

function payload(over: Partial<SyncPayload> = {}): SyncPayload {
  return { ...emptyPayload(), ...over };
}

describe('which write happened later', () => {
  it('is the newer timestamp', () => {
    const older = note({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const newer = note({ updatedAt: '2026-02-01T00:00:00.000Z' });
    assert.equal(laterOf(older, newer), newer);
    assert.equal(laterOf(newer, older), newer);
  });

  it('breaks an exact tie on the writer, the same way on both phones', () => {
    const left = note({ writerDevice: 'phone-a', mutationId: 'm1' });
    const right = note({ writerDevice: 'phone-b', mutationId: 'm2' });
    assert.equal(laterOf(left, right), right);
    assert.equal(laterOf(right, left), right, 'the answer depended on the order');
  });

  it('breaks a tie between one device’s two writes on the mutation', () => {
    const left = note({ mutationId: 'm1' });
    const right = note({ mutationId: 'm2' });
    assert.equal(laterOf(left, right).mutationId, 'm2');
    assert.equal(laterOf(right, left).mutationId, 'm2');
  });
});

describe('merging notes', () => {
  it('takes the newer text when only one side changed', () => {
    const mine = note({ text: 'original' });
    const theirs = note({ text: 'edited', updatedAt: '2026-03-01T00:00:00.000Z' });
    const result = mergeNote(mine, theirs);
    assert.equal(result.winner.text, 'edited');
    assert.equal(result.conflicted, undefined);
  });

  it('keeps the losing text when both sides edited since they agreed', () => {
    const base = '2026-01-01T00:00:00.000Z';
    const mine = note({
      text: 'mine',
      updatedAt: '2026-02-01T00:00:00.000Z',
      baseUpdatedAt: base,
      mutationId: 'mine-1',
    });
    const theirs = note({
      text: 'theirs',
      updatedAt: '2026-03-01T00:00:00.000Z',
      baseUpdatedAt: base,
      mutationId: 'theirs-1',
    });
    const result = mergeNote(mine, theirs);
    assert.equal(result.winner.text, 'theirs');
    assert.equal(result.conflicted?.text, 'mine');
    assert.equal(result.conflicted?.conflictOf, 'n1');
    assert.equal(result.conflicted?.bookId, 'b1');
    assert.equal(result.conflicted?.positionSec, 100);
  });

  it('gives the kept copy an id derived from the write that caused it', () => {
    assert.equal(conflictedCopyId('n1', 'mine-1'), 'n1~conflict~mine-1');
  });

  it('makes no copy when neither side has moved on from an agreement', () => {
    // Nothing recorded as agreed: one side is simply behind the other.
    const mine = note({ text: 'mine', updatedAt: '2026-02-01T00:00:00.000Z' });
    const theirs = note({ text: 'theirs', updatedAt: '2026-03-01T00:00:00.000Z' });
    assert.equal(mergeNote(mine, theirs).conflicted, undefined);
  });

  it('makes no copy of an empty losing note', () => {
    const base = '2026-01-01T00:00:00.000Z';
    const mine = note({ text: '   ', updatedAt: '2026-02-01T00:00:00.000Z', baseUpdatedAt: base });
    const theirs = note({ text: 'kept', updatedAt: '2026-03-01T00:00:00.000Z', baseUpdatedAt: base });
    assert.equal(mergeNote(mine, theirs).conflicted, undefined);
  });

  it('makes no copy when the loser was deleted', () => {
    const base = '2026-01-01T00:00:00.000Z';
    const mine = note({
      text: 'gone',
      updatedAt: '2026-02-01T00:00:00.000Z',
      baseUpdatedAt: base,
      deletedAt: '2026-02-01T00:00:00.000Z',
    });
    const theirs = note({ text: 'kept', updatedAt: '2026-03-01T00:00:00.000Z', baseUpdatedAt: base });
    assert.equal(mergeNote(mine, theirs).conflicted, undefined);
  });

  it('creates the conflicted copy once, however many times it is synced', () => {
    const base = '2026-01-01T00:00:00.000Z';
    const mine = note({
      text: 'mine',
      updatedAt: '2026-02-01T00:00:00.000Z',
      baseUpdatedAt: base,
      mutationId: 'mine-1',
    });
    const theirs = note({
      text: 'theirs',
      updatedAt: '2026-03-01T00:00:00.000Z',
      baseUpdatedAt: base,
      mutationId: 'theirs-1',
    });

    const first = mergePayloads(payload({ notes: [mine] }), payload({ notes: [theirs] }));
    assert.equal(first.notes.length, 2);

    // And again, with the merged set on one side — the drive being plugged
    // in a second time must not produce a second copy.
    const second = mergePayloads(first, payload({ notes: [theirs] }));
    assert.equal(second.notes.length, 2, 'a second copy appeared on the next sync');
    const third = mergePayloads(second, first);
    assert.equal(third.notes.length, 2, 'a third copy appeared');
  });
});

describe('merging the whole set', () => {
  it('keeps records only one side has ever seen', () => {
    const merged = mergePayloads(
      payload({ notes: [note({ id: 'mine' })] }),
      payload({ notes: [note({ id: 'theirs' })] }),
    );
    assert.deepEqual(merged.notes.map((n) => n.id).sort(), ['mine', 'theirs']);
  });

  it('reaches the same answer whichever side runs it', () => {
    const a = payload({
      notes: [note({ id: 'n1', text: 'a', updatedAt: '2026-02-01T00:00:00.000Z' })],
      characters: [character({ bio: 'from a', updatedAt: '2026-02-01T00:00:00.000Z' })],
      progress: [progress({ positionSec: 50, updatedAt: '2026-02-01T00:00:00.000Z' })],
    });
    const b = payload({
      notes: [note({ id: 'n1', text: 'b', updatedAt: '2026-03-01T00:00:00.000Z' })],
      characters: [character({ bio: 'from b', updatedAt: '2026-01-01T00:00:00.000Z' })],
      progress: [progress({ positionSec: 10, updatedAt: '2026-03-01T00:00:00.000Z' })],
    });
    const left = mergePayloads(a, b);
    const right = mergePayloads(b, a);
    assert.deepEqual(left.notes, right.notes);
    assert.deepEqual(left.characters, right.characters);
    assert.deepEqual(left.progress, right.progress);
  });

  it('keeps a tombstone for every record type', () => {
    const gone = '2026-05-01T00:00:00.000Z';
    const merged = mergePayloads(
      payload({
        notes: [note()],
        characters: [character()],
        tags: [tag()],
        history: [history()],
        progress: [progress()],
      }),
      payload({
        notes: [note({ deletedAt: gone, updatedAt: gone })],
        characters: [character({ deletedAt: gone, updatedAt: gone })],
        tags: [tag({ deletedAt: gone, updatedAt: gone })],
        history: [history({ deletedAt: gone, updatedAt: gone })],
        progress: [progress({ deletedAt: gone, updatedAt: gone })],
      }),
    );
    assert.equal(merged.notes[0].deletedAt, gone);
    assert.equal(merged.characters[0].deletedAt, gone);
    assert.equal(merged.tags[0].deletedAt, gone);
    assert.equal(merged.history[0].deletedAt, gone);
    assert.equal(merged.progress[0].deletedAt, gone);
  });

  it('does not resurrect a deleted note just because the other side is older', () => {
    const merged = mergePayloads(
      payload({ notes: [note({ text: 'still here' })] }),
      payload({ notes: [note({ deletedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' })] }),
    );
    assert.ok(merged.notes[0].deletedAt);
  });

  it('brings a note back when the undo is the newer write', () => {
    // Undo is a write like any other, with a newer stamp.
    const merged = mergePayloads(
      payload({ notes: [note({ deletedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' })] }),
      payload({ notes: [note({ deletedAt: null, updatedAt: '2026-06-02T00:00:00.000Z', mutationId: 'undo' })] }),
    );
    assert.equal(merged.notes[0].deletedAt, null);
  });

  it('keeps every checkout of one book, not just the last', () => {
    const merged = mergePayloads(
      payload({
        history: [
          history({ id: 'h1', outAt: '2026-01-01T00:00:00.000Z' }),
          history({ id: 'h2', outAt: '2026-02-01T00:00:00.000Z' }),
        ],
      }),
      payload({
        history: [
          history({ id: 'h2', outAt: '2026-02-01T00:00:00.000Z' }),
          history({ id: 'h3', outAt: '2026-03-01T00:00:00.000Z' }),
        ],
      }),
    );
    assert.deepEqual(merged.history.map((h) => h.id).sort(), ['h1', 'h2', 'h3']);
  });

  it('takes the latest position, not the furthest — a rewind is a decision', () => {
    const merged = mergePayloads(
      payload({ progress: [progress({ positionSec: 7200, updatedAt: '2026-01-01T00:00:00.000Z' })] }),
      payload({ progress: [progress({ positionSec: 60, updatedAt: '2026-02-01T00:00:00.000Z' })] }),
    );
    assert.equal(merged.progress[0].positionSec, 60);
  });

  it('matches tags on the pair they join', () => {
    const merged = mergePayloads(
      payload({ tags: [tag({ noteId: 'n1', characterId: 'c1' })] }),
      payload({ tags: [tag({ noteId: 'n1', characterId: 'c2' })] }),
    );
    assert.equal(merged.tags.length, 2);
  });

  it('suppresses the tags of a deleted note or character', () => {
    const gone = '2026-05-01T00:00:00.000Z';
    const set = payload({
      notes: [note({ id: 'n1' }), note({ id: 'n2', deletedAt: gone })],
      characters: [character({ id: 'c1' }), character({ id: 'c2', deletedAt: gone })],
      tags: [
        tag({ noteId: 'n1', characterId: 'c1' }),
        tag({ noteId: 'n2', characterId: 'c1' }),
        tag({ noteId: 'n1', characterId: 'c2' }),
        tag({ noteId: 'n1', characterId: 'c1', deletedAt: gone }),
      ],
    });
    const live = liveTags(set);
    assert.equal(live.length, 1);
    assert.equal(live[0].noteId, 'n1');
    assert.equal(live[0].characterId, 'c1');
  });
});

describe('the identity manifest, which makes a restore possible', () => {
  const book = (over: Partial<import('../src/lib/sync/records.ts').BookIdentityRecord> = {}) => ({
    id: 'book-uuid',
    pathKey: 'abcd1234',
    title: 'A Book',
    author: 'An Author',
    sizeBytes: 1000,
    durationSec: 3600,
    sampleHash: 'hash',
    partSizes: [1000],
    updatedAt: '2026-01-01T00:00:00.000Z',
    writerDevice: 'phone-a',
    mutationId: 'm1',
    ...over,
  });

  it('travels with the rest of the set', () => {
    const merged = mergePayloads(
      payload({ identity: [book()] }),
      payload({ identity: [book({ id: 'other', pathKey: 'ffff0000' })] }),
    );
    assert.deepEqual(merged.identity.map((b) => b.id).sort(), ['book-uuid', 'other']);
  });

  it('carries the path key a fresh install would look a book up by', () => {
    const merged = mergePayloads(payload(), payload({ identity: [book()] }));
    assert.equal(merged.identity[0].pathKey, 'abcd1234');
    assert.equal(merged.identity[0].id, 'book-uuid');
  });

  it('takes the newer record when a book was re-indexed on one side', () => {
    const merged = mergePayloads(
      payload({ identity: [book({ pathKey: 'old' })] }),
      payload({ identity: [book({ pathKey: 'moved', updatedAt: '2026-06-01T00:00:00.000Z' })] }),
    );
    assert.equal(merged.identity[0].pathKey, 'moved');
  });
});

describe('generations on a drive that cannot rename', () => {
  const device = 'phone-a';
  const full = payload({
    notes: [note()],
    characters: [character()],
    tags: [tag()],
    progress: [progress()],
    history: [history()],
  });

  const built = buildGeneration(full, { libraryId: LIB, generation: 3, writerDevice: device });
  const filesOf = (parts: PartFile[]) =>
    Object.fromEntries(parts.map((p) => [p.part, p])) as Record<string, PartFile>;

  it('names and reads back a generation folder', () => {
    assert.equal(folderNameFor(7), 'gen-7');
    assert.equal(generationOf('gen-7'), 7);
    assert.equal(generationOf('gen-x'), null);
    assert.equal(generationOf('notes'), null);
  });

  it('writes every part, each stamped with the library and generation', () => {
    assert.equal(built.parts.length, 6);
    for (const part of built.parts) {
      assert.equal(part.libraryId, LIB);
      assert.equal(part.generation, 3);
      assert.equal(part.schemaVersion, SCHEMA_VERSION);
      assert.equal(part.writerDevice, device);
    }
  });

  it('validates a complete, untouched generation', () => {
    const result = validateGeneration(LIB, built.manifest, filesOf(built.parts));
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.payload.notes.length : -1, 1);
  });

  it('refuses a generation with a part missing — half a backup is not a backup', () => {
    const files = filesOf(built.parts);
    delete (files as Record<string, unknown>).tags;
    const result = validateGeneration(LIB, built.manifest, files);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, 'missing-part');
  });

  it('refuses a part whose contents changed under it', () => {
    const files = filesOf(built.parts);
    files.notes = { ...files.notes, data: [note({ text: 'tampered' })] };
    const result = validateGeneration(LIB, built.manifest, files);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, 'checksum');
  });

  it('refuses a manifest that does not match itself', () => {
    const manifest = { ...built.manifest, checksum: 'deadbeef' };
    const result = validateGeneration(LIB, manifest, filesOf(built.parts));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, 'checksum');
  });

  it('refuses a part left behind by an older generation', () => {
    const files = filesOf(built.parts);
    files.history = { ...files.history, generation: 2 };
    const result = validateGeneration(LIB, built.manifest, files);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, 'missing-part');
  });

  it('refuses another library’s backup', () => {
    const result = validateGeneration('another-library', built.manifest, filesOf(built.parts));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, 'wrong-library');
  });

  it('refuses, and names, a generation written by a newer app', () => {
    const manifest = { ...built.manifest, schemaVersion: SCHEMA_VERSION + 1 };
    const result = validateGeneration(LIB, manifest, filesOf(built.parts));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, 'newer-schema');
  });

  it('notices a manifest that was never written', () => {
    const result = validateGeneration(LIB, null, filesOf(built.parts));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason : null, 'missing-manifest');
  });

  it('checksums the data, so a truncated file is not mistaken for an empty one', () => {
    assert.notEqual(checksum(JSON.stringify([note()])), checksum(JSON.stringify([])));
  });
});

describe('pruning older generations', () => {
  it('removes nothing when nothing newer has validated', () => {
    assert.deepEqual(prunable([1, 2, 3], []), []);
  });

  it('keeps the newest two complete generations', () => {
    assert.deepEqual(prunable([1, 2, 3, 4], [4, 3, 2, 1]), [1, 2]);
  });

  it('never removes anything newer than the newest it could validate', () => {
    /*
     * A generation newer than the one we trust is either a write in flight or
     * a schema this app does not understand. Both must be left alone.
     */
    assert.deepEqual(prunable([1, 2, 3, 9], [2, 1]), []);
  });

  it('keeps a generation that did not validate if it is newer than the good one', () => {
    assert.deepEqual(prunable([1, 2, 3], [2]), []);
  });

  it('removes an older generation that failed to validate', () => {
    assert.deepEqual(prunable([1, 2, 3], [3, 2]), [1]);
  });
});
