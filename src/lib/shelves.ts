/**
 * Grouping books into shelves. The shelf labels depend on the active sort, as
 * described in HANDOFF.md — by length you get "DOORSTOPPERS · 40h+" and friends,
 * by author you get letter ranges, and so on.
 */

import type { Book, SortMode } from '@/data/types';
// Explicit extension so this module loads under node for the unit tests, the
// same convention the metadata parsers use.
import { relativeTime } from './format.ts';

export type Shelf = {
  key: string;
  label: string;
  books: Book[];
};

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

/** Hue of the cover colour, so the "by colour" sort runs across the spectrum. */
function hue(hex?: string): number {
  if (!hex) return 0;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return -1; // greys sort to the front
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

/** Surnames that do not start with a Latin letter get their own ledge. */
const OTHER_ALPHABETS = 'OTHER ALPHABETS';
/** A book whose author could not be read has no letter to file it under. */
const AUTHOR_UNKNOWN = 'AUTHOR UNKNOWN';

const COLOR_BANDS = [
  { label: 'GREYS & PAPER', max: 0 },
  { label: 'REDS & RUST', max: 45 },
  { label: 'GOLDS & OCHRE', max: 70 },
  { label: 'GREENS', max: 170 },
  { label: 'BLUES & INK', max: 360 },
];

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

export function buildShelves(books: Book[], sort: SortMode, now = Date.now()): Shelf[] {
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

    case 'color': {
      const sorted = [...books].sort((a, b) => hue(a.dominantColor) - hue(b.dominantColor));
      const labelFor = (b: Book) => {
        const h = hue(b.dominantColor);
        if (h < 0) return COLOR_BANDS[0].label;
        return COLOR_BANDS.slice(1).find((band) => h <= band.max)!.label;
      };
      return banded(sorted, labelFor, COLOR_BANDS.map((b) => b.label));
    }

    case 'dust': {
      /** Never-played books are the dustiest of all. */
      const age = (b: Book) =>
        b.lastPlayedAt ? now - new Date(b.lastPlayedAt).getTime() : Number.MAX_SAFE_INTEGER;
      const sorted = [...books].sort((a, b) => age(b) - age(a));
      return chunk(
        (i) => {
          const first = sorted[i];
          return first.lastPlayedAt
            ? `UNTOUCHED SINCE ${relativeTime(first.lastPlayedAt, now).toUpperCase()}`
            : 'NEVER OPENED';
        },
        sorted,
        'dust',
      );
    }
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
