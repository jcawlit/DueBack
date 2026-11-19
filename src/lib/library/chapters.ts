/**
 * Making a chapter list fit to navigate with.
 *
 * Chapter data in real files is often junk: written out of order, with two
 * marks at the same instant, with a mark past the end of the audio, or with no
 * titles at all. Everything downstream assumes a sorted list — `chapterAt`
 * walks it in order, the scrubber measures against it, and previous/next step
 * through it — so it is cleaned once at scan time rather than defended against
 * in five places.
 */

import type { Chapter } from '@/data/types';

/**
 * Sorts, deduplicates and names a chapter list.
 *
 * - ordered by start time, because nothing downstream re-sorts
 * - negative starts clamped to zero
 * - marks at or past the end of the book dropped: they can never be reached,
 *   and one of them would otherwise swallow the end of the scrubber
 * - several marks at the same instant collapsed to the first
 * - blank titles replaced with "Chapter N", so the lock screen never shows an
 *   empty line where the chapter should be
 *
 * `durationSec` of zero means the duration is not known yet, in which case no
 * chapter is dropped for being too late.
 */
export function sanitiseChapters(chapters: Chapter[], durationSec: number): Chapter[] {
  if (chapters.length === 0) return [];

  const ordered = chapters
    .map((c) => ({ ...c, startSec: Math.max(0, c.startSec) }))
    .filter((c) => Number.isFinite(c.startSec))
    .filter((c) => durationSec <= 0 || c.startSec < durationSec)
    .sort((a, b) => a.startSec - b.startSec);

  const unique: Chapter[] = [];
  for (const chapter of ordered) {
    const previous = unique[unique.length - 1];
    if (previous && previous.startSec === chapter.startSec) continue;
    unique.push(chapter);
  }

  return unique.map((chapter, index) => ({
    ...chapter,
    title: chapter.title.trim() || `Chapter ${index + 1}`,
  }));
}

/**
 * How far back into a chapter you can be and still have "previous" mean the
 * start of this one rather than the one before it.
 *
 * The behaviour every music player has, and the reason is the same: you press
 * previous because you missed something, and almost always you mean the thing
 * you are in.
 */
export const CHAPTER_RESTART_THRESHOLD_SEC = 3;

/**
 * Where a next/previous press lands, on the whole-book timeline.
 *
 * Pulled out of the player store to be tested on its own, because it is now
 * reachable from the lock screen as well as from the screen — and a lock
 * screen button is the one control nobody can watch while it misbehaves.
 *
 * Returns null when there is nowhere to go: no chapters at all, or already in
 * the last chapter pressing next. Null means **do nothing**, which matters —
 * seeking to where you already are would restart a chapter somebody is
 * halfway through, and clamping "next" to the final chapter does exactly
 * that every time it is pressed at the end of a book.
 */
export function chapterSkipTarget(
  chapters: Chapter[],
  positionSec: number,
  direction: 1 | -1,
  restartThresholdSec: number = CHAPTER_RESTART_THRESHOLD_SEC,
): number | null {
  if (chapters.length === 0) return null;

  // The chapter holding the position: the last one that has started. The list
  // is sorted by `sanitiseChapters`, which is what lets this stop early.
  let index = 0;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].startSec <= positionSec) index = i;
    else break;
  }

  const intoChapter = positionSec - chapters[index].startSec;
  const target =
    direction === -1 && intoChapter > restartThresholdSec ? index : index + direction;

  // Off either end is nowhere to go. Going back from the first chapter is the
  // one exception: restarting it is what somebody pressing previous at the
  // beginning of a book means, and it is what the threshold above already
  // does everywhere else.
  if (target < 0) return direction === -1 ? chapters[0].startSec : null;
  if (target > chapters.length - 1) return null;
  return chapters[target].startSec;
}
