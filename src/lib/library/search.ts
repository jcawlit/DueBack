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
 * Whether `book` matches `query`.
 *
 * Every word in the query must appear somewhere in the title, the author or
 * the narrator — in any order, so "simmons hyperion" finds the same book as
 * "hyperion simmons". Matching is on word prefixes rather than anywhere in the
 * text, because "son" finding "Simmons" is noise, while "sim" finding it is
 * what someone typing three letters wanted.
 */
export function matchesSearch(book: Book, query: string): boolean {
  const needle = foldForSearch(query);
  if (!needle) return true;

  const haystack = foldForSearch(
    [book.title, book.author, book.narrator ?? ''].join(' '),
  );
  const words = haystack.split(' ');

  return needle
    .split(' ')
    .every((term) => words.some((word) => word.startsWith(term)));
}

export function searchBooks(books: Book[], query: string): Book[] {
  if (!foldForSearch(query)) return books;
  return books.filter((book) => matchesSearch(book, query));
}
