/**
 * Putting the parts of a book added from the phone in order.
 *
 * Split out from `lib/files/import.ts` so it can be tested: that module
 * reaches `expo-file-system` and cannot be loaded off a phone, and this is
 * the half with the rules in it.
 */

// Relative on purpose: `@/` is a bundler alias that Node's test runner cannot
// resolve for a value import. Same reason as `lib/library/cascade.ts`.
import { naturalCompare } from './names.ts';

/**
 * Puts found parts in playing order and gives each one a unique name.
 *
 * Separated from the walk because this is the part with rules in it, and the
 * walk is the part that needs a filesystem.
 *
 * Ordering is on the **path** rather than the filename, which is what keeps
 * every `Disc 1` part ahead of every `Disc 2` part when both number their
 * files from one. `naturalCompare` is what makes "Part 2" come before
 * "Part 10".
 *
 * A part out of a subfolder is then renamed to carry it: `Disc 1 - 01.mp3`.
 * Not cosmetic. This name is what the database stores, what a one-per-file
 * chapter is titled with, and — the reason it matters — what the file is
 * called if the book is later pushed to the drive, into a single flat folder.
 * Two discs both numbering their parts from one would otherwise both be
 * `01.mp3`, and the second would land on top of the first. A file picked at
 * the top level keeps its own name exactly.
 */
export function orderImportedParts<T extends { path: string }>(
  found: T[],
): (T & { name: string })[] {
  return [...found]
    .sort((a, b) => naturalCompare(a.path, b.path))
    .map((part) => ({ ...part, name: part.path.replace(/\//g, ' - ') }));
}

