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
 * Where a book lives, as something a person could go and look for.
 *
 * The folder it is in, with whatever it is nested under kept as context —
 * "Disc 1" on its own names nothing, so the parent cannot simply be dropped.
 * But the parent must not come **first**, which is what the full path did:
 * a second copy of The Hobbit sitting inside a folder called
 * `Hyperion - Dan Simmons - 1989` was labelled with Hyperion’s name, and read
 * as though the app were pointing at the wrong book entirely. It was not —
 * the link went to the right one — but a label nobody can read is a label
 * that is wrong.
 */
export function folderLabel(book: Book): string {
  const path = book.sourceRelPath?.replace(/^\/+|\/+$/g, '') ?? '';
  if (!path) return 'the library folder';
  const parts = path.split('/').filter(Boolean);
  const here = parts[parts.length - 1];
  if (parts.length < 2) return here;
  // "The Hobbit, in Hyperion - Dan Simmons - 1989" rather than the path,
  // which put the wrong name where the eye lands first.
  return `${here}, in ${parts.slice(0, -1).join('/')}`;
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
