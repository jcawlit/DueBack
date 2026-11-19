/**
 * Calling a mark what it is.
 *
 * The case that matters: a book cut into equal lengths with no chapter marks
 * of its own. The scan falls back to one mark per file and sets
 * `chaptersFromParts`, and the tenth file is then labelled "Ch. 10" while the
 * listener is somewhere in chapter four. These tests pin the wording, because
 * the wording is the whole fix — nothing about the data changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  markGutterWidth,
  markLabel,
  markLabelCaps,
  markTitle,
  markWord,
  markWordPlural,
  marksAreSections,
} from '../src/lib/library/marks.ts';

const chaptered = { chaptersFromParts: false };
const sectioned = { chaptersFromParts: true };
/** Older rows and server books may not carry the flag at all. */
const unknown = {};

describe('deciding which it is', () => {
  it('reads the flag the scan set', () => {
    assert.equal(marksAreSections(sectioned), true);
    assert.equal(marksAreSections(chaptered), false);
  });

  it('treats a missing flag as real chapters', () => {
    // The safer wrong answer: calling a real chapter a section is a smaller
    // lie than promising chapter numbers that were never in the file.
    assert.equal(marksAreSections(unknown), false);
  });
});

describe('the labels', () => {
  it('numbers chapters from one, not from zero', () => {
    assert.equal(markLabel(chaptered, 0), 'Ch. 1');
    assert.equal(markLabel(chaptered, 3), 'Ch. 4');
  });

  it('says "Section" for marks that are only where the files were cut', () => {
    assert.equal(markLabel(sectioned, 9), 'Section 10');
  });

  it('never abbreviates "Section"', () => {
    /*
     * Every place this appears sits beside a timestamp, and "Sec. 10 ·
     * 1:23:45" reads as ten seconds. The abbreviation is the bug, so it is
     * worth a test of its own.
     */
    for (const index of [0, 9, 99]) {
      assert.ok(!markLabel(sectioned, index).includes('Sec.'));
      assert.ok(!markLabelCaps(sectioned, index).includes('SEC.'));
    }
  });

  it('has a capitalised form for the mono labels', () => {
    assert.equal(markLabelCaps(chaptered, 3), 'CH. 4');
    assert.equal(markLabelCaps(sectioned, 9), 'SECTION 10');
  });

  it('has a bare word for sentences and screen readers', () => {
    assert.equal(markWord(chaptered), 'chapter');
    assert.equal(markWord(sectioned), 'section');
    assert.equal(markWordPlural(chaptered), 'Chapters');
    assert.equal(markWordPlural(sectioned), 'Sections');
  });
});

describe('the list gutter', () => {
  it('is wider for sections, because the label is', () => {
    // "SECTION 120" against "CH. 4" in the same mono face. A fixed width
    // clipped it, which is how the wrong word hid in the first place.
    assert.ok(markGutterWidth(sectioned) > markGutterWidth(chaptered));
  });
});

describe('a mark’s name in a list', () => {
  it('prefers the name the file carries', () => {
    assert.equal(markTitle(sectioned, { title: 'Part 10' }, 9), 'Part 10');
  });

  it('unpads a number a ripper padded', () => {
    assert.equal(markTitle(chaptered, { title: 'Chapter 025' }, 24), 'Chapter 25');
  });

  it('falls back to the right word when the file names nothing', () => {
    assert.equal(markTitle(sectioned, { title: '' }, 9), 'Section 10');
    assert.equal(markTitle(chaptered, { title: '   ' }, 3), 'Chapter 4');
    assert.equal(markTitle(chaptered, {}, 0), 'Chapter 1');
  });
});
