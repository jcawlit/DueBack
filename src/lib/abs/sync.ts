/**
 * Keeping a place in a book honest across devices.
 *
 * One rule, applied in both directions and in one function so that the
 * screen that opens a book and the throttle that pushes progress cannot
 * disagree: **fetch the server's record, compare its `lastUpdate` with our
 * own `progress_updated_at`, and let the newer write win.**
 *
 * What the two sides own is not symmetrical, and that shapes everything
 * here. The client owns `currentTime` and may always send it. The server
 * stores `currentTime` and `isFinished` from a PATCH and ignores the
 * `progress` fraction, which is its own and moves only through playback
 * sessions — so the position is carried by `currentTime` and compared by
 * `lastUpdate`, never by that fraction.
 *
 * A server that cannot be reached is not an error. Playing a downloaded
 * book offline is the normal case, and the next successful check reconciles.
 */

import { chooseProgress, type LocalPlace, type ServerPlace } from './progress.ts';
import type { AbsClient } from './client';

export type Reconciliation =
  /** The server was ahead; its position has been taken. */
  | { outcome: 'adopted'; positionSec: number; isFinished: boolean; serverLastUpdate: number }
  /** We are ahead, or the server has no record. Ours stands and may be sent. */
  | { outcome: 'local-newer'; positionSec: number }
  /** Nothing to do: the two already agree. */
  | { outcome: 'in-step' }
  /** No answer. Keep playing; try again next time. */
  | { outcome: 'offline' };

/**
 * Works out which side is ahead, without writing anything.
 *
 * Deliberately returns a decision rather than acting on it: the caller knows
 * whether it is about to play a book (adopt, and say so) or about to push
 * (send only if we are ahead), and both need the same comparison.
 */
export async function reconcile(
  client: AbsClient | null,
  remoteId: string,
  local: LocalPlace,
): Promise<Reconciliation> {
  if (!client) return { outcome: 'offline' };

  let server: ServerPlace | null;
  try {
    server = await client.progress(remoteId);
  } catch (error) {
    // Unreachable, or a server that will not answer for this book. Neither
    // is worth interrupting a listener over.
    console.warn(`[abs] could not read the saved place for ${remoteId}`, error);
    return { outcome: 'offline' };
  }

  const choice = chooseProgress(server, local);
  if (choice.take === 'server' && server) {
    // Same second, same place: nothing happened on either side.
    if (Math.round(server.currentTime) === Math.round(local.positionSec)) {
      return { outcome: 'in-step' };
    }
    return {
      outcome: 'adopted',
      positionSec: server.currentTime,
      isFinished: server.isFinished === true,
      serverLastUpdate: server.lastUpdate,
    };
  }
  return { outcome: 'local-newer', positionSec: local.positionSec };
}

/**
 * Sends our place, but only when ours is the newer one.
 *
 * The re-check is not redundant. Between the last comparison and now the
 * same account may have listened on another device, and a blind PATCH would
 * overwrite a newer position with an older one — the one failure mode that
 * loses something the listener cannot get back by waiting.
 */
export async function pushIfAhead(
  client: AbsClient | null,
  remoteId: string,
  local: LocalPlace & { durationSec: number; isFinished: boolean },
): Promise<Reconciliation> {
  const decision = await reconcile(client, remoteId, local);
  if (decision.outcome !== 'local-newer' || !client) return decision;

  try {
    await client.pushProgress(remoteId, {
      currentTime: local.positionSec,
      duration: local.durationSec,
      isFinished: local.isFinished,
    });
  } catch (error) {
    // Silent, and retried by the next change. A listener who is walking
    // should not be told that a server they are not using is busy.
    console.warn(`[abs] could not save the place for ${remoteId}`, error);
    return { outcome: 'offline' };
  }
  return decision;
}

/**
 * How long to sit on a position before sending it.
 *
 * Progress is written locally every few seconds of playback. Sending each
 * one would be a request every few seconds for as long as somebody listens,
 * for a number that only matters when they stop or pick up elsewhere. The
 * same reasoning, and roughly the same interval, as the drive backup's
 * handling of progress writes.
 */
export const PUSH_INTERVAL_MS = 60_000;

/**
 * Collects progress changes and pushes at most one per interval, per book.
 *
 * Not a queue: a later position supersedes an earlier one completely, so
 * only the most recent matters. The timer is per book because two books
 * cannot be playing at once but one can be finished while another is
 * resumed, and a shared timer would drop one of them.
 */
export function createPushScheduler(
  send: (bookId: string) => Promise<void>,
  intervalMs = PUSH_INTERVAL_MS,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    /** Notes that a book's position moved. Pushes once the interval is up. */
    schedule(bookId: string) {
      // One already waiting covers this change too: it will read the
      // position at the moment it fires, which by then is this one or newer.
      if (timers.has(bookId)) return;
      timers.set(
        bookId,
        setTimeout(() => {
          timers.delete(bookId);
          void send(bookId);
        }, intervalMs),
      );
    },
    /** Sends now, for a pause or the app going away. */
    async flush(bookId: string) {
      const timer = timers.get(bookId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(bookId);
      }
      await send(bookId);
    },
    pending() {
      return [...timers.keys()];
    },
    cancelAll() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
