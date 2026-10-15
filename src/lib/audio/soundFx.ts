/**
 * Between the Sound panel and the native effects.
 *
 * Everything the panel asks for comes through here, and nothing here is
 * allowed to throw. A device without an equalizer, a build made before the
 * native module existed, iOS, an effect that dies when the session changes —
 * all of them end as "not supported", a control that disappears, and audio
 * that carries on playing.
 */

import { Platform } from 'react-native';
import type { AudioPlayer } from 'expo-audio';
import { DuebackAudio, type SoundCapabilities } from '../../../modules/dueback-audio';
import {
  bandLevelsFor,
  boostMillibelsFor,
  type EqualizerCapabilities,
  type SoundSettings,
} from './sound';

/** What the app assumes when it cannot ask: nothing is available. */
export const NOTHING_AVAILABLE: SoundCapabilities = {
  attached: false,
  sessionId: 0,
  equalizer: {
    available: false,
    reason: 'Not supported on this device',
    bandCount: 0,
    minMillibels: 0,
    maxMillibels: 0,
    centerFrequenciesHz: [],
  },
  loudness: { available: false, reason: 'Not supported on this device', maxMillibels: 0 },
};

/** Whether this build can do any of it at all. */
export function soundEffectsPossible(): boolean {
  return Platform.OS === 'android' && !!DuebackAudio;
}

/**
 * Attaches to whatever session the player is using now.
 *
 * Called on every load and every part change: an effect attached to a session
 * that has been replaced is silently doing nothing, which is the one failure
 * nobody would notice.
 */
export async function attachEffects(player: AudioPlayer | null): Promise<SoundCapabilities> {
  if (!player || !DuebackAudio) return NOTHING_AVAILABLE;
  try {
    return await DuebackAudio.attach(player);
  } catch {
    return NOTHING_AVAILABLE;
  }
}

export async function detachEffects(): Promise<void> {
  try {
    await DuebackAudio?.detach();
  } catch {
    // Already gone with the session.
  }
}

export async function readCapabilities(): Promise<SoundCapabilities> {
  if (!DuebackAudio) return NOTHING_AVAILABLE;
  try {
    return await DuebackAudio.capabilities();
  } catch {
    return NOTHING_AVAILABLE;
  }
}

/** The equalizer side of the capabilities, in the shape the maths wants. */
export function equalizerCapsOf(caps: SoundCapabilities): EqualizerCapabilities {
  return {
    bandCount: caps.equalizer.available ? caps.equalizer.bandCount : 0,
    minMillibels: caps.equalizer.minMillibels,
    maxMillibels: caps.equalizer.maxMillibels,
    centerFrequenciesHz: caps.equalizer.centerFrequenciesHz,
  };
}

/**
 * Works the settings out against this device and hands them over.
 *
 * The levels are computed here rather than natively so that the awkward part
 * — what "warmth" means on hardware with three bands or ten — stays in one
 * testable place. Returns the capabilities as the native side now sees them,
 * which is how an effect that died is noticed.
 */
export async function applySettings(
  settings: SoundSettings,
  caps: SoundCapabilities,
): Promise<SoundCapabilities> {
  if (!DuebackAudio) return NOTHING_AVAILABLE;
  const levels = caps.equalizer.available
    ? bandLevelsFor(settings, equalizerCapsOf(caps))
    : [];
  const boost = caps.loudness.available
    ? boostMillibelsFor(settings, caps.loudness.maxMillibels)
    : 0;
  try {
    return await DuebackAudio.apply(levels, boost);
  } catch {
    return NOTHING_AVAILABLE;
  }
}

/**
 * Tells us when the headphones come out.
 *
 * Android broadcasts this as the audio is about to start coming out of the
 * phone's own speaker, which is the moment to stop rather than a moment
 * after. Returns a function that stops listening, or a no-op where there is
 * nothing to listen to.
 */
export function onBecomingNoisy(listener: () => void): () => void {
  if (!DuebackAudio) return () => {};
  try {
    const subscription = DuebackAudio.addListener('onBecomingNoisy', listener);
    return () => subscription.remove();
  } catch {
    return () => {};
  }
}

export function onAudioSessionChanged(listener: () => void): () => void {
  if (!DuebackAudio) return () => {};
  try {
    const subscription = DuebackAudio.addListener('onSessionChanged', listener);
    return () => subscription.remove();
  } catch { return () => {}; }
}
