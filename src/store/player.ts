/**
 * Playback state.
 *
 * All audio goes through the `AudioEngine` interface, which hides the fact
 * that a book may be one file or a hundred and twenty-seven. Everything here
 * is expressed in whole-book seconds: chapters, progress and the scrubber all
 * share one timeline, and the engine works out which file that lands in.
 */

import { create } from 'zustand';
import { chapterAt, type Book } from '@/data/types';
import { createExpoAudioEngine } from '@/lib/audio/expoAudioEngine';
import { SPEEDS, type AudioEngine, type EngineTrack } from '@/lib/audio/engine';
import { loadParts } from '@/db/books';
import { localUriFor } from '@/lib/files/copy';
import { useLibrary } from './library';

export { SPEEDS };

/** The lamp: off means it stays on, the rest put the app to sleep. */
export const SLEEP_OPTIONS = [
  { label: 'lamp on', kind: 'off' },
  { label: 'off in 15m', kind: 'timer', minutes: 15 },
  { label: 'off in 30m', kind: 'timer', minutes: 30 },
  { label: 'end of ch.', kind: 'chapter' },
] as const;

type PlayerState = {
  bookId: string | null;
  positionSec: number;
  playing: boolean;
  buffering: boolean;
  /** Set when the engine could not open the audio. */
  error: string | null;
  speedIndex: number;
  sleepIndex: number;
  sleepRemainingSec: number | null;

  open: (bookId: string) => Promise<void>;
  close: () => Promise<void>;
  togglePlay: () => void;
  seekTo: (positionSec: number) => void;
  nudge: (deltaSec: number) => void;
  skipChapter: (direction: 1 | -1) => void;
  cycleSpeed: () => void;
  cycleSleep: () => void;
  /** Ticks the sleep timer once a second while playing. */
  tickSleep: () => void;
  /** Flushes the position, e.g. when the app goes to the background. */
  savePosition: () => void;
};

const engine: AudioEngine = createExpoAudioEngine();

let unsubscribe: (() => void) | null = null;
let lastPersistedAt = 0;
let lastSubtitle = '';

/** How far through a chapter counts as "into it" for a previous-chapter tap. */
const CHAPTER_RESTART_THRESHOLD_SEC = 3;

/**
 * Coming back after a while, you have usually lost the thread of the sentence
 * you stopped on. Step back a little — further the longer you were away.
 */
const RESUME_REWIND_STEPS = [
  { afterPausedSec: 60 * 60, rewindSec: 15 },
  { afterPausedSec: 5 * 60, rewindSec: 5 },
] as const;

/** When playback was last paused, for the resume rewind. */
let pausedAt: number | null = null;

export const usePlayer = create<PlayerState>((set, get) => {
  const book = (): Book | undefined => {
    const id = get().bookId;
    return id ? useLibrary.getState().books.find((b) => b.id === id) : undefined;
  };

  /** Writes the position into the library, throttled to once every 5 seconds. */
  const persist = (positionSec: number, force = false) => {
    const id = get().bookId;
    if (!id) return;
    const now = Date.now();
    if (!force && now - lastPersistedAt < 5000) return;
    lastPersistedAt = now;
    useLibrary.getState().recordProgress(id, positionSec);
  };

  /**
   * Keeps the lock screen showing where the listener actually is.
   *
   * Real chapter marks give a chapter title. A multi-part book without them
   * has one stand-in chapter per file, whose "title" is a file name — useless
   * on a lock screen — so it says "Part 3 of 127" instead.
   */
  const syncNowPlaying = (positionSec: number) => {
    const b = book();
    if (!b) return;
    let subtitle = '';
    if (b.chapters.length > 0 && !b.chaptersFromParts) {
      subtitle = chapterAt(b, positionSec).chapter.title;
    } else if (b.files.length > 1) {
      const { index } = chapterAt(b, positionSec);
      subtitle = `Part ${index + 1} of ${b.files.length}`;
    } else {
      subtitle = b.title;
    }
    if (subtitle !== lastSubtitle) {
      lastSubtitle = subtitle;
      void engine.setNowPlaying(subtitle);
    }
  };

  return {
    bookId: null,
    positionSec: 0,
    playing: false,
    buffering: false,
    error: null,
    speedIndex: 0,
    sleepIndex: 0,
    sleepRemainingSec: null,

    open: async (bookId) => {
      if (get().bookId === bookId) return;
      await get().close();

      const b = useLibrary.getState().books.find((x) => x.id === bookId);
      if (!b) return;

      set({ bookId, positionSec: b.progressSec, playing: false, buffering: true, error: null });

      try {
        const rows = await loadParts(bookId);
        if (rows.length === 0) {
          set({ buffering: false, error: 'No audio files are recorded for this book.' });
          return;
        }

        // Local files only. Streaming off the drive technically works but is
        // miserable — a long book spends minutes seeking before it makes a
        // sound — so a book that is not on the phone is not playable, and the
        // Book screen offers to check it out instead.
        const localUris = rows.map((p) => (p.local_uri ? localUriFor(p.local_uri) : null));
        if (localUris.some((u) => !u)) {
          set({
            buffering: false,
            error: 'This book is not on your phone yet. Check it out first.',
          });
          return;
        }

        const track: EngineTrack = {
          bookId,
          title: b.title,
          author: b.author || undefined,
          artworkUri: b.coverThumbPath,
          durationSec: b.durationSec,
          parts: rows.map((p, i) => ({
            uri: localUris[i]!,
            startSec: p.start_sec,
            durationSec: p.duration_sec,
          })),
        };

        console.log(
          `[dueback] play "${b.title}" — ${rows.length} part(s), LOCAL, ` +
            `${Math.round(b.durationSec / 3600)}h, ` +
            `chapters ${b.chapters.length}${b.chaptersFromParts ? ' (per-part)' : ''}, ` +
            `first: ${track.parts[0]?.uri?.slice(0, 80)}`,
        );

        unsubscribe = engine.subscribe((status) => {
          set({
            positionSec: status.positionSec,
            playing: status.playing,
            buffering: status.buffering,
          });
          syncNowPlaying(status.positionSec);
          persist(status.positionSec);
          if (status.finished) {
            persist(status.positionSec, true);
          }
        });

        // Before `load`, not after: the engine claims the lock screen during
        // load, and it can only do that with the right chapter if it already
        // knows it.
        lastSubtitle = '';
        syncNowPlaying(b.progressSec);

        await engine.load(track, b.progressSec);
        await engine.setRate(SPEEDS[get().speedIndex]);
        set({ buffering: false });
      } catch (err) {
        set({
          buffering: false,
          error: (err as Error)?.message ?? 'That book would not open.',
        });
      }
    },

    close: async () => {
      if (get().bookId) persist(get().positionSec, true);
      unsubscribe?.();
      unsubscribe = null;
      lastSubtitle = '';
      await engine.unload();
      set({
        bookId: null,
        playing: false,
        buffering: false,
        error: null,
        sleepIndex: 0,
        sleepRemainingSec: null,
      });
    },

    togglePlay: () => {
      const next = !get().playing;
      // Optimistic, so the button responds before the engine reports back.
      set({ playing: next });
      if (!next) {
        pausedAt = Date.now();
        void engine.pause();
        persist(get().positionSec, true);
        return;
      }

      // Step back a little if this has been paused a while.
      const awaySec = pausedAt ? (Date.now() - pausedAt) / 1000 : 0;
      pausedAt = null;
      const step = RESUME_REWIND_STEPS.find((s) => awaySec >= s.afterPausedSec);
      if (step) {
        const to = Math.max(0, get().positionSec - step.rewindSec);
        set({ positionSec: to });
        void engine.seekTo(to).then(() => engine.play());
        return;
      }
      void engine.play();
    },

    seekTo: (positionSec) => {
      const b = book();
      const clamped = Math.max(0, Math.min(b?.durationSec ?? positionSec, positionSec));
      set({ positionSec: clamped });
      void engine.seekTo(clamped);
      persist(clamped, true);
    },

    nudge: (deltaSec) => get().seekTo(get().positionSec + deltaSec),

    /**
     * Chapter navigation on the whole-book timeline, so it crosses file
     * boundaries without the caller knowing. Going back restarts the current
     * chapter unless you are only a moment into it.
     */
    skipChapter: (direction) => {
      const b = book();
      if (!b || b.chapters.length === 0) return;
      const position = get().positionSec;
      const { index, chapter } = chapterAt(b, position);
      const target =
        direction === -1 && position - chapter.startSec > CHAPTER_RESTART_THRESHOLD_SEC
          ? index
          : index + direction;
      const bounded = Math.max(0, Math.min(b.chapters.length - 1, target));
      get().seekTo(b.chapters[bounded].startSec);
    },

    cycleSpeed: () => {
      const speedIndex = (get().speedIndex + 1) % SPEEDS.length;
      set({ speedIndex });
      void engine.setRate(SPEEDS[speedIndex]);
    },

    cycleSleep: () =>
      set((s) => {
        const sleepIndex = (s.sleepIndex + 1) % SLEEP_OPTIONS.length;
        const option = SLEEP_OPTIONS[sleepIndex];
        return {
          sleepIndex,
          sleepRemainingSec: option.kind === 'timer' ? option.minutes * 60 : null,
        };
      }),

    savePosition: () => {
      if (get().bookId) persist(get().positionSec, true);
    },

    tickSleep: () => {
      const state = get();
      if (!state.playing) return;
      const option = SLEEP_OPTIONS[state.sleepIndex];
      const b = book();
      if (!b) return;

      // End of chapter: stop at the boundary rather than rolling through.
      if (option.kind === 'chapter' && b.chapters.length > 0) {
        const { endSec } = chapterAt(b, state.positionSec);
        if (state.positionSec >= endSec - 1 && endSec < b.durationSec) {
          void engine.pause();
          set({ playing: false, sleepIndex: 0, sleepRemainingSec: null });
          persist(state.positionSec, true);
        }
        return;
      }

      if (option.kind === 'timer' && state.sleepRemainingSec !== null) {
        const remaining = state.sleepRemainingSec - 1;
        if (remaining <= 0) {
          void engine.pause();
          set({ playing: false, sleepIndex: 0, sleepRemainingSec: null });
          persist(state.positionSec, true);
          return;
        }
        set({ sleepRemainingSec: remaining });
      }
    },
  };
});

/** Real seconds needed to finish the book at the current speed. */
export function realSecondsLeft(durationSec: number, positionSec: number, speed: number) {
  return Math.max(0, (durationSec - positionSec) / speed);
}
