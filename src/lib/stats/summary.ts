/**
 * What the listening log adds up to.
 *
 * Pure, and takes `now` as an argument: every answer here is relative to a
 * moment ("this week", "the streak"), and a function that reads the clock
 * itself cannot be tested on a boundary — which is exactly where date
 * arithmetic goes wrong.
 *
 * Days are **local** days throughout. A session is filed under the day it
 * started in the listener's own timezone, because "I listened every day this
 * week" is a claim about their days and not about UTC's.
 */

import type { Session } from '@/db/listening';

export type Stats = {
  /** Every stretch ever recorded, in seconds. */
  totalSec: number;
  sessions: number;
  todaySec: number;
  weekSec: number;
  monthSec: number;
  /** Consecutive days up to and including today. */
  streakDays: number;
  longestStreakDays: number;
  /** Days with any listening at all. */
  daysListened: number;
  /** Mean over the days that had any, which is the honest average. */
  averagePerActiveDaySec: number;
  /** 0 = Sunday, matching `Date.getDay`. Null when there is nothing to say. */
  busiestWeekday: number | null;
  /** The longest single stretch. */
  longestSessionSec: number;
  /** Most-listened books, longest first. */
  byBook: { bookId: string; seconds: number; sessions: number }[];
  /** Seconds per local day, oldest first, for drawing a run of bars. */
  recentDays: { day: string; seconds: number }[];
};

/** `YYYY-MM-DD` in local time, which is the key every day-wise answer uses. */
export function localDay(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Midnight at the start of the local day `offset` days before `nowMs`. */
function dayStart(nowMs: number, offset = 0): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function summarise(
  sessions: Session[],
  nowMs: number,
  recentDayCount = 14,
): Stats {
  const usable = sessions.filter((s) => {
    const at = Date.parse(s.startedAt);
    // A row with no readable start cannot be filed under a day, and a
    // negative length is not a stretch. Neither is worth guessing about.
    return Number.isFinite(at) && s.seconds > 0;
  });

  const perDay = new Map<string, number>();
  const perBook = new Map<string, { seconds: number; sessions: number }>();
  const perWeekday = new Array<number>(7).fill(0);
  let totalSec = 0;
  let longestSessionSec = 0;

  for (const s of usable) {
    totalSec += s.seconds;
    longestSessionSec = Math.max(longestSessionSec, s.seconds);

    const day = localDay(s.startedAt);
    perDay.set(day, (perDay.get(day) ?? 0) + s.seconds);

    const book = perBook.get(s.bookId) ?? { seconds: 0, sessions: 0 };
    book.seconds += s.seconds;
    book.sessions += 1;
    perBook.set(s.bookId, book);

    perWeekday[new Date(s.startedAt).getDay()] += s.seconds;
  }

  const since = (ms: number) =>
    usable.reduce((sum, s) => (Date.parse(s.startedAt) >= ms ? sum + s.seconds : sum), 0);

  /*
   * The streak counts back from today, and today not having started yet does
   * not break it. Someone looking at this at nine in the morning has not
   * lost a streak they are about to continue, so the count starts at
   * yesterday when today is empty.
   */
  const has = (offset: number) => perDay.has(localDay(dayStart(nowMs, offset)));
  let streakDays = 0;
  let cursor = has(0) ? 0 : 1;
  if (has(cursor)) {
    while (has(cursor)) {
      streakDays += 1;
      cursor += 1;
    }
  }

  // The longest run anywhere in the log, found over the sorted day keys.
  const days = [...perDay.keys()].filter(Boolean).sort();
  let longestStreakDays = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of days) {
    const at = Date.parse(`${day}T00:00:00`);
    run = previous !== null && Math.round((at - previous) / DAY_MS) === 1 ? run + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, run);
    previous = at;
  }

  const recentDays: { day: string; seconds: number }[] = [];
  for (let i = recentDayCount - 1; i >= 0; i -= 1) {
    const day = localDay(dayStart(nowMs, i));
    recentDays.push({ day, seconds: perDay.get(day) ?? 0 });
  }

  const busiest = perWeekday.reduce(
    (best, seconds, index) => (seconds > perWeekday[best] ? index : best),
    0,
  );

  return {
    totalSec,
    sessions: usable.length,
    todaySec: since(dayStart(nowMs)),
    weekSec: since(dayStart(nowMs, 6)),
    monthSec: since(dayStart(nowMs, 29)),
    streakDays,
    longestStreakDays,
    daysListened: perDay.size,
    averagePerActiveDaySec: perDay.size > 0 ? totalSec / perDay.size : 0,
    busiestWeekday: perWeekday[busiest] > 0 ? busiest : null,
    longestSessionSec,
    byBook: [...perBook.entries()]
      .map(([bookId, v]) => ({ bookId, ...v }))
      .sort((a, b) => b.seconds - a.seconds),
    recentDays,
  };
}
