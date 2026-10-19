/**
 * A streaming session, and the accounting it owes the server.
 *
 * One reporting channel per listen. A streamed book reports **only**
 * through its session: never also a progress PATCH, never a second session
 * uploaded afterwards. The server sums `timeListened` across every session
 * row it holds, so reporting twice does not merely duplicate a position —
 * it inflates the listener's statistics for ever, and nothing ever
 * subtracts it again.
 *
 * Two rules do most of the work here:
 *
 * **`timeListened` is a delta, not a total.** It is the seconds listened
 * since the last *successful* sync. The counter therefore resets on a 200
 * and on nothing else — a failed sync must carry its seconds forward into
 * the next one, or they are simply lost.
 *
 * **Sessions live in the server's memory.** A restart, a close, or a newer
 * `/play` from this same device ends one. A 404 is routine and means "open
 * another", not "something has gone wrong", so it is answered quietly.
 */

import type { AbsClient, AbsSessionInfo } from './client';

/** How often a playing book reports in. */
export const SYNC_INTERVAL_MS = 15_000;

export type SessionEvents = {
  /** A new session replaced the old one; its tracks must be played. */
  onReopened?: (session: AbsSessionInfo) => void;
  /** Reopening failed. Playback should carry on from the local position. */
  onLost?: (reason: string) => void;
};

/**
 * Looks after one open session for one book.
 *
 * Deliberately knows nothing about audio. It is handed positions and told
 * when time has passed; what plays them is the player's business, which is
 * what makes the whole lifecycle testable against a fake client.
 */
export class StreamSession {
  private readonly client: AbsClient;
  private readonly itemId: string;
  private readonly deviceId: string;
  private readonly durationSec: number;
  private readonly events: SessionEvents;

  private info: AbsSessionInfo | null = null;
  /** Seconds listened since the last sync the server accepted. */
  private pendingSeconds = 0;
  /** Guards against two reopen attempts racing after a burst of 404s. */
  private reopening: Promise<AbsSessionInfo | null> | null = null;
  private closed = false;

  constructor(
    client: AbsClient,
    itemId: string,
    deviceId: string,
    durationSec: number,
    events: SessionEvents = {},
  ) {
    this.client = client;
    this.itemId = itemId;
    this.deviceId = deviceId;
    this.durationSec = durationSec;
    this.events = events;
  }

  get current(): AbsSessionInfo | null {
    return this.info;
  }

  get unreportedSeconds(): number {
    return this.pendingSeconds;
  }

  /** Opens the first session. Throws if the server will not start one. */
  async open(): Promise<AbsSessionInfo> {
    const session = await this.client.openSession(this.itemId, this.deviceId);
    this.info = session;
    this.closed = false;
    return session;
  }

  /** Notes seconds of listening, to be reported on the next sync. */
  listened(seconds: number): void {
    if (seconds > 0) this.pendingSeconds += seconds;
  }

  /**
   * Reports in, and reopens once if the session has gone.
   *
   * Returns false when there is no session to report to and one could not
   * be made — the caller keeps playing from where it is and the position
   * stays correct locally.
   */
  async sync(currentTime: number): Promise<boolean> {
    if (this.closed || !this.info) return false;

    const seconds = this.pendingSeconds;
    const body = {
      currentTime,
      timeListened: Math.round(seconds),
      duration: this.durationSec,
    };

    let alive: boolean;
    try {
      alive = await this.client.syncSession(this.info.id, body);
    } catch (error) {
      /*
       * A failed sync keeps its seconds. They belong to the next attempt,
       * because the server has not counted them — dropping them here is
       * how listening quietly disappears on a flaky connection.
       */
      console.warn('[abs] a session sync failed; its seconds carry forward', error);
      return false;
    }

    if (alive) {
      // The only place the counter resets: the server took them.
      this.pendingSeconds -= seconds;
      return true;
    }

    const reopened = await this.reopen(currentTime);
    return reopened !== null;
  }

  /**
   * Opens a replacement session at the current position, once.
   *
   * The seconds owed are *not* carried across. They were listened to under
   * a session the server has forgotten, and attributing them to a new one
   * would count time the new session never saw.
   */
  private async reopen(currentTime: number): Promise<AbsSessionInfo | null> {
    if (this.reopening) return this.reopening;

    this.reopening = (async () => {
      try {
        const session = await this.client.openSession(this.itemId, this.deviceId);
        this.info = session;
        this.pendingSeconds = 0;
        // The new session starts wherever the server put it, which may not
        // be where the listener is; tell it at once.
        await this.client
          .syncSession(session.id, { currentTime, timeListened: 0, duration: this.durationSec })
          .catch(() => false);
        this.events.onReopened?.(session);
        return session;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn('[abs] could not reopen the session', error);
        this.info = null;
        this.events.onLost?.(reason);
        return null;
      } finally {
        this.reopening = null;
      }
    })();

    return this.reopening;
  }

  /**
   * Ends the session, with one final sync riding the close.
   *
   * Safe to call twice: closing an already-closed session is what pausing
   * then leaving the screen looks like, and it must not report the tail a
   * second time.
   */
  async close(currentTime: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const session = this.info;
    this.info = null;
    if (!session) return;

    const seconds = this.pendingSeconds;
    this.pendingSeconds = 0;
    try {
      await this.client.closeSession(session.id, {
        currentTime,
        timeListened: Math.round(seconds),
        duration: this.durationSec,
      });
    } catch (error) {
      // Nothing useful remains to be done: the position is already correct
      // locally and the server drops an abandoned session by itself.
      console.warn('[abs] could not close the session cleanly', error);
    }
  }
}

/**
 * Whether the engine can play these tracks directly, or must take the HLS
 * stream the server is transcoding.
 *
 * Direct tracks are ordinary files and go through the Authorization header
 * like every other request. The HLS url is the single unauthenticated
 * address in the system, and it is safe because the session id in it is
 * unguessable and dies with the session — unlike an account token, which
 * would outlive the URL it was pasted into.
 */
export function isTranscode(session: AbsSessionInfo): boolean {
  return session.playMethod === 2;
}
