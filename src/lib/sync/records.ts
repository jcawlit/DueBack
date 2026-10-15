/**
 * What gets backed up to the drive, and how two copies of it are reconciled.
 *
 * Every record here is something a person made: a note, a character, a tag
 * joining the two, where they are in a book, and when they took it out and
 * brought it back. None of it can be rebuilt by rescanning, which is why it
 * is worth carrying on the drive at all.
 *
 * Reconciliation is last-write-wins with the ties broken deterministically,
 * so two phones that have never met agree on the same answer without
 * negotiating. The only place that is not good enough is a note whose text
 * was edited on both sides, where the loser is kept rather than discarded.
 */

/** Bumped when the shape of these records changes. */
export const SCHEMA_VERSION = 1;

/**
 * The bookkeeping every synced record carries.
 *
 * `updatedAt` decides. `writerDevice` and `mutationId` only break ties — but
 * they have to, because two devices can genuinely write in the same
 * millisecond and "whichever we read last" is not an answer that two phones
 * would reach independently.
 */
export type Stamp = {
  updatedAt: string;
  /** The device that last wrote this record. */
  writerDevice: string;
  /** This particular write. A new one every time, including for an undo. */
  mutationId: string;
  /** Set when the record was deleted. The row stays, as a tombstone. */
  deletedAt?: string | null;
  /**
   * The `updatedAt` both sides last agreed on.
   *
   * What makes a two-sided edit detectable: if both copies have moved on
   * from it, neither is simply newer than the other.
   */
  baseUpdatedAt?: string | null;
};

export type NoteRecord = Stamp & {
  id: string;
  bookId: string;
  positionSec: number;
  chapterIndex: number;
  text: string;
  createdAt: string;
  /** Set on the copy kept when both sides edited the same note. */
  conflictOf?: string | null;
};

export type CharacterRecord = Stamp & {
  id: string;
  bookId: string;
  name: string;
  aliases: string;
  bio: string;
  createdAt: string;
};

export type TagRecord = Stamp & {
  noteId: string;
  characterId: string;
};

export type ProgressRecord = Stamp & {
  bookId: string;
  positionSec: number;
  finishedAt?: string | null;
};

/**
 * Who a book is, so a fresh install can attach the writing to it.
 *
 * Without this the restore promise cannot be kept: a phone that has never
 * seen this library mints a new uuid for every book it scans, and notes keyed
 * to the old uuids would have nothing to belong to. The path key is what
 * joins them — the drive says "the book at this path is this uuid", and the
 * scan takes it at its word.
 *
 * The shape travels too, so a book whose folder was renamed between the
 * backup and the restore can still be recognised.
 */
export type BookIdentityRecord = Stamp & {
  id: string;
  pathKey: string;
  title: string;
  author: string;
  sizeBytes: number;
  durationSec: number;
  partSizes: number[];
  sampleHash: string | null;
};

export type HistoryRecord = Stamp & {
  id: string;
  bookId: string;
  outAt: string;
  backAt?: string | null;
};

/** Everything one generation carries. */
export type SyncPayload = {
  /** Who the books are. Read by a scan, never written by one. */
  identity: BookIdentityRecord[];
  notes: NoteRecord[];
  characters: CharacterRecord[];
  tags: TagRecord[];
  progress: ProgressRecord[];
  history: HistoryRecord[];
};

export function emptyPayload(): SyncPayload {
  return { identity: [], notes: [], characters: [], tags: [], progress: [], history: [] };
}

/** The key two copies of a record are matched on. */
export const keyOf = {
  identity: (r: BookIdentityRecord) => r.id,
  note: (r: NoteRecord) => r.id,
  character: (r: CharacterRecord) => r.id,
  tag: (r: TagRecord) => `${r.noteId}\u0000${r.characterId}`,
  progress: (r: ProgressRecord) => r.bookId,
  history: (r: HistoryRecord) => r.id,
};

/**
 * Which of two writes happened later.
 *
 * Time first. When two devices wrote in the same millisecond the clock has
 * nothing more to say, so the tie is broken on the writer's id and then on
 * the mutation — arbitrary, but arbitrary in a way both sides compute
 * identically, which is the whole requirement.
 */
export function laterOf<T extends Stamp>(left: T, right: T): T {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? left : right;
  }
  if (left.writerDevice !== right.writerDevice) {
    return left.writerDevice > right.writerDevice ? left : right;
  }
  if (left.mutationId !== right.mutationId) {
    return left.mutationId > right.mutationId ? left : right;
  }
  return left;
}

/** Whether a record is a tombstone. */
export function isDeleted(record: Stamp): boolean {
  return !!record.deletedAt;
}

/**
 * Both sides changed this record since they last agreed.
 *
 * Needs a recorded agreement to be sure: with no `baseUpdatedAt` there is no
 * way to tell a two-sided edit from one side simply being behind, and
 * guessing "conflict" would litter the margins with copies.
 */
function bothMovedOn(mine: Stamp, theirs: Stamp): boolean {
  const bases = [mine.baseUpdatedAt, theirs.baseUpdatedAt].filter((x): x is string => !!x);
  const base = bases.sort()[0];
  if (!base) return false;
  return mine.updatedAt > base && theirs.updatedAt > base;
}

/**
 * The id of the copy kept when a note was edited on both sides.
 *
 * Derived from the original note and the losing write, so syncing the same
 * pair of edits again produces the same id and finds the copy already there,
 * rather than making another one each time the drive is plugged in.
 */
export function conflictedCopyId(originalId: string, losingMutationId: string): string {
  return `${originalId}~conflict~${losingMutationId}`;
}

export type NoteMerge = {
  winner: NoteRecord;
  /** Present when the losing text was worth keeping as its own note. */
  conflicted?: NoteRecord;
};

/**
 * Merges one note.
 *
 * Last write wins, except where both sides edited the text since they last
 * agreed. Then the loser becomes a note of its own, marked as a conflicted
 * copy, at the same position in the same book — because the alternative is
 * deleting a sentence somebody wrote, and no sync is confident enough to earn
 * that.
 *
 * A deletion is just another write: deleting on one side while editing on the
 * other is settled by the clock like anything else.
 */
export function mergeNote(mine: NoteRecord, theirs: NoteRecord): NoteMerge {
  const winner = laterOf(mine, theirs);
  const loser = winner === mine ? theirs : mine;

  const textDiverged = mine.text !== theirs.text;
  const bothEdited = bothMovedOn(mine, theirs);
  const worthKeeping =
    textDiverged &&
    bothEdited &&
    !isDeleted(loser) &&
    loser.text.trim().length > 0 &&
    // A conflicted copy of a conflicted copy helps nobody.
    !loser.conflictOf;

  if (!worthKeeping) return { winner };

  return {
    winner,
    conflicted: {
      ...loser,
      id: conflictedCopyId(mine.id, loser.mutationId),
      conflictOf: mine.id,
      // The copy is settled: it carries the write that made it, so syncing
      // the same pair again recognises it rather than making another.
      baseUpdatedAt: loser.updatedAt,
    },
  };
}

/** Merges two sides of one record type, keyed by `key`. */
function mergeBy<T extends Stamp>(
  mine: T[],
  theirs: T[],
  key: (record: T) => string,
): T[] {
  const merged = new Map<string, T>();
  for (const record of mine) merged.set(key(record), record);
  for (const record of theirs) {
    const existing = merged.get(key(record));
    merged.set(key(record), existing ? laterOf(existing, record) : record);
  }
  return [...merged.values()];
}

/**
 * Brings two copies of the backed-up set together.
 *
 * Order does not matter and neither does which side is called which: the
 * result of merging A into B is the result of merging B into A, which is what
 * lets two phones reach the same answer without talking to each other.
 */
export function mergePayloads(mine: SyncPayload, theirs: SyncPayload): SyncPayload {
  const notes = new Map<string, NoteRecord>();
  const conflicts: NoteRecord[] = [];

  for (const note of mine.notes) notes.set(note.id, note);
  for (const note of theirs.notes) {
    const existing = notes.get(note.id);
    if (!existing) {
      notes.set(note.id, note);
      continue;
    }
    const result = mergeNote(existing, note);
    notes.set(note.id, result.winner);
    if (result.conflicted) conflicts.push(result.conflicted);
  }

  // A conflicted copy that already exists on either side is left alone: its
  // id is derived from the write that caused it, so this is the same note.
  for (const copy of conflicts) {
    if (!notes.has(copy.id)) notes.set(copy.id, copy);
  }

  const identity = mergeBy(mine.identity, theirs.identity, keyOf.identity);
  const characters = mergeBy(mine.characters, theirs.characters, keyOf.character);
  const tags = mergeBy(mine.tags, theirs.tags, keyOf.tag);
  const history = mergeBy(mine.history, theirs.history, keyOf.history);
  /*
   * Progress is the latest position, not the furthest. Rewinding to hear
   * something again is a decision, and a sync that "helpfully" restored the
   * furthest point would undo it every time the drive was plugged in.
   */
  const progress = mergeBy(mine.progress, theirs.progress, keyOf.progress);

  return {
    identity,
    notes: [...notes.values()],
    characters,
    tags,
    progress,
    history,
  };
}

/**
 * Tags whose note or character has been deleted are suppressed.
 *
 * The tag rows stay — a tombstone is cheaper than working out who deleted
 * what — but nothing should read a tag pointing at a note that is gone.
 */
export function liveTags(payload: SyncPayload): TagRecord[] {
  const deadNotes = new Set(payload.notes.filter(isDeleted).map((n) => n.id));
  const deadCharacters = new Set(payload.characters.filter(isDeleted).map((c) => c.id));
  return payload.tags.filter(
    (tag) =>
      !isDeleted(tag) && !deadNotes.has(tag.noteId) && !deadCharacters.has(tag.characterId),
  );
}
