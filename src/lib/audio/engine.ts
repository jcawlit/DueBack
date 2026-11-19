/**
 * The audio engine interface.
 *
 * Screens and the player store talk only to this. The expo-audio
 * implementation sits behind it so the engine can be replaced without
 * touching anything else — which matters, since the obvious alternative
 * (react-native-track-player) is ruled out on licensing grounds today but the
 * landscape may change.
 *
 * The whole interface is expressed in **whole-book seconds**. Multi-part books
 * are a detail the engine hides: callers never name a file.
 */

/** One audio file making up part of a book. */
export type EnginePart = {
  /** Playable location — a local copy, the drive, or a remote stream. */
  uri: string;
  /** Where this part begins on the whole-book timeline. */
  startSec: number;
  durationSec: number;
  /**
   * Sent with the request, for a part fetched over the network.
   *
   * This is how a streamed book carries its Authorization header, so no
   * credential ever has to be put in the URL. Absent for a local file,
   * which is every part of every book on the drive or on the phone.
   */
  headers?: Record<string, string>;
};

/** What a part looks like to the native player. */
export function sourceFor(part: EnginePart): { uri: string; headers?: Record<string, string> } {
  return part.headers ? { uri: part.uri, headers: part.headers } : { uri: part.uri };
}

export type EngineTrack = {
  bookId: string;
  /** Shown as the title on the lock screen. */
  title: string;
  /** Shown as the artist on the lock screen. */
  author?: string;
  /** Local file URI for the artwork, if we cached one. */
  artworkUri?: string;
  parts: EnginePart[];
  durationSec: number;
  /**
   * Whether this book has chapter marks to navigate between.
   *
   * The engine needs it because the lock screen's chapter buttons are decided
   * when the session is built, once per book, and a button that cannot do
   * anything is worse than no button. A single file with nothing embedded in
   * it genuinely has no chapters — `chapterAt` reports one spanning the whole
   * book so the screens have something to draw, but there is nowhere to skip
   * to and the lock screen should not pretend otherwise.
   */
  hasChapters: boolean;
};

export type EngineStatus = {
  /** Position on the whole-book timeline. */
  positionSec: number;
  playing: boolean;
  /** True while the engine is loading or switching parts. */
  buffering: boolean;
  /** Set once the final part has played to its end. */
  finished: boolean;
  /** Index into `EngineTrack.parts`. */
  partIndex: number;
};

export type AudioEngine = {
  /** Prepares a book for playback at `positionSec`. Does not start playing. */
  load(track: EngineTrack, positionSec: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Seeks on the whole-book timeline, crossing part boundaries as needed. */
  seekTo(positionSec: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  /** Updates what the lock screen shows, e.g. when the chapter changes. */
  setNowPlaying(subtitle: string): Promise<void>;
  /** Stops playback and releases the native player. */
  unload(): Promise<void>;
  /** Subscribes to status. Returns an unsubscribe function. */
  subscribe(listener: (status: EngineStatus) => void): () => void;
  /**
   * Told whenever the native player behind this engine may have changed, and
   * given it — on load, and on every part change.
   *
   * Platform audio effects attach to a *session*, which belongs to the native
   * player rather than to the engine. An effect left attached to a session
   * that has been replaced is silently doing nothing, which is the one way
   * this could fail that nobody would notice, so the target is handed over
   * again every time it could have moved.
   *
   * Typed as `unknown` deliberately: this interface describes what a player
   * does, and should not know what kind of native object implements it.
   */
  onSessionChange(listener: (nativePlayer: unknown) => void): () => void;
  /**
   * Told when the lock screen's own next/previous chapter button is pressed.
   *
   * The engine does not act on it: it does not know where chapters are, and
   * the whole-book position it would need is the store's. So it reports the
   * press and the store seeks, which is the same shape as everything else
   * here — the engine owns the lock screen, the store owns the book.
   *
   * Returns an unsubscribe function. A platform with no such buttons returns
   * one that does nothing, and nothing has to care which it got.
   */
  onRemoteChapterSkip(listener: (direction: 1 | -1) => void): () => void;
};

/** Playback speeds the UI offers. The API tops out at 2×. */
export const SPEEDS = [1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const MAX_RATE = 2;

/** Which part contains a whole-book position, and the offset within it. */
export function locatePart(parts: EnginePart[], positionSec: number) {
  if (parts.length === 0) return { index: 0, offsetSec: 0 };
  let index = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].startSec <= positionSec) index = i;
    else break;
  }
  const part = parts[index];
  const offsetSec = Math.max(0, positionSec - part.startSec);
  // Guard against a position past the end of a part whose duration was wrong.
  return { index, offsetSec: Math.min(offsetSec, Math.max(0, part.durationSec)) };
}
