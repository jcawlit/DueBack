/**
 * Grouping books into shelves. The shelf labels depend on the active sort, as
 * described in HANDOFF.md — by length you get "DOORSTOPPERS · 40h+" and friends,
 * by author you get letter ranges, and so on.
 */

import type { Book, SortMode } from '@/data/types';
export type Shelf = {
  key: string;
  label: string;
  books: Book[];
  /**
   * The hand-arranged shelf this row belongs to, in custom mode.
   *
   * A row holds three covers, so a shelf of seven books is three rows —
   * and a book dropped on any of them belongs on the same shelf. Absent
   * for a generated shelf, which is not a thing you can drop a book onto.
   */
  shelfId?: string;
  /**
   * The shelf's plain name, without the "· CONT." a later row's label
   * carries. Travels with the row so renaming needs no lookup, which is
   * what keeps the screen's rename callback free of dependencies.
   */
  shelfName?: string;

};

/** A hand-arranged shelf, as the Library needs it to lay one out. */
export type CustomShelf = {
  id: string;
  name: string;
  bookIds: string[];
};

/**
 * Books per shelf. The mockup fits three face-out covers on a ledge.
 *
 * Exported because it is also a hand-arranged shelf's **capacity** — one
 * shelf is one ledge — and `cascade` has to agree with it exactly. Two
 * constants for one fact is a shelf that draws three books and accepts
 * four.
 */
export const PER_SHELF = 3;

const LENGTH_BANDS = [
  { label: 'DOORSTOPPERS · 40h+', minHours: 40 },
  { label: 'LONG HAUL · 19–39h', minHours: 19 },
  { label: 'COMMUTE SIZED · 12–18h', minHours: 12 },
  { label: 'SHORT TRIPS · UNDER 12h', minHours: 0 },
];

function hours(b: Book) {
  return b.durationSec / 3600;
}

/** Surnames that do not start with a Latin letter get their own ledge. */
const OTHER_ALPHABETS = 'OTHER ALPHABETS';
/** A book whose author could not be read has no letter to file it under. */
const AUTHOR_UNKNOWN = 'AUTHOR UNKNOWN';

function chunk(label: (index: number) => string, books: Book[], keyPrefix: string): Shelf[] {
  const out: Shelf[] = [];
  for (let i = 0; i < books.length; i += PER_SHELF) {
    out.push({
      key: `${keyPrefix}-${i}`,
      label: label(i),
      books: books.slice(i, i + PER_SHELF),
    });
  }
  return out;
}

/** Groups by a label, then splits each group into ledge-sized rows. */
function banded(
  books: Book[],
  labelFor: (b: Book) => string,
  order: string[],
): Shelf[] {
  const groups = new Map<string, Book[]>();
  books.forEach((b) => {
    const label = labelFor(b);
    const list = groups.get(label);
    if (list) list.push(b);
    else groups.set(label, [b]);
  });
  const shelves: Shelf[] = [];
  order
    .filter((label) => groups.has(label))
    .forEach((label) => {
      const group = groups.get(label)!;
      chunk(
        (i) => (i === 0 ? label : `${label} · CONT.`),
        group,
        label,
      ).forEach((s) => shelves.push(s));
    });
  return shelves;
}

/**
 * Rows for the shelves the listener arranged.
 *
 * Every book is on a shelf. There was a "not on a shelf" pile at the
 * bottom holding anything unplaced, and it went: custom mode now starts
 * from the by-length shelves, so nothing is ever unplaced, and a pile for
 * the empty case is a row that exists to explain a state nobody is in.
 *
 * A shelf holds `PER_SHELF` books and no more — the cascade keeps it that
 * way. More than that only arrives from a merge with another phone, and
 * it is drawn as extra ledges rather than hidden, because a book that is
 * there should be visible until the next drag settles it.
 *
 * An empty shelf still gets a row: it is the one you just made.
 */
export function buildCustomShelves(books: Book[], custom: CustomShelf[]): Shelf[] {
  const byId = new Map(books.map((b) => [b.id, b]));
  /*
   * One shelf is exactly one row, however many books are on it.
   *
   * It used to split an over-full shelf into extra ledges, and that broke
   * dragging: a shelf going from three books to four mid-drag inserted a
   * row, which moved every row below it — and a row only re-measures when
   * its own layout changes, so the drag was left hit-testing against
   * positions that had quietly moved.
   *
   * A shelf over capacity is only ever transient now: the dragged book is
   * held in its own slot while a preview runs, and a merge from another
   * phone can deliver four until the next drop settles it. Four covers on
   * one ledge is tight for a moment, which is a better failure than books
   * landing on the wrong shelf.
   */
  return custom.map((shelf) => ({
    key: `custom-${shelf.id}`,
    label: shelf.name,
    books: shelf.bookIds.map((id) => byId.get(id)).filter((b): b is Book => !!b),
    shelfId: shelf.id,
    shelfName: shelf.name,
  }));
}

/**
 * The shelves custom mode starts from: the by-length ones, as they stand.
 *
 * Custom mode used to begin empty, which meant a wall of unplaced books
 * and a shelf to make before anything could be arranged. Starting from
 * what is already on screen means the first thing a listener does is
 * reorder and rename, not build from nothing.
 *
 * Pure, and returns what to create rather than creating it. One ledge
 * becomes one shelf, keeping the band's own label as its first name —
 * "DOORSTOPPERS · 40h+" says more than "Shelf 1" does, and it is the name
 * already under that ledge a moment earlier.
 */
export function seedShelvesFromLength(
  books: Book[],
): { name: string; bookIds: string[] }[] {
  return buildShelves(books, 'length').map((row) => ({
    name: row.label,
    bookIds: row.books.map((b) => b.id),
  }));
}

export function buildShelves(
  books: Book[],
  sort: SortMode,
  custom: CustomShelf[] = [],
): Shelf[] {
  switch (sort) {
    case 'length': {
      const sorted = [...books].sort((a, b) => b.durationSec - a.durationSec);
      const labelFor = (b: Book) =>
        LENGTH_BANDS.find((band) => hours(b) >= band.minHours)!.label;
      return banded(sorted, labelFor, LENGTH_BANDS.map((b) => b.label));
    }

    case 'author': {
      const sorted = [...books].sort((a, b) =>
        a.author.localeCompare(b.author) || a.title.localeCompare(b.title),
      );
      const labelFor = (b: Book) => {
        const surname = b.author.trim().split(/\s+/).pop() ?? '';
        // An unreadable file leaves a book with no author at all, and the old
        // code reached straight into `surname[0]` — enough to crash this whole
        // sort on a library with a single bad file in it.
        if (surname === '') return AUTHOR_UNKNOWN;
        const letter = surname.slice(0, 1).toUpperCase();
        // Cyrillic, Greek and CJK surnames have no place in an A–Z run, and
        // comparing them against 'Z' by code point filed every one under T–Z.
        if (!/[A-Z]/.test(letter)) return OTHER_ALPHABETS;
        if (letter <= 'F') return 'A – F';
        if (letter <= 'M') return 'G – M';
        if (letter <= 'S') return 'N – S';
        return 'T – Z';
      };
      return banded(sorted, labelFor, [
        'A – F',
        'G – M',
        'N – S',
        'T – Z',
        OTHER_ALPHABETS,
        AUTHOR_UNKNOWN,
      ]);
    }

    case 'custom':
      return buildCustomShelves(books, custom);
  }
}

/** Page-edge thickness: `round(3 + hours / 5)` px, per the handoff. */
export function pageEdgeWidth(durationSec: number): number {
  return Math.round(3 + durationSec / 3600 / 5);
}

/**
 * Small deliberate rotations between −3° and 3°, derived from the book id so a
 * cover always leans the same way.
 */
export function leanFor(id: string, spread = 3): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return Math.round(((h / 1000) * spread * 2 - spread) * 10) / 10;
}

/**
 * Which fallback cover layout to draw when a book has no art: the mockups use a
 * ruled "frame" and a horizontal "band". Derived from the id so it is stable.
 */
export function fallbackVariant(id: string): 'frame' | 'band' {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 17 + id.charCodeAt(i)) % 2048;
  return h % 2 === 0 ? 'frame' : 'band';
}
