/**
 * The Sound panel's native effects, and the headphone-unplug handler.
 *
 * Android only. Everything is optional: a device that will not give us an
 * equalizer, or a build without this module in it, must leave playback
 * working exactly as it was. `src/lib/audio/soundFx.ts` is the only thing
 * that should import this, and it is what turns an absent module into
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

type DuebackAudioModule = {
  attach: (player: AudioPlayer) => Promise<SoundCapabilities>;
  capabilities: () => Promise<SoundCapabilities>;
  detach: () => Promise<void>;
  apply: (bandLevels: number[], boostMillibels: number) => Promise<SoundCapabilities>;
  addListener: (event: 'onBecomingNoisy' | 'onSessionChanged', listener: () => void) => EventSubscription;
};

/**
 * Optional on purpose. A development build made before this module existed,
 * or any future iOS build, simply does not have it — and the panel should
 * say so rather than the app failing to start.
 */
export const DuebackAudio = requireOptionalNativeModule<DuebackAudioModule>('DuebackAudio');
