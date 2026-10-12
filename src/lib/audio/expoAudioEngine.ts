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
import {
  locatePart,
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
 * Keeps voices sounding like voices at speed. iOS honours the quality hint;
 * Android's ExoPlayer pitch-corrects regardless, so passing it is harmless
 * there and necessary here.
 */
const PITCH_QUALITY = 'high' as const;

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
   * out right now.
   *
   * At a part boundary `status.playing` is already false — playback has
   * ended — so it cannot answer "should the next part start?". The code here
   * used to paper over that with `status.playing || true`, which is simply
   * `true`: a book paused a few seconds before the end of a part would start
   * itself again when the part ran out. This is the question that was
   * actually being asked.
   */
  let wantsToPlay = false;
  let preloadedFor = -1;
  let statusSub: { remove: () => void } | null = null;
  const listeners = new Set<(status: EngineStatus) => void>();

  const parts = () => track?.parts ?? [];

  const emit = (status: EngineStatus) => {
    listeners.forEach((l) => l(status));
  };

  /**
   * What the lock screen is given.
   *
   * The field names are misleading, so this is worth spelling out. Android's
   * media controls render `title` as the first line and `artist` as the
   * second; `albumTitle` goes to the notification's `setSubText`, which the
   * modern lock screen does not show at all. The chapter therefore has to go in
   * `artist` — putting it in `albumTitle`, as this used to, meant the chapter
   * was never visible on any book and the author sat in its place.
   *
   * While listening, where you are matters more than who wrote it, so the
   * chapter takes the visible line and the author keeps the hidden one.
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
    });
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

  /** Moves playback to `index`, resuming if it was already playing. */
  const switchToPart = async (index: number, offsetSec: number, resume: boolean) => {
    const list = parts();
    if (!player || index < 0 || index >= list.length) return;
    switching = true;
    partIndex = index;
    preloadedFor = -1;
    try {
      player.replace({ uri: list[index].uri });
      // `replace` swaps the media source on the same underlying ExoPlayer, so
      // the MediaSession survives it — but the rate is reset and the injected
      // metadata needs pushing again.
      player.setPlaybackRate(Math.min(rate, MAX_RATE), PITCH_QUALITY);
      await player.seekTo(Math.max(0, offsetSec));
      refreshLockScreen();
      if (resume) player.play();
    } finally {
      switching = false;
    }
  };

  const onStatus = (status: AudioStatus) => {
    const list = parts();
    if (!track || list.length === 0 || switching) return;

    const part = list[partIndex];
    const positionSec = part.startSec + (status.currentTime ?? 0);
    const isLastPart = partIndex >= list.length - 1;

    // A part running out is the normal way to reach the next one.
    const partDuration = status.duration > 0 ? status.duration : part.durationSec;
    const atEnd =
      status.didJustFinish ||
      (partDuration > 0 && status.currentTime >= partDuration - END_EPSILON_SEC);

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
        { uri: list[partIndex + 1].uri },
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

      player = createAudioPlayer({ uri: first.uri }, { updateInterval: 500 });
      statusSub = player.addListener('playbackStatusUpdate', onStatus);
      player.setPlaybackRate(Math.min(rate, MAX_RATE), PITCH_QUALITY);
      await player.seekTo(located.offsetSec);
      claimLockScreen();
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
      if (!player || list.length === 0) return;
      const target = locatePart(list, Math.max(0, positionSec));
      finished = false;
      if (target.index !== partIndex) {
        // Mid-playback the two agree; at a boundary only the intent is right.
        await switchToPart(target.index, target.offsetSec, wantsToPlay || player.playing);
        return;
      }
      await player.seekTo(target.offsetSec);
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
  };
}
