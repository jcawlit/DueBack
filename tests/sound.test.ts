/**
 * The Sound panel's arithmetic.
 *
 * The part worth testing is the part that has to cope with hardware nobody
 * can predict: every device reports a different number of equalizer bands, at
 * different frequencies, with a different usable range, and "warmth" has to
 * mean the same thing on all of them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  MAX_BOOST_MILLIBELS,
  bandLevelsFor,
  bandWeights,
  boostMillibelsFor,
  isNeutral,
  resolveSettings,
  settingsForPreset,
  withSlider,
  type EqualizerCapabilities,
  type SoundSettings,
} from '../src/lib/audio/sound.ts';

/** Five bands, the commonest Android layout. */
const FIVE_BAND: EqualizerCapabilities = {
  bandCount: 5,
  minMillibels: -1500,
  maxMillibels: 1500,
  centerFrequenciesHz: [60, 230, 910, 3600, 14000],
};

/** Ten bands, as some devices and most third-party stacks report. */
const TEN_BAND: EqualizerCapabilities = {
  bandCount: 10,
  minMillibels: -1200,
  maxMillibels: 1200,
  centerFrequenciesHz: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
};

/** Three bands with a mean range, which some cheap hardware really does. */
const THREE_BAND: EqualizerCapabilities = {
  bandCount: 3,
  minMillibels: -300,
  maxMillibels: 300,
  centerFrequenciesHz: [100, 1000, 8000],
};

describe('presets', () => {
  it('off changes nothing', () => {
    const off = settingsForPreset('off');
    assert.deepEqual(off, { preset: 'off', boost: 0, clarity: 0, warmth: 0 });
    assert.equal(isNeutral(off), true);
  });

  it('clear voice lifts speech and eases the low end', () => {
    const voice = settingsForPreset('clear-voice');
    assert.equal(voice.preset, 'clear-voice');
    assert.ok(voice.clarity > 0, 'clarity should be lifted');
    assert.ok(voice.warmth < 0, 'warmth should be eased off');
    assert.equal(isNeutral(voice), false);
  });

  it('quiet recording reaches for level first', () => {
    const quiet = settingsForPreset('quiet-recording');
    const voice = settingsForPreset('clear-voice');
    assert.ok(quiet.boost > voice.boost, 'a quiet recording needs more level');
  });

  it('the default is off', () => {
    assert.equal(DEFAULT_SETTINGS.preset, 'off');
  });
});

describe('moving a slider', () => {
  it('switches the preset to custom', () => {
    const next = withSlider(settingsForPreset('clear-voice'), 'warmth', 80);
    assert.equal(next.preset, 'custom');
    assert.equal(next.warmth, 80);
  });

  it('leaves the other sliders alone', () => {
    const voice = settingsForPreset('clear-voice');
    const next = withSlider(voice, 'boost', 50);
    assert.equal(next.clarity, voice.clarity);
    assert.equal(next.warmth, voice.warmth);
  });

  it('stays custom even when sliders match Off', () => {
    let s: SoundSettings = settingsForPreset('clear-voice');
    s = withSlider(s, 'boost', 0);
    s = withSlider(s, 'clarity', 0);
    s = withSlider(s, 'warmth', 0);
    assert.equal(s.preset, 'custom');
  });

  it('stays custom when sliders happen to match a named preset', () => {
    const voice = settingsForPreset('clear-voice');
    let s = withSlider(settingsForPreset('off'), 'boost', voice.boost);
    s = withSlider(s, 'clarity', voice.clarity);
    s = withSlider(s, 'warmth', voice.warmth);
    assert.equal(s.preset, 'custom');
  });

  it('will not let boost go below nothing — loudness only adds', () => {
    assert.equal(withSlider(DEFAULT_SETTINGS, 'boost', -50).boost, 0);
  });

  it('clamps at the ends', () => {
    assert.equal(withSlider(DEFAULT_SETTINGS, 'clarity', 500).clarity, 100);
    assert.equal(withSlider(DEFAULT_SETTINGS, 'warmth', -500).warmth, -100);
    assert.equal(withSlider(DEFAULT_SETTINGS, 'boost', 500).boost, 100);
  });
});

describe('which bands a slider owns', () => {
  it('gives the bottom end to warmth and nothing else', () => {
    const low = bandWeights(60);
    assert.equal(low.warmth, 1);
    assert.equal(low.clarity, 0);
  });

  it('gives the speech range to clarity and nothing else', () => {
    const speech = bandWeights(3600);
    assert.equal(speech.clarity, 1);
    assert.equal(speech.warmth, 0);
  });

  it('leaves the middle of the voice to neither', () => {
    const middle = bandWeights(800);
    assert.equal(middle.warmth, 0);
    assert.ok(middle.clarity < 1, 'the lower midrange should not be fully clarity');
  });
});

describe('turning sliders into band levels', () => {
  it('returns exactly as many levels as the device has bands', () => {
    for (const caps of [THREE_BAND, FIVE_BAND, TEN_BAND]) {
      const levels = bandLevelsFor(settingsForPreset('clear-voice'), caps);
      assert.equal(levels.length, caps.bandCount, `${caps.bandCount} bands`);
    }
  });

  it('is flat when nothing is asked for', () => {
    const levels = bandLevelsFor(settingsForPreset('off'), TEN_BAND);
    assert.deepEqual(levels, new Array(10).fill(0));
  });

  it('lifts the speech bands and cuts the low ones for clear voice', () => {
    const levels = bandLevelsFor(settingsForPreset('clear-voice'), TEN_BAND);
    // 31 Hz and 62 Hz are warmth; 2 kHz and 4 kHz are clarity.
    assert.ok(levels[0] < 0, 'the bottom should be cut');
    assert.ok(levels[6] > 0, '2 kHz should be lifted');
    assert.ok(levels[7] > 0, '4 kHz should be lifted');
  });

  it('never asks for more than the device will give', () => {
    const shouty: SoundSettings = { preset: 'custom', boost: 100, clarity: 100, warmth: 100 };
    for (const caps of [THREE_BAND, FIVE_BAND, TEN_BAND]) {
      for (const level of bandLevelsFor(shouty, caps)) {
        assert.ok(level <= caps.maxMillibels, `${level} over ${caps.maxMillibels}`);
        assert.ok(level >= caps.minMillibels, `${level} under ${caps.minMillibels}`);
      }
    }
  });

  it('works on hardware with a tiny usable range', () => {
    const levels = bandLevelsFor(
      { preset: 'custom', boost: 0, clarity: 100, warmth: -100 },
      THREE_BAND,
    );
    assert.equal(levels.length, 3);
    assert.equal(levels[0], -300, 'the low band should hit the floor, not go past it');
    assert.equal(levels[2], 300, 'the high band should hit the ceiling');
  });

  it('copes with a device that reports fewer frequencies than bands', () => {
    const odd: EqualizerCapabilities = {
      bandCount: 4,
      minMillibels: -600,
      maxMillibels: 600,
      centerFrequenciesHz: [60, 1000],
    };
    const levels = bandLevelsFor(settingsForPreset('clear-voice'), odd);
    assert.equal(levels.length, 4);
    for (const level of levels) assert.ok(Number.isFinite(level), `${level} is not a number`);
  });

  it('copes with a device reporting no bands at all', () => {
    const none: EqualizerCapabilities = {
      bandCount: 0,
      minMillibels: 0,
      maxMillibels: 0,
      centerFrequenciesHz: [],
    };
    assert.deepEqual(bandLevelsFor(settingsForPreset('clear-voice'), none), []);
  });
});

describe('loudness', () => {
  it('asks for nothing when boost is nothing', () => {
    assert.equal(boostMillibelsFor(settingsForPreset('off'), 2000), 0);
  });

  it('scales with the slider', () => {
    const half = boostMillibelsFor({ ...DEFAULT_SETTINGS, boost: 50 }, 10000);
    assert.equal(half, MAX_BOOST_MILLIBELS / 2);
  });

  it('never exceeds what the device allows', () => {
    assert.equal(boostMillibelsFor({ ...DEFAULT_SETTINGS, boost: 100 }, 400), 400);
  });

  it('asks for nothing when the device allows nothing', () => {
    assert.equal(boostMillibelsFor({ ...DEFAULT_SETTINGS, boost: 100 }, 0), 0);
  });
});

describe('a book’s settings and the all-books default', () => {
  const mine = settingsForPreset('quiet-recording');
  const everyone = settingsForPreset('clear-voice');

  it('uses the book’s own when it has them', () => {
    assert.deepEqual(resolveSettings(mine, everyone), mine);
  });

  it('falls back to the all-books default', () => {
    assert.deepEqual(resolveSettings(null, everyone), everyone);
  });

  it('falls back to off when there is no default either', () => {
    assert.deepEqual(resolveSettings(null, null), DEFAULT_SETTINGS);
  });

  it('goes back to the default the moment a book’s own are cleared', () => {
    // "Use all-books default" is the absence of a row, not a third state —
    // so clearing is simply passing null, and a later change to the default
    // is picked up without anything having to be kept in step.
    assert.deepEqual(resolveSettings(null, everyone), everyone);
    const changed = settingsForPreset('quiet-recording');
    assert.deepEqual(resolveSettings(null, changed), changed);
  });
});
