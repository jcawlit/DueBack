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
  /** True for the row holding books that are on no shelf at all. */
  unshelved?: boolean;
};

/** A hand-arranged shelf, as the Library needs it to lay one out. */
export type CustomShelf = {
  id: string;
  name: string;
  bookIds: string[];
};

/** The label on the row holding everything not yet put anywhere. */
export const UNSHELVED_LABEL = 'NOT ON A SHELF';

/** Books per shelf. The mockup fits three face-out covers on a ledge. */
const PER_SHELF = 3;

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
 * Every book in the library appears exactly once: on its shelf if it has
 * one, and in a final row if it does not. Without that row a fresh custom
 * mode would be empty and there would be nothing to drag — and a book
 * taken off a shelf would vanish from the Library rather than going back
 * to the pile.
 *
 * An empty shelf still gets a row, because an empty shelf is the thing you
 * just made and are about to drag a book onto.
 */
export function buildCustomShelves(books: Book[], custom: CustomShelf[]): Shelf[] {
  const byId = new Map(books.map((b) => [b.id, b]));
  const placed = new Set<string>();
  const rows: Shelf[] = [];

  for (const shelf of custom) {
    const onIt = shelf.bookIds
      .map((id) => byId.get(id))
      .filter((b): b is Book => !!b);
    for (const id of shelf.bookIds) placed.add(id);

    if (onIt.length === 0) {
      rows.push({ key: `custom-${shelf.id}`, label: shelf.name, books: [], shelfId: shelf.id });
      continue;
    }
    for (let i = 0; i < onIt.length; i += PER_SHELF) {
      rows.push({
        key: `custom-${shelf.id}-${i}`,
        label: i === 0 ? shelf.name : `${shelf.name} · CONT.`,
        books: onIt.slice(i, i + PER_SHELF),
        shelfId: shelf.id,
      });
    }
  }

  const loose = books.filter((b) => !placed.has(b.id));
  if (loose.length === 0) return rows;
  for (let i = 0; i < loose.length; i += PER_SHELF) {
    rows.push({
      key: `unshelved-${i}`,
      label: i === 0 ? UNSHELVED_LABEL : `${UNSHELVED_LABEL} · CONT.`,
      books: loose.slice(i, i + PER_SHELF),
      unshelved: true,
    });
  }
  return rows;
}

/*
 * There was a `now = Date.now()` parameter here, unused by any branch and
 * passed by nobody. It went: a default argument that calls the clock makes
 * the function impure to anything reading it from a render, for a value no
 * sort has ever looked at.
 */
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
