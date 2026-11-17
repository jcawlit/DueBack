/**
 * The listening log: one row per stretch of playing.
 *
 * Written while a book plays, but nowhere near as often as the position is.
 * Progress is persisted every five seconds; a row here is opened when
 * playback starts, nudged along while it runs, and closed when it stops. The
 * nudging is local only — the backup is told once, at the end — because a
 * table fed at tick rate is the mistake the knowledge base already records
 * against the drive backup. `npm run kb -- "position tick"`.
 *
 * Nudged rather than written only at the end, because an app that is killed
 * mid-chapter should lose seconds of history and not an hour of it.
 */

import { readingDataChanged } from '@/lib/sync/changes';
import { withLockRetry } from './books';
import { newId } from './notes';
import { getDb } from './schema';
import { ensureDeviceId } from './identity';

export type Session = {
  id: string;
  bookId: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
};

let cachedDevice: string | null = null;
async function stamp(): Promise<{ at: string; mutationId: string; device: string }> {
  if (!cachedDevice) cachedDevice = await ensureDeviceId();
  return { at: new Date().toISOString(), mutationId: newId(), device: cachedDevice };
}

/** Opens a row, and hands back its id so it can be nudged and closed. */
export async function openSession(bookId: string, startedAt: string): Promise<string> {
  const db = await getDb();
  const { at, mutationId, device } = await stamp();
  const id = newId();
  await withLockRetry(() =>
    db.runAsync(
      `INSERT INTO listening (id, book_id, started_at, ended_at, seconds,
                              updated_at, writer_device, mutation_id)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      id, bookId, startedAt, startedAt, at, device, mutationId,
    ),
  );
  return id;
}

/**
 * Moves a row's end along.
 *
 * Deliberately silent: no `readingDataChanged`, because this runs while a
 * book plays and telling the backup at that rate is what it must never do.
 */
export async function touchSession(id: string, endedAt: string, seconds: number) {
  const db = await getDb();
  await withLockRetry(() =>
    db.runAsync(
      'UPDATE listening SET ended_at = ?, seconds = ? WHERE id = ?',
      endedAt, seconds, id,
    ),
  );
}

/**
 * Closes a row, and tells the backup this time.
 *
 * A stretch shorter than this is not listening — it is a finger on the wrong
 * button, or a book being skimmed to find a place. Those rows would bury the
 * real ones in any count of sessions.
 */
const SHORTEST_WORTH_KEEPING_SEC = 20;

export async function closeSession(id: string, endedAt: string, seconds: number) {
  const db = await getDb();
  if (seconds < SHORTEST_WORTH_KEEPING_SEC) {
    await withLockRetry(() => db.runAsync('DELETE FROM listening WHERE id = ?', id));
    return;
  }
  await touchSession(id, endedAt, seconds);
  readingDataChanged();
}

/** Every stretch, oldest first. */
export async function loadSessions(): Promise<Session[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string; book_id: string; started_at: string; ended_at: string; seconds: number;
  }>(
    `SELECT id, book_id, started_at, ended_at, seconds FROM listening
      ORDER BY started_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    bookId: r.book_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    seconds: r.seconds,
  }));
}

/**
 * Drops rows left open by a crash.
 *
 * A row whose seconds never grew is a stretch that produced no listening —
 * the app went away between opening it and the first nudge. Cleared at
 * startup rather than left to clutter every count for ever.
 */
export async function discardEmptySessions(): Promise<void> {
  const db = await getDb();
  await withLockRetry(() =>
    db.runAsync(`DELETE FROM listening WHERE seconds < ?`, SHORTEST_WORTH_KEEPING_SEC),
  );
}
