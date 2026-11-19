/**
 * Calling a mark what it actually is.
 *
 * A book's `chapters` are two different things wearing one name. Sometimes
 * they are real chapter marks, read from the file's own metadata, and "Ch. 4"
 * is the truth. Sometimes there were no marks at all and the scan fell back to
 * one per file — and then the tenth file is called "Ch. 10" while the listener
 * is somewhere in chapter four, because the files were cut to a length rather
 * than to the book's structure.
 *
 * The scan already knows which it did: `chaptersFromParts` is set when the
 * marks are one-per-file stand-ins, and it travels on the book. Everything
 * here is the reading of that flag, in one place, so the whole app says the
 * same word.
 *
 * Nothing stored changes. The titles in the database stay exactly as the scan
 * wrote them, so an existing library says the right thing without a rescan.
 */

import type { Book } from '@/data/types';
// Relative on purpose: `@/` is a bundler alias, and Node's test runner cannot
// resolve it for a *value* import. The type import above is erased, so it can
// keep the alias. Same reason as `lib/library/cascade.ts`.
import { tidyChapterTitle } from '../format.ts';

/** Everything here needs only the flag, so a whole `Book` is never required. */
type Marked = Pick<Book, 'chaptersFromParts'>;

/**
 * Whether this book's marks are where the files were cut rather than chapters.
 *
 * The flag is optional on `Book` — older rows and server books may not carry
 * it — and absent means "these are chapters", which is the safer wrong answer:
 * calling a real chapter a section is a smaller lie than the reverse.
 */
export function marksAreSections(book: Marked): boolean {
  return book.chaptersFromParts === true;
}

/**
 * "Section 10" or "Ch. 4", for a line of running text.
 *
 * Deliberately not abbreviated to "Sec." — every place this appears sits
 * beside a timestamp, and "Sec. 10 · 1:23:45" reads as ten seconds. "Part"
 * was the other candidate and collides with the app's own word for one file
 * of a book.
 */
export function markLabel(book: Marked, index: number): string {
  return marksAreSections(book) ? `Section ${index + 1}` : `Ch. ${index + 1}`;
}

/** The same, for the small-caps mono labels. */
export function markLabelCaps(book: Marked, index: number): string {
  return marksAreSections(book) ? `SECTION ${index + 1}` : `CH. ${index + 1}`;
}

/** "section" or "chapter", for a sentence or a screen-reader label. */
export function markWord(book: Marked): string {
  return marksAreSections(book) ? 'section' : 'chapter';
}

/** "Sections" or "Chapters", for a tab. */
export function markWordPlural(book: Marked): string {
  return marksAreSections(book) ? 'Sections' : 'Chapters';
}

/**
 * How wide the gutter holding `markLabelCaps` has to be.
 *
 * "SECTION 120" is twice the width of "CH. 4", and a fixed 52 clipped it.
 * Measured in the mono face the labels use rather than guessed per screen.
 */
export function markGutterWidth(book: Marked): number {
  return marksAreSections(book) ? 78 : 52;
}

/**
 * What to show as a mark's name in a list.
 *
 * A one-per-file mark is titled with its filename, which is usually worth
 * reading — "Part 10", or an actual section name if whoever encoded it
 * bothered. When it says nothing at all, the numbered label stands in, using
 * the right word for what this is.
 */
export function markTitle(
  book: Marked,
  chapter: { title?: string },
  index: number,
): string {
  const given = chapter.title?.trim();
  if (given) return tidyChapterTitle(given);
  return marksAreSections(book) ? `Section ${index + 1}` : `Chapter ${index + 1}`;
}
