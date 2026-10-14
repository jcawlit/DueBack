/**
 * What is paid for, and what never is.
 *
 * Notes, bookmarks, export and getting your data back are always free: they
 * are the listener's own writing, and holding someone's words hostage is not
 * a business model this app will have. The character index is the part that
 * sits behind the flag.
 *
 * Nothing is wired to a store yet, so this is true for everyone. It exists as
 * one function so that when it stops being true there is exactly one place to
 * change, and every screen is already asking the right question.
 */
export function isPro(): boolean {
  return true;
}
