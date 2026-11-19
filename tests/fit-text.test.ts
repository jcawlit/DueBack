/**
 * Sizing a line so it stays one line.
 *
 * `adjustsFontSizeToFit` is iOS-only and this app is Android, so the shrinking
 * is arithmetic and testable. What it has to get right: never grow past the
 * size asked for, never shrink past the floor, and leave text that already
 * fits completely alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fittedFontSize, fittedText, GLYPH_WIDTH } from '../src/lib/fitText.ts';

describe('fitting a line to its width', () => {
  it('leaves text that already fits at full size', () => {
    // "Library" in mono at 26 needs 7 * 0.6 * 26 ≈ 109px; it has 400.
    assert.equal(fittedFontSize('Library', 400, 26, 18, 'mono'), 26);
  });

  it('shrinks the title that wrapped, rather than wrapping it', () => {
    // "My Audiobooks" is 13 characters. At 26pt serif it needs
    // 13 * 0.58 * 26 ≈ 196px, which did not fit beside the source switcher.
    const narrow = 170;
    const fitted = fittedFontSize('My Audiobooks', narrow, 26, 18, 'serif');
    assert.ok(fitted < 26, `expected a smaller size, got ${fitted}`);
    assert.ok(fitted >= 18, `expected no smaller than the floor, got ${fitted}`);
    // And what it chose genuinely fits.
    assert.ok('My Audiobooks'.length * GLYPH_WIDTH.serif * fitted <= narrow);
  });

  it('never goes below the floor, however long the string', () => {
    const fitted = fittedFontSize('A'.repeat(200), 120, 26, 18, 'serif');
    assert.equal(fitted, 18);
  });

  it('never grows past the size asked for, however much room there is', () => {
    assert.equal(fittedFontSize('Hi', 10000, 26, 18, 'serif'), 26);
  });

  it('returns the full size before layout has measured anything', () => {
    // The first render has no width yet. Starting full and shrinking once
    // measured means text that fits never changes size at all.
    assert.equal(fittedFontSize('My Audiobooks', 0, 26, 18, 'serif'), 26);
    assert.equal(fittedFontSize('My Audiobooks', -1, 26, 18, 'serif'), 26);
  });

  it('handles an empty string without dividing by zero', () => {
    assert.equal(fittedFontSize('', 300, 11, 9, 'mono'), 11);
  });

  it('fits the subtitle that used to lose its end to an ellipsis', () => {
    const subtitle = '14 books · checked 32 mins ago';
    // Wide enough and it keeps its size; squeezed and it shrinks to the floor
    // rather than truncating.
    assert.equal(fittedFontSize(subtitle, 400, 11, 9, 'mono'), 11);
    assert.equal(fittedFontSize(subtitle, 150, 11, 9, 'mono'), 9);
  });
});

describe('the room kept for a line that shrinks', () => {
  /*
   * The Library header changed height when the source was switched, which
   * moved the divider under it and the row of sort chips below that. The
   * cause was here: the line height shrank along with the font, so "Library"
   * at full size and a server's library name shrunk to fit were two
   * different heights, and the whole header followed.
   *
   * The font still shrinks. The box no longer does.
   */
  const TITLE = { width: 190, size: 23, min: 16, ratio: 1.08 } as const;
  const title = (text: string) =>
    fittedText(text, TITLE.width, TITLE.size, TITLE.min, 'serif', TITLE.ratio);

  it('keeps one height for two titles that need two sizes', () => {
    const short = title('Library');
    const long = title('Dad’s Audiobooks And Radio Plays');

    // The thing that caused the bug: these genuinely differ.
    assert.ok(
      long.fontSize < short.fontSize,
      `expected the longer title to shrink, got ${long.fontSize} vs ${short.fontSize}`,
    );
    // The thing that fixes it.
    assert.equal(long.lineHeight, short.lineHeight);
  });

  it('keeps that height even for a title squeezed to the floor', () => {
    const floored = title('A Really Very Long Library Name That Goes On');
    assert.equal(floored.fontSize, TITLE.min);
    assert.equal(floored.lineHeight, title('Library').lineHeight);
  });

  it('reserves the full size’s line, not the fitted size’s', () => {
    // 23 × 1.08, rounded — never 16 × 1.08.
    assert.equal(title('Library').lineHeight, Math.round(TITLE.size * TITLE.ratio));
  });

  it('still reserves it before layout has measured anything', () => {
    // Width 0 is the first render. The size is full, and so is the line.
    const unmeasured = fittedText('Library', 0, 23, 16, 'serif', 1.08);
    assert.equal(unmeasured.fontSize, 23);
    assert.equal(unmeasured.lineHeight, Math.round(23 * 1.08));
  });
});
