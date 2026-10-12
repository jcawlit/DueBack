/**
 * Shelf banding. The cases here are the ones a real library throws up and a
 * tidy test library does not: a book whose author could not be read at all,
 * and authors whose names are not written in the Latin alphabet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildShelves, fallbackVariant, leanFor, pageEdgeWidth } from '../src/lib/shelves.ts';

type TestBook = Parameters<typeof buildShelves>[0][number];

function book(overrides: Partial<TestBook> & { id: string }): TestBook {
  return {
    title: 'A Title',
    author: 'Eleanor Vance',
    durationSec: 3600,
    sizeBytes: 1024,
    local: { status: 'on-shelf' },
    ...overrides,
  } as TestBook;
}

/** Every book handed in must come back out on exactly one shelf. */
function assertNoneLost(books: TestBook[], shelves: ReturnType<typeof buildShelves>) {
  const seen = shelves.flatMap((s) => s.books.map((b) => b.id)).sort();
  assert.deepEqual(seen, books.map((b) => b.id).sort());
}

describe('buildShelves by author', () => {
  it('files a book with no author under its own label instead of crashing', () => {
    const books = [
      book({ id: 'a', author: '' }),
      book({ id: 'b', author: 'Eleanor Vance' }),
    ];
    const shelves = buildShelves(books, 'author');
    assertNoneLost(books, shelves);
    const unknown = shelves.find((s) => s.books.some((b) => b.id === 'a'));
    assert.equal(unknown?.label, 'AUTHOR UNKNOWN');
  });

  it('keeps non-Latin surnames out of the T–Z run', () => {
    const books = [
      book({ id: 'ru', author: 'Марина Орлова' }),
      book({ id: 'jp', author: '村上 春樹' }),
      book({ id: 'z', author: 'Rafael Zuniga' }),
    ];
    const shelves = buildShelves(books, 'author');
    assertNoneLost(books, shelves);
    const labelOf = (id: string) =>
      shelves.find((s) => s.books.some((b) => b.id === id))?.label;
    assert.equal(labelOf('ru'), 'OTHER ALPHABETS');
    assert.equal(labelOf('jp'), 'OTHER ALPHABETS');
    assert.equal(labelOf('z'), 'T – Z');
  });

  it('bands by surname, not by first name', () => {
    const books = [book({ id: 'x', author: 'Ada Whitfield' })];
    const shelves = buildShelves(books, 'author');
    assert.equal(shelves[0].label, 'T – Z');
  });

  it('splits a long band across ledges with a CONT. label', () => {
    const books = Array.from({ length: 7 }, (_, i) =>
      book({ id: `b${i}`, author: `Alice Adams${i}` }),
    );
    const shelves = buildShelves(books, 'author');
    assertNoneLost(books, shelves);
    assert.equal(shelves.length, 3);
    assert.equal(shelves[0].label, 'A – F');
    assert.equal(shelves[1].label, 'A – F · CONT.');
  });
});

describe('buildShelves across every sort', () => {
  /** A messy shelf: no author, no cover colour, never played, zero length. */
  const books = [
    book({ id: 'empty', author: '', durationSec: 0, dominantColor: undefined }),
    book({ id: 'grey', author: 'Mei-Lin Chen', dominantColor: '#808080' }),
    book({ id: 'red', author: 'Hugo Lambert', dominantColor: '#c0392b', durationSec: 40 * 3600 }),
    book({
      id: 'played',
      author: 'Priya Raghavan',
      dominantColor: '#2c3e50',
      lastPlayedAt: new Date(Date.now() - 86400000).toISOString(),
      durationSec: 15 * 3600,
    }),
  ];

  for (const sort of ['length', 'author', 'color', 'dust'] as const) {
    it(`loses no books sorting by ${sort}`, () => {
      assertNoneLost(books, buildShelves(books, sort));
    });
  }
});

describe('cover geometry', () => {
  it('thickens page edges with length', () => {
    assert.equal(pageEdgeWidth(0), 3);
    assert.equal(pageEdgeWidth(40 * 3600), 11);
  });

  it('leans and picks a fallback the same way for the same id', () => {
    assert.equal(leanFor('hyperion'), leanFor('hyperion'));
    assert.equal(fallbackVariant('hyperion'), fallbackVariant('hyperion'));
    assert.ok(Math.abs(leanFor('hyperion')) <= 3);
  });
});
