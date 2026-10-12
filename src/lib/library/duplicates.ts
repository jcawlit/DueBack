/**
 * Spotting the same book twice.
 *
 * A library that has been copied between drives and computers for years ends
 * up with the same book in two or three folders — a loose copy, a tidied one,
 * and one inside a boxed set. The scanner is right to index each separately:
 * they are different files in different places, and the user may be keeping
 * one deliberately. What was missing was any way to find out, so a book was
 * checked out, stored and listened to while its twin sat on the next shelf
 * taking up the same space again.
 *
 * So this does not deduplicate anything. It only tells the truth on the Book
 * screen: this one is also in these other folders.
 */

import type { Book } from '@/data/types';
import { foldForSearch } from './search.ts';

/**
 * Title and author, folded. Deliberately not the duration or the byte size: an
 * abridged edition sitting beside the full one is exactly the pair someone
 * wants pointed out, and two rips of the same book rarely weigh the same to
 * the byte.
 */
function identityKey(book: Book): string | null {
  const title = foldForSearch(book.title);
  if (!title) return null;
  return `${title}\u0000${foldForSearch(book.author)}`;
}

/**
 * The other copies of `book`, in path order. Empty when there is only one,
 * which is the usual case.
 */
export function duplicatesOf(books: Book[], book: Book): Book[] {
  const key = identityKey(book);
  if (!key) return [];
  return books
    .filter((other) => other.id !== book.id && identityKey(other) === key)
    .sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)));
}

/**
 * Where a book lives, as something a person could go and look for. The full
 * relative path rather than just the folder name, because "Disc 1" on its own
 * names nothing.
 */
export function folderLabel(book: Book): string {
  const path = book.sourceRelPath?.replace(/^\/+|\/+$/g, '') ?? '';
  if (!path) return 'the library folder';
  return path;
}

/**
 * Groups a whole library by identity, for anything that wants every duplicate
 * set at once rather than one book's twins.
 */
export function duplicateSets(books: Book[]): Book[][] {
  const groups = new Map<string, Book[]>();
  for (const book of books) {
    const key = identityKey(book);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(book);
    else groups.set(key, [book]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}
