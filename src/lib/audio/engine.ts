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
  /** Playable location — a local copy when there is one, else the drive. */
  uri: string;
  /** Where this part begins on the whole-book timeline. */
  startSec: number;
  durationSec: number;
};

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
