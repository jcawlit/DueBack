/**
 * Finding a book by name.
 *
 * With a few hundred books on the shelves, scrolling stops being a way to find
 * anything. This is deliberately forgiving rather than clever: people half
 * remember a title, type it with the wrong accents, and search for the author
 * as often as the book.
 */

import type { Book } from '@/data/types';

/**
 * The folded text for a book, remembered against the object it came from.
 *
 * Folding is three passes over the string — Unicode normalisation and two
 * regexes — and it was being done for every book on every keystroke: at four
 * hundred books, that is twelve hundred passes between one letter and the
 * next, for text that had not changed. The books are rebuilt as new objects
 * whenever the library reloads, which is exactly when the folded text stops
 * being valid, so the object itself is the right key. A `WeakMap` means a
 * reloaded library's old entries are collected without anything having to
 * remember to clear them.
 */
const folded = new WeakMap<Book, string[]>();

/** A book's searchable words, folded and split once. */
function searchWordsFor(book: Book): string[] {
  const cached = folded.get(book);
  if (cached !== undefined) return cached;
  const words = foldForSearch([book.title, book.author, book.narrator ?? ''].join(' ')).split(' ');
  folded.set(book, words);
  return words;
}

/**
 * Strips accents and punctuation so that "Les Misérables" is found by typing
 * "les miserables", and "Hitch-Hiker's" by typing "hitch hikers".
 *
 * `NFD` splits an accented letter into the letter plus its mark, which the
 * following range then removes — the one piece of Unicode normalisation that
 * earns its keep here.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The books matching `query`.
 *
 * Every word in the query must appear somewhere in the title, the author or
 * the narrator — in any order, so "simmons hyperion" finds the same book as
 * "hyperion simmons". Matching is on word prefixes rather than anywhere in the
 * text, because "son" finding "Simmons" is noise, while "sim" finding it is
 * what someone typing three letters wanted.
 */
export function searchBooks(books: Book[], query: string): Book[] {
  // Folded once for the whole library rather than once per book.
  const needle = foldForSearch(query);
  if (!needle) return books;
  const terms = needle.split(' ');

  return books.filter((book) => {
    const words = searchWordsFor(book);
    return terms.every((term) => words.some((word) => word.startsWith(term)));
  });
}
