/**
 * The Sound panel's arithmetic: what a preset means, and what three sliders
 * come to on a particular device's equalizer.
 *
 * Kept apart from both the native effects and the store because this is the
 * part with answers that can be checked. Every device reports a different
 * number of bands at different frequencies with a different usable range, so
 * "warmth" cannot be a band index — it has to be worked out from whatever the
 * hardware says it has.
 */

/** Settings as the user sets them, independent of any device. */
export type SoundSettings = {
  preset: PresetName;
  /** 0–100. Loudness only ever adds; there is nothing to cut. */
  boost: number;
  /** -100–100. Presence, around speech. */
  clarity: number;
  /** -100–100. Body, low down. */
  warmth: number;
};

export type PresetName = 'off' | 'clear-voice' | 'quiet-recording' | 'custom';

export const PRESETS: { name: PresetName; label: string; hint: string }[] = [
  { name: 'off', label: 'Off', hint: 'The recording as it was made' },
  { name: 'clear-voice', label: 'Clear voice', hint: 'Lifts speech out of the mix' },
  { name: 'quiet-recording', label: 'Quiet recording', hint: 'For a thin or distant reading' },
];

/**
 * What each preset is.
 *
 * `off` is all zeros and means every effect is disabled rather than set to
 * neutral — a disabled equalizer is a guarantee of no colouring, where a
 * flat one is only a promise.
 */
const PRESET_VALUES: Record<Exclude<PresetName, 'custom'>, Omit<SoundSettings, 'preset'>> = {
  off: { boost: 0, clarity: 0, warmth: 0 },
  // Speech sits around 1–4 kHz; lifting it and easing off the low end is what
  // makes a muddy narrator intelligible without making them shrill.
  'clear-voice': { boost: 20, clarity: 55, warmth: -25 },
  // A thin, distant recording needs level first, then presence.
  'quiet-recording': { boost: 70, clarity: 35, warmth: -10 },
};

export function settingsForPreset(preset: PresetName): SoundSettings {
  if (preset === 'custom') return { preset, ...PRESET_VALUES.off };
  return { preset, ...PRESET_VALUES[preset] };
}

export const DEFAULT_SETTINGS: SoundSettings = settingsForPreset('off');

/** Whether anything is being changed at all. */
export function isNeutral(settings: SoundSettings): boolean {
  return settings.boost === 0 && settings.clarity === 0 && settings.warmth === 0;
}

/**
 * Moving any slider means the preset no longer describes what you are
 * hearing, so it stops claiming to.
 */
export function withSlider(
  settings: SoundSettings,
  which: 'boost' | 'clarity' | 'warmth',
  value: number,
): SoundSettings {
  const next = { ...settings, [which]: clamp(value, which === 'boost' ? 0 : -100, 100) };
  return { ...next, preset: 'custom' };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/** What the device says its equalizer can do. Millibels throughout. */
export type EqualizerCapabilities = {
  bandCount: number;
  minMillibels: number;
  maxMillibels: number;
  /** One per band, in hertz, in band order. */
  centerFrequenciesHz: number[];
};

/** The most a slider at 100 will ask for, before the device's own limits. */
export const MAX_EQ_MILLIBELS = 900;
export const MAX_BOOST_MILLIBELS = 1200;

/** Warmth owns everything below this; clarity owns the speech range. */
const WARMTH_TOP_HZ = 300;
const CLARITY_LOW_HZ = 1200;
const CLARITY_TOP_HZ = 6000;

/**
 * How strongly a band belongs to warmth and to clarity, 0–1.
 *
 * Worked out from the band's own centre frequency rather than its index,
 * because a five-band equalizer and a ten-band one put their bands in
 * completely different places. A band between the two ranges belongs to
 * neither, which is what keeps the middle of the voice untouched.
 */
export function bandWeights(centreHz: number): { warmth: number; clarity: number } {
  const warmth =
    centreHz <= WARMTH_TOP_HZ ? 1 : centreHz <= WARMTH_TOP_HZ * 2 ? 0.4 : 0;
  const clarity =
    centreHz >= CLARITY_LOW_HZ && centreHz <= CLARITY_TOP_HZ
      ? 1
      : centreHz > CLARITY_TOP_HZ
        ? 0.35
        : centreHz >= CLARITY_LOW_HZ / 2
          ? 0.4
          : 0;
  return { warmth, clarity };
}

/**
 * The level for every band, in millibels, clamped to what the device accepts.
 *
 * Returns one number per band the device reported — never a fixed number, and
 * never an index the hardware might not have.
 */
export function bandLevelsFor(
  settings: SoundSettings,
  caps: EqualizerCapabilities,
): number[] {
  const levels: number[] = [];
  for (let i = 0; i < caps.bandCount; i += 1) {
    const centre = caps.centerFrequenciesHz[i] ?? 0;
    const { warmth, clarity } = bandWeights(centre);
    const wanted =
      (settings.warmth / 100) * warmth * MAX_EQ_MILLIBELS +
      (settings.clarity / 100) * clarity * MAX_EQ_MILLIBELS;
    levels.push(clamp(wanted, caps.minMillibels, caps.maxMillibels));
  }
  return levels;
}

/** The loudness gain to ask for, in millibels, never negative. */
export function boostMillibelsFor(settings: SoundSettings, maxMillibels: number): number {
  const wanted = (settings.boost / 100) * MAX_BOOST_MILLIBELS;
  return clamp(wanted, 0, Math.max(0, maxMillibels));
}

/**
 * Which settings apply to a book.
 *
 * A book's own settings if it has any, the all-books default otherwise. Kept
 * as a function of two rows so that "use the default" is simply the absence
 * of a row — there is no third state meaning "explicitly inheriting", and so
 * nothing to get out of step when the default changes.
 */
export function resolveSettings(
  forBook: SoundSettings | null,
  allBooks: SoundSettings | null,
): SoundSettings {
  return forBook ?? allBooks ?? DEFAULT_SETTINGS;
}
