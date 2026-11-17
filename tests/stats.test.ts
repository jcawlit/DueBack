/**
 * What the listening log adds up to.
 *
 * Date arithmetic is the whole risk here, and it fails on boundaries: the
 * stretch that started yesterday evening, the streak looked at before you
 * have listened today, the week that straddles a month. `summarise` takes
 * `now` as an argument precisely so those can be sat on deliberately.
 *
 * Local days throughout, because "I listened every day this week" is a claim
 * about the listener's days and not about UTC's.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localDay, summarise } from '../src/lib/stats/summary.ts';
import type { Session } from '../src/db/listening.ts';

/** Local midnight `offset` days before `now`, plus some hours into the day. */
function at(now: Date, offsetDays: number, hour = 12): string {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString();
}

let next = 0;
function session(startedAt: string, seconds: number, bookId = 'b1'): Session {
  next += 1;
  const begins = Date.parse(startedAt);
  return {
    id: `s${next}`,
    bookId,
    startedAt,
    // A start that does not parse has no end to compute, which is exactly
    // the row `summarise` has to survive.
    endedAt: Number.isFinite(begins)
      ? new Date(begins + seconds * 1000).toISOString()
      : startedAt,
    seconds,
  };
}

/** A fixed afternoon, so nothing here depends on when the suite runs. */
const NOW = new Date(2026, 10, 17, 15, 30, 0);
const nowMs = NOW.getTime();

describe('adding up the log', () => {
  it('says nothing happened when nothing has', () => {
    const s = summarise([], nowMs);
    assert.equal(s.totalSec, 0);
    assert.equal(s.sessions, 0);
    assert.equal(s.streakDays, 0);
    assert.equal(s.daysListened, 0);
    assert.equal(s.busiestWeekday, null, 'no busiest day rather than Sunday');
    assert.equal(s.averagePerActiveDaySec, 0, 'no divide by zero');
    assert.deepEqual(s.byBook, []);
  });

  it('totals the stretches and counts them', () => {
    const s = summarise([session(at(NOW, 0), 600), session(at(NOW, 1), 1200)], nowMs);
    assert.equal(s.totalSec, 1800);
    assert.equal(s.sessions, 2);
    assert.equal(s.longestSessionSec, 1200);
  });

  it('files a stretch under the local day it started in', () => {
    // A stretch starting at 11pm belongs to that evening, not to the next
    // morning — which is what UTC would say for half the world.
    const evening = at(NOW, 0, 23);
    assert.equal(localDay(evening), localDay(at(NOW, 0, 9)));
    assert.equal(summarise([session(evening, 300)], nowMs).daysListened, 1);
  });

  it('counts today, the last week and the last month separately', () => {
    const s = summarise(
      [
        session(at(NOW, 0), 100),
        session(at(NOW, 3), 200),
        session(at(NOW, 20), 400),
        session(at(NOW, 200), 800),
      ],
      nowMs,
    );
    assert.equal(s.todaySec, 100);
    assert.equal(s.weekSec, 300, 'today plus three days ago');
    assert.equal(s.monthSec, 700, 'and twenty days ago');
    assert.equal(s.totalSec, 1500, 'the old one still counts in the total');
  });

  it('ignores a row with no readable start, and one with no length', () => {
    const s = summarise(
      [
        session('not a date', 600),
        { ...session(at(NOW, 0), 0), seconds: 0 },
        session(at(NOW, 0), 60),
      ],
      nowMs,
    );
    assert.equal(s.sessions, 1);
    assert.equal(s.totalSec, 60);
  });
});

describe('streaks', () => {
  it('counts consecutive days up to today', () => {
    const s = summarise(
      [session(at(NOW, 0), 60), session(at(NOW, 1), 60), session(at(NOW, 2), 60)],
      nowMs,
    );
    assert.equal(s.streakDays, 3);
  });

  it('does not break a streak just because today has not happened yet', () => {
    /*
     * Someone opening this at nine in the morning has not lost the streak
     * they are about to continue. Counting from yesterday when today is
     * empty is the difference between a figure that encourages and one that
     * punishes you for looking early.
     */
    const s = summarise([session(at(NOW, 1), 60), session(at(NOW, 2), 60)], nowMs);
    assert.equal(s.streakDays, 2);
  });

  it('is zero when the last listening was the day before yesterday', () => {
    const s = summarise([session(at(NOW, 2), 60), session(at(NOW, 3), 60)], nowMs);
    assert.equal(s.streakDays, 0, 'the run has already been broken');
    assert.equal(s.longestStreakDays, 2, 'but it happened');
  });

  it('finds the longest run anywhere in the log', () => {
    const s = summarise(
      [
        session(at(NOW, 40), 60),
        session(at(NOW, 39), 60),
        session(at(NOW, 38), 60),
        session(at(NOW, 37), 60),
        session(at(NOW, 10), 60),
        session(at(NOW, 0), 60),
      ],
      nowMs,
    );
    assert.equal(s.longestStreakDays, 4);
    assert.equal(s.streakDays, 1, 'today alone');
  });

  it('counts several stretches in one day as one day', () => {
    const s = summarise(
      [session(at(NOW, 0, 9), 60), session(at(NOW, 0, 14), 60), session(at(NOW, 0, 21), 60)],
      nowMs,
    );
    assert.equal(s.daysListened, 1);
    assert.equal(s.streakDays, 1);
    assert.equal(s.sessions, 3);
  });
});

describe('what it says about habits', () => {
  it('averages over the days you listened, not over the calendar', () => {
    // Two hours across two days is an hour a day, however long ago they were.
    const s = summarise([session(at(NOW, 0), 3600), session(at(NOW, 100), 3600)], nowMs);
    assert.equal(s.averagePerActiveDaySec, 3600);
  });

  it('names the busiest weekday', () => {
    // NOW is a Tuesday; seven days back is the Tuesday before.
    const s = summarise(
      [session(at(NOW, 0), 3600), session(at(NOW, 7), 3600), session(at(NOW, 1), 60)],
      nowMs,
    );
    assert.equal(s.busiestWeekday, NOW.getDay());
  });

  it('ranks books by time, longest first', () => {
    const s = summarise(
      [
        session(at(NOW, 0), 600, 'short'),
        session(at(NOW, 1), 3600, 'long'),
        session(at(NOW, 2), 1800, 'long'),
      ],
      nowMs,
    );
    assert.deepEqual(s.byBook.map((b) => b.bookId), ['long', 'short']);
    assert.equal(s.byBook[0].seconds, 5400);
    assert.equal(s.byBook[0].sessions, 2);
  });
});

describe('the run of recent days', () => {
  it('gives a row of days ending today, oldest first', () => {
    const s = summarise([session(at(NOW, 0), 60)], nowMs, 14);
    assert.equal(s.recentDays.length, 14);
    assert.equal(s.recentDays[13].day, localDay(nowMs), 'today is last');
    assert.equal(s.recentDays[13].seconds, 60);
  });

  it('includes the days with nothing on them', () => {
    // A gap is information: a chart that skipped empty days would show a
    // fortnight of listening that never happened.
    const s = summarise([session(at(NOW, 0), 60)], nowMs, 5);
    assert.deepEqual(
      s.recentDays.map((d) => d.seconds),
      [0, 0, 0, 0, 60],
    );
  });
});
