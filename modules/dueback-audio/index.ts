/**
 * The Sound panel's native effects, the headphone-unplug handler, and the
 * lock screen's chapter buttons.
 *
 * Android only. Everything is optional: a device that will not give us an
 * equalizer, or a build without this module in it, must leave playback
 * working exactly as it was. Two files import this and no others —
 * `src/lib/audio/soundFx.ts` for the effects and `src/lib/audio/`
 * `expoAudioEngine.ts` for the chapter buttons, which belong to the lock
 * screen and so to the engine that claims it. Both turn an absent module into
 * "not supported" rather than a crash.
 */

import { requireOptionalNativeModule } from 'expo';
import type { EventSubscription } from 'expo-modules-core';
import type { AudioPlayer } from 'expo-audio';

export type EqualizerInfo = {
  available: boolean;
  reason?: string | null;
  bandCount: number;
  minMillibels: number;
  maxMillibels: number;
  centerFrequenciesHz: number[];
};

export type LoudnessInfo = {
  available: boolean;
  reason?: string | null;
  maxMillibels: number;
};

export type SoundCapabilities = {
  attached: boolean;
  sessionId: number;
  equalizer: EqualizerInfo;
  loudness: LoudnessInfo;
};

/**
 * A press on the lock screen's next- or previous-chapter button.
 *
 * It arrives here rather than being handled natively because a chapter
 * boundary is on the whole-book timeline and may be in a different file from
 * the one playing — see `plugins/withLockScreenChapters.js`. The app owns the
 * timeline, so the app does the seeking.
 */
export type ChapterSkipEvent = { direction: 1 | -1 };

type DuebackAudioModule = {
  attach: (player: AudioPlayer) => Promise<SoundCapabilities>;
  capabilities: () => Promise<SoundCapabilities>;
  detach: () => Promise<void>;
  apply: (bandLevels: number[], boostMillibels: number) => Promise<SoundCapabilities>;
  /*
   * Two call signatures rather than one, because only the chapter event
   * carries a payload and a listener should not have to accept arguments it
   * is never given.
   */
  addListener: {
    (event: 'onBecomingNoisy' | 'onSessionChanged', listener: () => void): EventSubscription;
    (event: 'onChapterSkip', listener: (event: ChapterSkipEvent) => void): EventSubscription;
  };
};

/**
 * Optional on purpose. A development build made before this module existed,
 * or any future iOS build, simply does not have it — and the panel should
 * say so rather than the app failing to start.
 */
export const DuebackAudio = requireOptionalNativeModule<DuebackAudioModule>('DuebackAudio');
