/**
 * The expo-audio implementation of `AudioEngine`.
 *
 * One `AudioPlayer` for the whole book, never an `AudioPlaylist`:
 * `setActiveForLockScreen` exists only on `AudioPlayer`, and without
 * lock-screen controls Android stops background audio after about three
 * minutes — which would kill playback in someone's pocket mid-chapter.
 *
 * Parts are switched with `replace()` + `seekTo()`, and the next part is
 * `preload()`ed as the current one nears its end so the seam is as short as
 * the platform allows.
 */

import {
  createAudioPlayer,
  clearAllPreloadedSources,
  preload,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import { DuebackAudio, type ChapterSkipEvent } from '../../../modules/dueback-audio';
import {
  locatePart,
  sourceFor,
  MAX_RATE,
  type AudioEngine,
  type EngineStatus,
  type EngineTrack,
} from './engine';

/** How close to the end of a part before the next one is preloaded. */
const PRELOAD_LEAD_SEC = 20;
/** Buffer the preloaded part should hold ready, in seconds. */
const PRELOAD_BUFFER_SEC = 15;
/** Treat a part as finished within this much of its end. */
const END_EPSILON_SEC = 0.35;

/**
 * How long after switching parts a "finished" report is disbelieved.
 *
 * `replace()` reuses the same ExoPlayer, so a status carrying the previous
 * item's `didJustFinish` can arrive after the switch has already happened.
 * Taken at face value it ends a part that has just started, which skips the
 * one after it. A new part is seconds from its end for nobody, so nothing
 * true is lost by not believing it for a moment.
 */
const SETTLE_MS = 600;

/**
 * Keeps voices sounding like voices at speed. iOS honours the quality hint;
 * Android's ExoPlayer pitch-corrects regardless, so passing it is harmless
 * there and necessary here.
 */
const PITCH_QUALITY = 'high' as const;

/**
 * How long the ramp back to full volume takes after a seek.
 *
 * Long enough to cover the artefact, short enough that nobody experiences it
 * as a fade. A quarter of a second is about where a rewind stops sounding
 * like a jump and starts sounding like a cut.
 */
const SEEK_FADE_MS = 220;
/** Steps in that ramp: smooth enough to the ear, cheap enough to schedule. */
const SEEK_FADE_STEPS = 6;
/** Where the ramp ends. The app has no volume control; the system has one. */
const FULL_VOLUME = 1;

export function createExpoAudioEngine(): AudioEngine {
  let player: AudioPlayer | null = null;
  let track: EngineTrack | null = null;
  let partIndex = 0;
  let rate = 1;
  let subtitle = '';
  let finished = false;
  /** Set while `replace()` is in flight, so status updates are not trusted. */
  let switching = false;
  /**
   * Whether the listener wants audio, as opposed to whether audio is coming
   * out right now. At a part boundary `status.playing` is already false —
   * playback has ended — so it cannot answer "should the next part start?".
   */
  let wantsToPlay = false;
  let preloadedFor = -1;
  /** When the current part was switched to, for the settle window above. */
  let switchedAt = 0;
  let statusSub: { remove: () => void } | null = null;
  const listeners = new Set<(status: EngineStatus) => void>();

  const parts = () => track?.parts ?? [];

  const emit = (status: EngineStatus) => {
    listeners.forEach((l) => l(status));
  };

  /**
   * What the lock screen is given. The field names are misleading: Android
   * renders `title` as the first line and `artist` as the second, while
   * `albumTitle` goes to a sub-text the lock screen does not show at all.
   *
   * So the chapter takes `artist` and the author keeps the hidden field —
   * while listening, where you are matters more than who wrote it.
   */
  const metadataFor = () => ({
    title: track?.title,
    artist: subtitle || track?.author,
    albumTitle: track?.author,
    artworkUrl: track?.artworkUri,
  });

  /**
   * Claims the lock screen for this book. Called once per book and no more:
   * `setActiveForLockScreen` releases the MediaSession and builds a new one, so
   * calling it on every chapter tore the notification down and put it back — the
   * half-second flicker at each chapter end.
   */
  const claimLockScreen = () => {
    if (!player || !track) return;
    player.setActiveForLockScreen(true, metadataFor(), {
      showSeekForward: true,
      showSeekBackward: true,
      /*
       * Not in expo-audio's own types: the field is added to the Kotlin
       * record by `plugins/withLockScreenChapters.js`, which is also what
       * draws the buttons. Cast rather than patched into the `.d.ts`, because
       * a type assertion here is visible and a rewritten type declaration in
       * node_modules is not.
       *
       * Decided once per book, here, which is the only place it can be:
       * `setActiveForLockScreen` builds the MediaSession, and the layout is
       * fixed when it does. A book with no chapter marks gets no buttons,
       * because a lock-screen button that does nothing is the exact fault
       * `withLockScreenSeek` was written to repair.
       */
      showChapterButtons: track.hasChapters,
    } as Parameters<AudioPlayer['setActiveForLockScreen']>[2]);
  };

  /** Refreshes the text in place, leaving the session and its buttons alone. */
  const refreshLockScreen = () => {
    if (!player || !track) return;
    try {
      player.updateLockScreenMetadata(metadataFor());
    } catch {
      // The service may not be bound yet; the next change will carry it.
    }
  };

  /**
   * Which fade is current. Incremented per seek so a ramp left over from the
   * previous one stops writing volume the moment another seek starts.
   */
  let fadeToken = 0;
  /** When the current ramp should have finished, for the check in `onStatus`. */
  let fadeEndsAt = 0;

  /** Ramps the volume back up, unless a newer seek has taken over. */
  const rampUp = (token: number, faded: AudioPlayer) => {
    const per = SEEK_FADE_MS / SEEK_FADE_STEPS;
    for (let step = 1; step <= SEEK_FADE_STEPS; step += 1) {
      setTimeout(() => {
        // Not this fade any more, or not even this player: leave it alone.
        if (fadeToken !== token || player !== faded) return;
        try {
          faded.volume = (step / SEEK_FADE_STEPS) * FULL_VOLUME;
        } catch {
          // A released player has no volume to set, and nothing to fix.
        }
      }, per * step);
    }
  };

  /**
   * Covers a seek with silence, then ramps back.
   *
   * ExoPlayer flushes its audio pipeline on a seek. Above 1× that pipeline
   * includes Sonic, the time-stretcher that keeps a voice at its own pitch
   * while the speed changes, and it has to re-prime: the first fraction of a
   * second after a rewind comes out warped. An MP3 with no seek table can
   * also land mid-frame and give a scrap of noise instead.
   *
   * Two causes, one shape — a short burst of wrong audio at a known instant.
   * So rather than chase either, this covers the instant: silence going in, a
   * short ramp coming out, and the warped part plays under a volume too low to
   * hear. A seek that fails still ramps back, because the alternative is a
   * book that has gone quiet for good.
   */
  const throughFade = async (seek: () => Promise<void>) => {
    const faded = player;
    if (!faded) {
      await seek();
      return;
    }
    const token = ++fadeToken;
    fadeEndsAt = Date.now() + SEEK_FADE_MS * 2;
    try {
      faded.volume = 0;
    } catch {
      // No volume control means no artefact to hide; the seek still happens.
    }
    try {
      await seek();
    } finally {
      rampUp(token, faded);
    }
  };

  /** Told when the session behind the player may have moved. */
  const sessionListeners = new Set<(nativePlayer: unknown) => void>();
  const announceSession = () => {
    for (const listener of sessionListeners) {
      try {
        listener(player);
      } catch {
        // An effect that cannot attach is never a reason to stop playing.
      }
    }
  };

  /** Moves playback to `index`, resuming if it was already playing. */
  const switchToPart = async (index: number, offsetSec: number, resume: boolean) => {
    const list = parts();
    if (!player || index < 0 || index >= list.length) return;
    switching = true;
    partIndex = index;
    preloadedFor = -1;
    try {
      player.replace(sourceFor(list[index]));
      // `replace` swaps the media source on the same underlying ExoPlayer, so
      // the MediaSession survives it — but the rate is reset and the injected
      // metadata needs pushing again.
      player.setPlaybackRate(Math.min(rate, MAX_RATE), PITCH_QUALITY);
      /*
       * Only seek when there is somewhere to seek to.
       *
       * This used to seek unconditionally, and at a part boundary the offset
       * is always 0 — so it asked the player to go to the start of a source
       * that was still loading. The seek landed on the item still current,
       * which was the part that had just ended, and rewound it to zero: the
       * section played again instead of the next one, over and over, until
       * a manual skip broke the pattern by seeking somewhere non-zero.
       *
       * A replaced source begins at its start anyway, so for a boundary
       * there was never anything to gain by asking.
       */
      if (offsetSec > 0) await player.seekTo(offsetSec);
      refreshLockScreen();
      if (resume) player.play();
      /*
       * `replace` reuses the same ExoPlayer, so in practice the session
       * survives — but that is an implementation detail of expo-audio, not a
       * promise, and an effect on a stale session fails silently. Announcing
       * it costs one no-op call when nothing has changed.
       */
      announceSession();
    } finally {
      switchedAt = Date.now();
      switching = false;
    }
  };

  const onStatus = (status: AudioStatus) => {
    const list = parts();
    if (!track || list.length === 0 || switching) return;

    /*
     * The fade's safety net.
     *
     * A ramp is a handful of timers, and timers are not a guarantee — the app
     * going to the background mid-seek could in principle leave one unfired
     * and the book silent, which is a far worse failure than the artefact the
     * fade exists to hide. Status arrives twice a second regardless, so once
     * the ramp is past its deadline anything still quiet is put right here.
     */
    if (player && fadeEndsAt > 0 && Date.now() > fadeEndsAt) {
      fadeEndsAt = 0;
      try {
        if (player.volume < FULL_VOLUME) player.volume = FULL_VOLUME;
      } catch {
        // Nothing to heal on a player that has gone.
      }
    }

    const part = list[partIndex];
    const positionSec = part.startSec + (status.currentTime ?? 0);
    const isLastPart = partIndex >= list.length - 1;

    // A part running out is the normal way to reach the next one.
    const partDuration = status.duration > 0 ? status.duration : part.durationSec;
    /*
     * Not believed for a moment after a switch.
     *
     * A status carrying the previous item's `didJustFinish` can arrive once
     * the switch has already happened, and ending a part that has just
     * begun skips the next one entirely.
     */
    const settled = Date.now() - switchedAt > SETTLE_MS;
    const atEnd =
      settled &&
      (status.didJustFinish ||
        (partDuration > 0 && status.currentTime >= partDuration - END_EPSILON_SEC));

    if (atEnd && !isLastPart) {
      void switchToPart(partIndex + 1, 0, wantsToPlay);
      return;
    }
    if (atEnd && isLastPart) {
      finished = true;
    }

    // Warm up the next part before we need it, so the gap is short.
    if (
      !isLastPart &&
      partDuration > 0 &&
      status.currentTime >= partDuration - PRELOAD_LEAD_SEC &&
      preloadedFor !== partIndex
    ) {
      preloadedFor = partIndex;
      // Module-level, not a player method: it warms a shared source cache that
      // the next `replace()` then draws on.
      void preload(
        sourceFor(list[partIndex + 1]),
        { preferredForwardBufferDuration: PRELOAD_BUFFER_SEC },
      ).catch(() => {
        // Preloading is an optimisation; a failure just means a longer seam.
      });
    }

    emit({
      positionSec,
      playing: status.playing,
      buffering: status.isBuffering || !status.isLoaded,
      finished,
      partIndex,
    });
  };

  return {
    async load(next, positionSec) {
      await this.unload();
      track = next;
      finished = false;
      // `subtitle` is deliberately not reset here. `unload` clears it, and the
      // store sets it before calling `load` so the lock screen is claimed with
      // the right chapter already in hand — a metadata update sent before the
      // playback service finishes binding is dropped on the floor.

      // `doNotMix` is required alongside setActiveForLockScreen, and
      // background playback is what makes this an audiobook app at all.
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'doNotMix',
        shouldRouteThroughEarpiece: false,
      });

      const located = locatePart(next.parts, positionSec);
      partIndex = located.index;
      const first = next.parts[partIndex];
      if (!first) return;

      player = createAudioPlayer(sourceFor(first), { updateInterval: 500 });
      statusSub = player.addListener('playbackStatusUpdate', onStatus);
      player.setPlaybackRate(Math.min(rate, MAX_RATE), PITCH_QUALITY);
      await player.seekTo(located.offsetSec);
      claimLockScreen();
      // A new player means a new session, so anything attached to the old one
      // is now attached to nothing.
      announceSession();
    },

    async play() {
      wantsToPlay = true;
      player?.play();
    },

    async pause() {
      wantsToPlay = false;
      player?.pause();
    },

    async seekTo(positionSec) {
      const list = parts();
      const here = player;
      if (!here || list.length === 0) return;
      const target = locatePart(list, Math.max(0, positionSec));
      finished = false;
      await throughFade(async () => {
        if (target.index !== partIndex) {
          // Mid-playback the two agree; at a boundary only the intent is right.
          await switchToPart(target.index, target.offsetSec, wantsToPlay || here.playing);
          return;
        }
        await here.seekTo(target.offsetSec);
      });
    },

    async setRate(next) {
      rate = Math.min(next, MAX_RATE);
      player?.setPlaybackRate(rate, PITCH_QUALITY);
    },

    async setNowPlaying(nextSubtitle) {
      if (subtitle === nextSubtitle) return;
      subtitle = nextSubtitle;
      refreshLockScreen();
    },

    async unload() {
      statusSub?.remove();
      statusSub = null;
      if (player) {
        try {
          player.setActiveForLockScreen(false);
          player.pause();
          player.remove();
        } catch {
          // Already released.
        }
      }
      // The preload cache is per-book; leaving it full would pin files from a
      // drive that may be unplugged next.
      await clearAllPreloadedSources().catch(() => {});
      player = null;
      // Nothing to attach effects to now.
      announceSession();
      track = null;
      subtitle = '';
      partIndex = 0;
      // A new book must never inherit the last one's intent to play.
      wantsToPlay = false;
      preloadedFor = -1;
      finished = false;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /*
     * The lock screen's chapter buttons, straight through to the caller.
     *
     * The engine deliberately does nothing with this. It holds one file at a
     * time and has no chapter list; the store has both the chapters and the
     * whole-book position, so it is the only thing that can answer a press.
     */
    onRemoteChapterSkip(listener) {
      // Absent on a build made before the native module existed, and on any
      // future iOS build. The buttons are not there either, so there is
      // nothing to subscribe to and nothing to report.
      if (!DuebackAudio) return () => {};
      const subscription = DuebackAudio.addListener(
        'onChapterSkip',
        ({ direction }: ChapterSkipEvent) => {
          listener(direction);
        },
      );
      return () => subscription.remove();
    },

    onSessionChange(listener) {
      sessionListeners.add(listener);
      // Told at once if there is already a player, so a listener that arrives
      // after playback started is not left waiting for the next part.
      if (player) {
        try {
          listener(player);
        } catch {
          // Never the engine's problem.
        }
      }
      return () => sessionListeners.delete(listener);
    },
  };
}
