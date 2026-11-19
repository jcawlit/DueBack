/**
 * What a cached cover is called, and which ones a rescan may delete.
 *
 * Small, pure and separate because the rule it encodes is invisible when it
 * breaks. Thumbnails are named `<bookId>.<token>.jpg`, and clearing a book's
 * covers works by deleting everything that starts with the book's id — which
 * is how storing new artwork replaces old without knowing its name.
 *
 * A cover the listener picked is in that same directory under that same
 * prefix, so the next scan to find artwork on the drive would delete it while
 * the book's correction went on naming it. The result is a book with no
 * picture and nothing on screen to say why, days after the edit, with no
 * error anywhere. Hence the mark, and hence the test.
 */

/** Set in the file name of a cover the listener picked themselves. */
export const USER_COVER_MARK = '.user.';

export function coverName(bookId: string, token: string, picked: boolean): string {
  return `${bookId}${picked ? USER_COVER_MARK : '.'}${token}.jpg`;
}

/** True when this file is a cover the given book's listener picked. */
export function isUserCover(fileName: string, bookId: string): boolean {
  return fileName.startsWith(`${bookId}${USER_COVER_MARK}`);
}

/**
 * Whether a file in the covers directory should be deleted while clearing
 * `bookId`'s thumbnails.
 *
 * `keep` is the cover just written, which must survive. `includeUser` is set
 * only when the book is being forgotten — the one time a picked cover should
 * go, because the book it belonged to is leaving the library.
 */
export function shouldSweep(
  fileName: string,
  bookId: string,
  keep?: string,
  includeUser = false,
): boolean {
  // The separator matters: without it, clearing book "ab" would delete the
  // covers of book "abc".
  if (!fileName.startsWith(`${bookId}.`)) return false;
  if (fileName === keep) return false;
  if (!includeUser && isUserCover(fileName, bookId)) return false;
  return true;
}
