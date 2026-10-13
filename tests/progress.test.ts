/**
 * Progress arithmetic, which both the Book screen and the Player render
 * directly into a bar width and a percentage label.
 *
 * The case that matters is a book whose audio could not be read: its duration
 * is 0, `position / 0` is `NaN`, and `NaN` reaches React Native as
 * `width: "NaN%"` and a label reading "NaN%" rather than failing anywhere
 * anyone would notice.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chapterAt, fractionAt, progressFraction, type Book } from '../src/data/types.ts';

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b1',
    title: 'A Book',
    author: 'An Author',
    durationSec: 3600,
    sizeBytes: 1000,
    sourceRelPath: 'A Book',
    files: ['A Book/01.mp3'],
    chapters: [],
    local: { status: 'on-shelf' },
    progressSec: 0,
    checkouts: [],
    ...overrides,
  };
}

describe('fractionAt', () => {
  it('is a plain fraction of the duration', () => {
    assert.equal(fractionAt(book(), 900), 0.25);
    assert.equal(fractionAt(book(), 3600), 1);
  });

  it('is 0 for a book with no readable audio, never NaN', () => {
    const damaged = book({ durationSec: 0, files: [] });
    for (const position of [0, 1, 1000]) {
      const value = fractionAt(damaged, position);
      assert.ok(Number.isFinite(value), `fraction at ${position} was ${value}`);
      assert.equal(value, 0);
    }
  });

  it('clamps both ends, so a stale position cannot overflow a bar', () => {
    assert.equal(fractionAt(book(), 99999), 1);
    assert.equal(fractionAt(book(), -5), 0);
  });

  it('is what progressFraction reports for the saved position', () => {
    assert.equal(progressFraction(book({ progressSec: 1800 })), 0.5);
    assert.equal(progressFraction(book({ durationSec: 0, progressSec: 10 })), 0);
  });
});

describe('chapterAt', () => {
  it('stands in one chapter for a book that has none', () => {
    const { chapter, index, lengthSec } = chapterAt(book({ chapters: [] }), 0);
    assert.equal(index, 0);
    assert.equal(chapter.title, 'A Book');
    assert.ok(lengthSec > 0, 'a zero length would divide the scrubber by zero');
  });

  it('never returns a zero length for a damaged book either', () => {
    const { lengthSec } = chapterAt(book({ chapters: [], durationSec: 0 }), 0);
    assert.ok(lengthSec > 0, `lengthSec was ${lengthSec}`);
  });

  it('finds the chapter containing a position', () => {
    const b = book({
      chapters: [
        { title: 'One', startSec: 0 },
        { title: 'Two', startSec: 1200 },
        { title: 'Three', startSec: 2400 },
      ],
    });
    assert.equal(chapterAt(b, 0).chapter.title, 'One');
    assert.equal(chapterAt(b, 1199).chapter.title, 'One');
    assert.equal(chapterAt(b, 1200).chapter.title, 'Two');
    assert.equal(chapterAt(b, 3599).chapter.title, 'Three');
    // The last chapter runs to the end of the book.
    assert.equal(chapterAt(b, 2400).endSec, 3600);
  });
});
