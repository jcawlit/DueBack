/**
 * Where a next/previous chapter press lands.
 *
 * This moved out of the player store to be tested on its own, because it is
 * now reachable from two places: the arrows on the Player screen and the
 * **lock screen's own buttons**. A screen control that misbehaves is noticed
 * at once; a lock-screen button is pressed in a pocket, by someone walking,
 * who will be told nothing except that the book is suddenly somewhere else.
 *
 * The old version clamped out-of-range targets into the list:
 *
 *     const bounded = Math.max(0, Math.min(chapters.length - 1, target));
 *
 * which is wrong at the end of a book — pressing next in the final chapter
 * clamped to the final chapter and seeked to its start, restarting something
 * you were an hour into. Null, meaning do nothing, is the fix, and the last
 * two tests here are the reason it is not a clamp.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAPTER_RESTART_THRESHOLD_SEC,
  chapterSkipTarget,
} from '../src/lib/library/chapters.ts';
import type { Chapter } from '../src/data/types.ts';

/** Four chapters, a quarter of an hour each. Sorted, as `sanitiseChapters` leaves them. */
const CHAPTERS: Chapter[] = [
  { title: 'One', startSec: 0 },
  { title: 'Two', startSec: 900 },
  { title: 'Three', startSec: 1800 },
  { title: 'Four', startSec: 2700 },
];

const next = (at: number) => chapterSkipTarget(CHAPTERS, at, 1);
const back = (at: number) => chapterSkipTarget(CHAPTERS, at, -1);

describe('skipping to the next chapter', () => {
  it('goes to the start of the one after the one you are in', () => {
    assert.equal(next(0), 900);
    assert.equal(next(100), 900);
    assert.equal(next(899), 900);
    assert.equal(next(900), 1800);
  });

  it('refuses at the end rather than restarting the last chapter', () => {
    /*
     * The bug this function exists to fix. Clamping sent you to 2700 — the
     * start of the chapter you were already an hour into — every time the
     * button was pressed, and on the lock screen nothing would explain it.
     */
    assert.equal(next(2700), null);
    assert.equal(next(5000), null);
  });
});

describe('skipping to the previous chapter', () => {
  it('restarts the chapter you are in once you are into it', () => {
    // What every music player does, and for the same reason: you press this
    // because you missed something, and usually you mean this chapter.
    assert.equal(back(1800 + CHAPTER_RESTART_THRESHOLD_SEC + 1), 1800);
    assert.equal(back(2000), 1800);
  });

  it('goes to the one before when you have only just arrived', () => {
    assert.equal(back(1800), 900);
    assert.equal(back(1800 + CHAPTER_RESTART_THRESHOLD_SEC), 900);
  });

  it('is exact about the threshold rather than near it', () => {
    // Exactly at the boundary counts as having just arrived; a second past it
    // does not. Pinned because an off-by-one here is a button that sometimes
    // does one thing and sometimes the other.
    const edge = 900 + CHAPTER_RESTART_THRESHOLD_SEC;
    assert.equal(chapterSkipTarget(CHAPTERS, edge, -1), 0);
    assert.equal(chapterSkipTarget(CHAPTERS, edge + 1, -1), 900);
  });

  it('restarts the first chapter rather than refusing', () => {
    // Going back off the front is the one place a clamp is right: restarting
    // chapter one is what somebody pressing previous at the start means, and
    // it is what the threshold does everywhere else anyway.
    assert.equal(back(0), 0);
    assert.equal(back(2), 0);
  });

  it('takes the threshold as an argument so it is not a hidden constant', () => {
    // Five seconds into chapter two. A *longer* threshold is a longer window
    // in which "previous" still means the previous chapter, so it goes back;
    // a shorter one has already expired, so it restarts chapter two.
    assert.equal(chapterSkipTarget(CHAPTERS, 905, -1, 10), 0);
    assert.equal(chapterSkipTarget(CHAPTERS, 905, -1, 1), 900);
  });
});

describe('a book with nothing to skip between', () => {
  it('goes nowhere in either direction', () => {
    /*
     * A single file with no embedded chapters. `chapterAt` reports one
     * chapter spanning the book so the screens have something to draw, but
     * there is nothing to navigate, and this is what the lock screen asks
     * before deciding whether to show the buttons at all.
     */
    assert.equal(chapterSkipTarget([], 0, 1), null);
    assert.equal(chapterSkipTarget([], 500, -1), null);
  });

  it('handles a single chapter the same way', () => {
    const one: Chapter[] = [{ title: 'The whole thing', startSec: 0 }];
    assert.equal(chapterSkipTarget(one, 0, 1), null);
    assert.equal(chapterSkipTarget(one, 4000, 1), null);
    // Back still restarts it, which is the useful thing a one-chapter book
    // can do.
    assert.equal(chapterSkipTarget(one, 4000, -1), 0);
  });
});

describe('a position that is not in any chapter yet', () => {
  it('treats a position before the first mark as the first chapter', () => {
    // `sanitiseChapters` clamps negative starts to zero, so a gap at the
    // front should not happen — but a list from somewhere else might have
    // one, and falling off the start of the array must not crash a button.
    const late: Chapter[] = [
      { title: 'One', startSec: 60 },
      { title: 'Two', startSec: 120 },
    ];
    assert.equal(chapterSkipTarget(late, 0, 1), 120);
    assert.equal(chapterSkipTarget(late, 0, -1), 60);
  });
});
