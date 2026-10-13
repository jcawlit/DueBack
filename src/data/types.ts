/**
 * The data model, following HANDOFF.md's starting point but using the library
 * vocabulary we settled on: books sit **on the shelf** (USB only), get **checked
 * out** (copied to the phone), go **on hold** (queued until the drive is back),
 * and are **returned** (local copy deleted, progress kept).
 */

export type Chapter = {
  title: string;
  startSec: number;
  /**
   * The larger division a chapter belongs to, when the source tags carry one —
   * "BOOK V · THE DEAD HAND". The Player shows it above the chapter title.
   */
  part?: string;
};

/** One row of the library card: when it went out, and when it came back. */
export type Checkout = {
  /** ISO date the local copy was made. */
  out: string;
  /** ISO date it was returned. Absent while the book is still on the phone. */
  back?: string;
};

/**
 * Where the book's audio currently lives. `copying` and `on-hold` are transient
 * states the Library renders differently; only `checked-out` has a local file.
 */
export type LocalState =
  | { status: 'on-shelf' }
  /** Queued because the drive was not connected when the user asked for it. */
  | { status: 'on-hold'; since: string }
  /** Copy in flight. `progress` is 0–1 and drives the overlay on the cover. */
  | { status: 'copying'; progress: number }
  | { status: 'checked-out'; localPath: string };

export type Book = {
  /** Stable hash of relative path + size, so rescans match existing rows. */
  id: string;
  title: string;
  author: string;
  narrator?: string;
  durationSec: number;
  sizeBytes: number;
  /** Path inside the USB library root. */
  sourceRelPath: string;
  /** One `.m4b`, or many `.mp3` parts in playback order. */
  files: string[];
  chapters: Chapter[];
  /** Small thumbnail cached locally, so shelves stay browsable when unplugged. */
  coverThumbPath?: string;
  local: LocalState;
  progressSec: number;
  finishedAt?: string;
  checkouts: Checkout[];
  /** Drives fallback covers and the "by colour" sort. */
  dominantColor?: string;
  /** Readable ink for a fallback cover drawn on `dominantColor`. */
  coverInk?: string;
  /**
   * True when the last scan could not find the source file any more. Returning
   * such a book would destroy the only remaining copy, so we warn first.
   */
  missingFromDrive?: boolean;
  /**
   * True whenever the phone holds the only copy — either the book left the
   * drive, or it was imported from the phone and not yet copied across.
   */
  onlyCopyOnPhone?: boolean;
  /** Added from phone storage rather than found on the library drive. */
  importedFromPhone?: boolean;
  /**
   * True when this book's chapters are one-per-file stand-ins rather than
   * real chapter marks, which changes what the lock screen should say.
   */
  chaptersFromParts?: boolean;
  /** Encrypted (Audible or FairPlay) and therefore unplayable. */
  drmProtected?: boolean;
  /** ISO date the book was last listened to, for the "gathering dust" sort. */
  lastPlayedAt?: string;
};

export type SortMode = 'length' | 'author' | 'color' | 'dust';

export const SORT_LABELS: Record<SortMode, string> = {
  length: 'by length',
  author: 'by author',
  color: 'by colour',
  dust: 'gathering dust',
};

export const isCheckedOut = (b: Book) => b.local.status === 'checked-out';
/** A book counts against the storage budget as soon as a copy is under way. */
export const occupiesBudget = (b: Book) =>
  b.local.status === 'checked-out' || b.local.status === 'copying';
export const isInProgress = (b: Book) =>
  b.progressSec > 60 && !b.finishedAt && b.progressSec < b.durationSec;

export function progressFraction(b: Book) {
  if (b.durationSec <= 0) return 0;
  return Math.min(1, b.progressSec / b.durationSec);
}

/** The chapter containing `positionSec`, plus its index. */
export function chapterAt(b: Book, positionSec: number) {
  // A book may have no chapter marks at all — a single file imported from the
  // phone is the usual case. Every caller reaches straight into
  // `.chapter.startSec`, so returning nothing here took the Player screen down
  // with "Cannot read property 'startSec' of undefined". One chapter spanning
  // the whole book is the honest answer: that is exactly what the listener has.
  if (b.chapters.length === 0) {
    return {
      chapter: { title: b.title, startSec: 0 } as Chapter,
      index: 0,
      endSec: b.durationSec,
      lengthSec: Math.max(1, b.durationSec),
    };
  }
  let index = 0;
  for (let i = 0; i < b.chapters.length; i += 1) {
    if (b.chapters[i].startSec <= positionSec) index = i;
    else break;
  }
  const chapter = b.chapters[index];
  const next = b.chapters[index + 1];
  const endSec = next ? next.startSec : b.durationSec;
  return { chapter, index, endSec, lengthSec: Math.max(1, endSec - chapter.startSec) };
}
