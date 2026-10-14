/**
 * What makes a book that book, once a path stops being allowed to say so.
 *
 * A path locates a book; it does not identify one. Rename the folder, move it
 * into a series folder, or point the app at the same drive through a different
 * mount, and a path-derived id makes a stranger of a book someone is halfway
 * through — taking their place, their history and everything they wrote in the
 * margins with it.
 *
 * So identity is a uuid, minted once and kept. Everything here is the
 * machinery for recognising a book that has moved: a cheap shape (size,
 * duration, part count and the sizes of the parts) that narrows the field to
 * candidates, and a content sample that proves one of them.
 *
 * The shape alone is never proof. Two files of the same length are the same
 * length; that is all it says.
 */

/** Bumped when the sample recipe changes, so old hashes are not compared to new. */
export const SAMPLE_VERSION = 1;

/** How much is read from each end of a sampled part. */
export const SAMPLE_BYTES = 64 * 1024;

/**
 * How many parts are sampled, at most.
 *
 * Every part would be the thorough answer and is the wrong one: a 148-part
 * book would mean 19 MB of reading on a USB drive, on every first index, to
 * guard against a case the part-size list already all but rules out. Four
 * parts bounds it at half a megabyte, and which four is deterministic so the
 * same book always samples the same way.
 */
export const SAMPLE_PART_LIMIT = 4;

/** The parts to sample, by index: the ends first, then spread through. */
export function samplePartIndexes(partCount: number): number[] {
  if (partCount <= 0) return [];
  if (partCount <= SAMPLE_PART_LIMIT) {
    return Array.from({ length: partCount }, (_, i) => i);
  }
  const picks = new Set<number>([0, partCount - 1]);
  // Evenly spaced through the middle, so a box set samples more than one disc.
  for (let i = 1; picks.size < SAMPLE_PART_LIMIT; i += 1) {
    picks.add(Math.floor((i * partCount) / SAMPLE_PART_LIMIT));
  }
  return [...picks].sort((a, b) => a - b).slice(0, SAMPLE_PART_LIMIT);
}

/** The byte ranges to read from a part of `sizeBytes`. */
export function sampleRanges(sizeBytes: number): { offset: number; length: number }[] {
  if (sizeBytes <= 0) return [];
  if (sizeBytes <= SAMPLE_BYTES * 2) return [{ offset: 0, length: sizeBytes }];
  return [
    { offset: 0, length: SAMPLE_BYTES },
    { offset: sizeBytes - SAMPLE_BYTES, length: SAMPLE_BYTES },
  ];
}

/**
 * FNV-1a over bytes, twice with different offsets, rendered as 16 hex digits.
 *
 * Not a cryptographic hash and not trying to be: this proves that a candidate
 * found by size and duration really is the same audio, against accident rather
 * than against anyone's malice.
 */
function fnv1aBytes(bytes: Uint8Array, seed: number, h0: number): number {
  let h = h0;
  h ^= seed;
  h = Math.imul(h, 0x01000193);
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fnv1aText(text: string, h0: number): number {
  let h = h0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Folds the sampled bytes and the book's shape into one value.
 *
 * The part sizes go in as well as the bytes, so two books whose sampled ranges
 * happen to agree are still told apart by the parts in between.
 */
export function sampleHash(
  partSizes: number[],
  samples: { partIndex: number; offset: number; bytes: Uint8Array }[],
): string {
  let a = fnv1aText(`v${SAMPLE_VERSION}:${partSizes.join(',')}`, 0x811c9dc5);
  let b = fnv1aText(`v${SAMPLE_VERSION}:${partSizes.length}`, 0x01000193);
  for (const sample of samples) {
    a = fnv1aBytes(sample.bytes, sample.partIndex + 1, a);
    b = fnv1aBytes(sample.bytes, sample.offset + 1, b);
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** The cheap shape of a book: everything knowable without reading audio. */
export type BookShape = {
  sizeBytes: number;
  durationSec: number;
  partCount: number;
  /** In playback order. */
  partSizes: number[];
};

export function shapeOf(book: {
  sizeBytes: number;
  durationSec: number;
  partSizes: number[];
}): BookShape {
  return {
    sizeBytes: book.sizeBytes,
    durationSec: book.durationSec,
    partCount: book.partSizes.length,
    partSizes: book.partSizes,
  };
}

/** Duration is read from tags and wanders by a second between rips. */
const DURATION_TOLERANCE_SEC = 2;

/**
 * Whether two books could be the same audio.
 *
 * Deliberately strict about bytes and forgiving about seconds: a byte count is
 * a fact, while a duration is whatever the tags claimed and is rounded
 * differently by different tools.
 */
export function couldBeSame(left: BookShape, right: BookShape): boolean {
  if (left.partCount !== right.partCount) return false;
  if (left.sizeBytes !== right.sizeBytes) return false;
  if (Math.abs(left.durationSec - right.durationSec) > DURATION_TOLERANCE_SEC) return false;
  for (let i = 0; i < left.partSizes.length; i += 1) {
    if (left.partSizes[i] !== right.partSizes[i]) return false;
  }
  return true;
}

export type Candidate<T> = { book: T; shape: BookShape; sampleHash: string | null };

export type Reconnection<T> =
  /** One candidate, and its content proves it. Safe to do without asking. */
  | { kind: 'reconnect'; to: T }
  /** Something plausible, but not proven. The user decides. */
  | { kind: 'ask'; candidates: T[]; reason: 'unverified' | 'ambiguous' }
  /** Nothing resembles it. A new book, and the old one stays missing. */
  | { kind: 'none' };

/**
 * What to do with a book that has gone, given the books newly found.
 *
 * The rule the whole feature turns on: **reconnect without asking only when
 * there is exactly one candidate and its content sample matches.** Everything
 * else asks. Merging two books that are not the same book silently moves one
 * person's place, history and notes onto another's book, and there is no undo
 * for that worth the name.
 */
export function planReconnection<T>(
  missing: { shape: BookShape; sampleHash: string | null },
  found: Candidate<T>[],
): Reconnection<T> {
  const candidates = found.filter((c) => couldBeSame(missing.shape, c.shape));
  if (candidates.length === 0) return { kind: 'none' };

  if (candidates.length > 1) {
    /*
     * More than one match by shape. Even if exactly one also matches by
     * content, the others are identical enough that a wrong answer is
     * plausible — a duplicate of the same rip in two folders is the usual
     * cause, and which one someone meant is not ours to guess.
     */
    return { kind: 'ask', candidates: candidates.map((c) => c.book), reason: 'ambiguous' };
  }

  const only = candidates[0];
  const verified =
    missing.sampleHash !== null &&
    only.sampleHash !== null &&
    missing.sampleHash === only.sampleHash;

  if (verified) return { kind: 'reconnect', to: only.book };
  return { kind: 'ask', candidates: [only.book], reason: 'unverified' };
}
