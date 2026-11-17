/**
 * Noticing when listening starts and stops.
 *
 * The player reports its status several times a second; this turns that into
 * one row per stretch. It holds the open stretch in module state rather than
 * in the player store, for the same reason the engine does: a value that
 * changes on every status update has no business re-rendering anything.
 *
 * What counts as a stretch ending: pausing, closing the book, the sleep timer
 * running out, or opening a different book. Not the app going to the
 * background — playback carries on in a pocket, and that is the listening
 * this is for.
 */

import { closeSession, openSession, touchSession } from '@/db/listening';

/** How often an open stretch is nudged along in the database. */
const TOUCH_EVERY_MS = 30_000;

type Open = {
  id: string | null;
  bookId: string;
  startedAtMs: number;
  seconds: number;
  lastTouchMs: number;
  /** Set while the row is being created, so a flurry of statuses opens one. */
  opening: boolean;
};

let open: Open | null = null;

/** Starts a stretch, or extends the one already running. */
function begin(bookId: string, nowMs: number) {
  open = {
    id: null,
    bookId,
    startedAtMs: nowMs,
    seconds: 0,
    lastTouchMs: nowMs,
    opening: true,
  };
  const startedAt = new Date(nowMs).toISOString();
  const mine = open;
  void openSession(bookId, startedAt)
    .then((id) => {
      // Only if this is still the stretch that asked. A pause during the
      // write would otherwise attach the row to a stretch already over.
      if (open === mine) open.id = id;
      else void closeSession(id, startedAt, mine.seconds);
    })
    .catch(() => {
      // No row means no history for this stretch, which is a loss worth
      // taking in silence: the alternative is interrupting playback.
    })
    .finally(() => {
      if (open === mine) mine.opening = false;
    });
}

function end(nowMs: number) {
  const closing = open;
  open = null;
  if (!closing) return;
  const endedAt = new Date(nowMs).toISOString();
  if (closing.id) void closeSession(closing.id, endedAt, closing.seconds).catch(() => {});
  // A stretch whose row never arrived has nothing to close; `openSession`'s
  // own handler discards it.
}

/**
 * Called on every status from the player.
 *
 * `playing` is the only thing that matters here, and the position is not used
 * at all: a stretch is wall-clock time with the audio running, which is what
 * "how long did I listen" means. Counting position instead would make a book
 * played at 1.5× look like two thirds of the time it actually took.
 */
export function noteStatus(bookId: string | null, playing: boolean, nowMs = Date.now()) {
  if (!bookId || !playing) {
    if (open) end(nowMs);
    return;
  }
  if (open && open.bookId !== bookId) {
    // A different book, which ends the stretch and starts another.
    end(nowMs);
  }
  if (!open) {
    begin(bookId, nowMs);
    return;
  }
  open.seconds = (nowMs - open.startedAtMs) / 1000;
  if (open.id && nowMs - open.lastTouchMs >= TOUCH_EVERY_MS) {
    open.lastTouchMs = nowMs;
    void touchSession(open.id, new Date(nowMs).toISOString(), open.seconds).catch(() => {});
  }
}

/** Ends whatever is open. For a book closing, or the app shutting down. */
export function noteStopped(nowMs = Date.now()) {
  if (open) end(nowMs);
}

/** Visible for tests: whether a stretch is being counted right now. */
export function isCounting(): boolean {
  return open !== null;
}
