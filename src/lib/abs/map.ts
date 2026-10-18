/**
 * Turning an Audiobookshelf item into something this app understands.
 *
 * Pure and defensive. Every field is optional as far as this file is
 * concerned, because a real server has books with no author, no cover, no
 * chapters and no narrator, and the test library has one of each on purpose.
 *
 * Two shapes arrive here. The **minified** list item carries the flattened
 * fields — `authorName`, `narratorName`, `seriesName` as one string — and is
 * what the catalogue is built from. The **expanded** item carries those *and*
 * the structured ones — `authors[]`, `narrators[]`, `series[]` with a
 * separate `sequence` — plus chapters and tracks, and is fetched one book at
 * a time when it is opened. Both are read through the same functions, with
 * the structured form preferred where it exists, so the catalogue and the
 * book screen can never disagree about a title.
 */

import type { Chapter } from '@/data/types';

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** One book, as the shelves need it. */
export type AbsCatalogueEntry = {
  /** The server's id for the item. Half of a remote book's identity. */
  remoteId: string;
  /** Where it sits in the server's library folder, for the dev report. */
  relPath: string;
  title: string;
  author: string;
  narrator: string;
  /** Flattened, the way the server writes it: "Keepers #1". */
  series: string;
  genres: string[];
  durationSec: number;
  sizeBytes: number;
  /** Whether the server has artwork for it. Not the artwork itself. */
  hasCover: boolean;
  /** The server's own updatedAt, in its own milliseconds. The diff key. */
  updatedAt: number;
  /** The server has lost sight of the files. */
  isMissing: boolean;
  /** How many chapters the server counted, before any are fetched. */
  chapterCount: number;
  trackCount: number;
};

/**
 * The author, preferring the structured list over the flattened string.
 *
 * `authors[]` is absent from a minified item, which is most of what this
 * reads, so the flattened `authorName` is not a fallback for odd cases — it
 * is the normal path.
 */
export function authorOf(metadata: Json): string {
  const authors = arr(metadata.authors)
    .map((a) => str(obj(a).name))
    .filter(Boolean);
  if (authors.length > 0) return authors.join(', ');
  return str(metadata.authorName);
}

/** Narrators arrive as plain strings, not objects, unlike authors. */
export function narratorOf(metadata: Json): string {
  const narrators = arr(metadata.narrators)
    .map((n) => (typeof n === 'string' ? n.trim() : str(obj(n).name)))
    .filter(Boolean);
  if (narrators.length > 0) return narrators.join(', ');
  return str(metadata.narratorName);
}

/**
 * The series, as one string.
 *
 * Structured form is `[{name, sequence}]` and the flattened form already
 * reads "Keepers #1", so building the same thing from the parts keeps the
 * two shapes indistinguishable downstream. A series with no sequence is just
 * its name — "Keepers #" would be worse than saying less.
 */
export function seriesOf(metadata: Json): string {
  const series = arr(metadata.series)
    .map((s) => {
      const entry = obj(s);
      const name = str(entry.name);
      const sequence = str(entry.sequence);
      if (!name) return '';
      return sequence ? `${name} #${sequence}` : name;
    })
    .filter(Boolean);
  if (series.length > 0) return series.join(', ');
  return str(metadata.seriesName);
}

/** Reads a list item, minified or expanded, into a catalogue entry. */
export function catalogueEntry(raw: Json): AbsCatalogueEntry | null {
  const remoteId = str(raw.id);
  if (!remoteId) return null;

  const media = obj(raw.media);
  const metadata = obj(media.metadata);
  const title = str(metadata.title);

  return {
    remoteId,
    relPath: str(raw.relPath),
    // A book with no title is still a book, and showing its folder name
    // beats dropping it out of the library without saying so.
    title: title || str(raw.relPath) || 'Untitled',
    author: authorOf(metadata),
    narrator: narratorOf(metadata),
    series: seriesOf(metadata),
    genres: arr(metadata.genres).map(str).filter(Boolean),
    durationSec: num(media.duration),
    sizeBytes: num(media.size) || num(raw.size),
    hasCover: str(media.coverPath).length > 0,
    updatedAt: num(raw.updatedAt),
    isMissing: raw.isMissing === true,
    // `numChapters` is absent from an expanded item, which carries the real
    // array instead.
    chapterCount: arr(media.chapters).length || num(media.numChapters),
    trackCount: arr(media.tracks).length || num(media.numTracks),
  };
}

/** Reads a whole page of list items, dropping anything unusable. */
export function catalogueEntries(items: unknown[]): AbsCatalogueEntry[] {
  const entries: AbsCatalogueEntry[] = [];
  for (const item of items) {
    const entry = catalogueEntry(obj(item));
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Chapters from an expanded item.
 *
 * The server's own chapters when it has them. When it has none — a single
 * untagged file, which the test library includes deliberately — the tracks
 * stand in one-per-file, the same fallback the USB scanner uses, and the
 * caller is told it is a fallback so the lock screen can say "Part 3 of 12"
 * rather than reading out a file name as though it were a chapter title.
 */
export function chaptersFrom(expanded: Json): { chapters: Chapter[]; fromParts: boolean } {
  const media = obj(expanded.media);

  const chapters = arr(media.chapters)
    .map((c) => {
      const chapter = obj(c);
      return { title: str(chapter.title), startSec: num(chapter.start) };
    })
    .filter((c) => c.title.length > 0 || c.startSec > 0);

  if (chapters.length > 0) {
    // Not assumed sorted: nothing in the API promises an order, and a
    // chapter list out of order puts every "which chapter am I in" answer
    // one place wrong.
    chapters.sort((a, b) => a.startSec - b.startSec);
    return { chapters, fromParts: false };
  }

  const tracks = arr(media.tracks)
    .map((t) => {
      const track = obj(t);
      return {
        index: num(track.index),
        title: str(track.title),
        startSec: num(track.startOffset),
      };
    })
    .sort((a, b) => a.startSec - b.startSec);

  if (tracks.length <= 1) return { chapters: [], fromParts: false };

  return {
    chapters: tracks.map((t, i) => ({
      title: t.title || `Part ${i + 1}`,
      startSec: t.startSec,
    })),
    fromParts: true,
  };
}

/** What an expanded item adds to what the catalogue already knew. */
export type AbsDetail = {
  chapters: Chapter[];
  chaptersFromParts: boolean;
  durationSec: number;
  sizeBytes: number;
  /** Playback addresses, for the step that brings the audio across. */
  tracks: { index: number; startSec: number; durationSec: number; contentUrl: string }[];
};

export function detailFrom(expanded: Json): AbsDetail {
  const media = obj(expanded.media);
  const { chapters, fromParts } = chaptersFrom(expanded);
  return {
    chapters,
    chaptersFromParts: fromParts,
    durationSec: num(media.duration),
    sizeBytes: num(media.size) || num(expanded.size),
    tracks: arr(media.tracks).map((t) => {
      const track = obj(t);
      return {
        index: num(track.index),
        startSec: num(track.startOffset),
        durationSec: num(track.duration),
        contentUrl: str(track.contentUrl),
      };
    }),
  };
}
