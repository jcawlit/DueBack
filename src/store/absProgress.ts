/**
 * Sending a downloaded book's place back to the server it came from.
 *
 * The one reporting channel for a downloaded book. No playback sessions are
 * opened for local files and nothing uploads a session afterwards: the
 * server learns where the listener is from this PATCH and from nothing
 * else. (Streaming, when it arrives, is the opposite rule — it reports
 * through its session and never through here. Two channels for one position
 * is how a position gets written twice and read back wrong.)
 *
 * Hooked to the same `onReadingDataChanged` trigger the drive backup uses,
 * and throttled for the same reason: progress is written every few seconds
 * of playback, and a request per write is a request per few seconds for a
 * number that only matters when somebody stops or picks up elsewhere.
 */

import { onReadingDataChanged } from '@/lib/sync/changes';
import { createPushScheduler, pushIfAhead, reconcile } from '@/lib/abs/sync';
import { adoptServerProgress, remotePlace } from '@/db/remoteBooks';
import { useSources } from './sources';
import { useLibrary } from './library';

/** The last thing that happened for a book, for the testing screens. */
export type PushState = { at: string; outcome: string };

const lastPush = new Map<string, PushState>();

export function lastPushFor(bookId: string): PushState | undefined {
  return lastPush.get(bookId);
}

/**
 * Reconciles one book and sends our position if it is the newer one.
 *
 * Everything here is best-effort and silent. A listener walking with the
 * phone in a pocket should never be told that a server they are not using
 * did not answer; the next change tries again.
 */
async function pushOne(bookId: string): Promise<void> {
  const place = await remotePlace(bookId).catch(() => null);
  if (!place) return;

  const client = await useSources.getState().clientFor(place.sourceId).catch(() => null);
  if (!client) {
    lastPush.set(bookId, { at: new Date().toISOString(), outcome: 'no credentials' });
    return;
  }

  const decision = await pushIfAhead(client, place.remoteId, {
    positionSec: place.positionSec,
    updatedAt: place.updatedAt,
    durationSec: place.durationSec,
    isFinished: place.isFinished,
  });

  /*
   * The server turned out to be ahead. That happens when the same account
   * has been listening elsewhere since the last check, and taking its
   * position here is the whole point of comparing before sending.
   */
  if (decision.outcome === 'adopted') {
    await adoptServerProgress(
      bookId,
      decision.positionSec,
      decision.serverLastUpdate,
      decision.isFinished,
    );
    await useLibrary.getState().refresh();
  }

  lastPush.set(bookId, { at: new Date().toISOString(), outcome: decision.outcome });
}

const scheduler = createPushScheduler(pushOne);

/** Sends now rather than at the end of the interval — a pause, or leaving. */
export async function flushProgressPush(bookId: string): Promise<void> {
  await scheduler.flush(bookId);
}

export function pendingProgressPushes(): string[] {
  return scheduler.pending();
}

let started = false;

/**
 * Starts listening. Called once, from the app's root layout.
 *
 * Idempotent, because a fast refresh re-runs the module and a second
 * listener would double every push.
 */
export function startAbsProgressSync(): void {
  if (started) return;
  started = true;
  onReadingDataChanged((kind, bookId) => {
    // Only a position moving, and only for a book that came from a server.
    // `remotePlace` returns null for anything on the drive, so the schedule
    // is cheap to arm and decides nothing on its own.
    if (kind !== 'progress' || !bookId) return;
    scheduler.schedule(bookId);
  });
}

/**
 * How long playback will wait for the server to say where the listener is.
 *
 * A bound, not a timeout to be tuned. Starting a book at the wrong place is
 * worse than a short pause, and a server that cannot be reached must not
 * hold up a download that is already on the phone — so the wait is short
 * and failing it costs nothing but a stale position until the next check.
 */
const BEFORE_PLAY_WAIT_MS = 3000;

/**
 * Settles the position before a book starts playing.
 *
 * This is the chokepoint. Reconciling when a screen opened was not enough:
 * the mini player, "Keep listening", the checked-out tray and the player
 * route all reach playback without passing that screen, and even on the
 * screen that did it, pressing Play before the round trip finished started
 * from the stale position. Every route to playback goes through
 * `player.open`, so the comparison belongs there.
 *
 * Returns the adopted position when the server was ahead, so the caller can
 * both start there and say so.
 */
export async function reconcileBeforePlay(bookId: string): Promise<number | null> {
  const place = await remotePlace(bookId).catch(() => null);
  if (!place) return null;

  const settle = (async () => {
    const client = await useSources.getState().clientFor(place.sourceId).catch(() => null);
    if (!client) return null;
    const decision = await reconcile(client, place.remoteId, {
      positionSec: place.positionSec,
      updatedAt: place.updatedAt,
    });
    if (decision.outcome !== 'adopted') return null;

    await adoptServerProgress(
      bookId,
      decision.positionSec,
      decision.serverLastUpdate,
      decision.isFinished,
    );
    await useLibrary.getState().refresh();
    return decision.positionSec;
  })();

  // Whichever comes first. A slow server delays a book by three seconds
  // once; it never stops one playing.
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), BEFORE_PLAY_WAIT_MS));
  try {
    return await Promise.race([settle, timeout]);
  } catch (error) {
    console.warn(`[abs] could not settle the place for ${bookId} before playing`, error);
    return null;
  }
}
