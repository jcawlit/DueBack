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
