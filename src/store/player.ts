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
import { SETTING_KEYS, getSetting, setSetting } from '@/db/schema';
import { localUriFor } from '@/lib/files/copy';
import { onBecomingNoisy } from '@/lib/audio/soundFx';
import { useSound } from './sound';
import { onBookAudioRemoved, useLibrary } from './library';

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
  /**
   * When the lamp goes out, as a wall-clock timestamp. A deadline needs
   * nothing to keep it, which a counter on a JS interval did —
   * `npm run kb sleep`.
   */
  sleepDeadlineAt: number | null;
  /** The same thing as a countdown, for the Player's label. Derived. */
  sleepRemainingSec: number | null;

  open: (bookId: string) => Promise<void>;
  /**
   * Opens a book and lands on a given second — what a note's time chip does.
   *
   * Separate from `open` because seeking has to wait for the engine to hold
   * the book: calling `seekTo` straight after `open` from a screen would race
   * the load it has just started.
   */
  openAt: (bookId: string, positionSec: number) => Promise<void>;
  /**
   * Throws away whatever the engine is holding and opens the current book
   * again, optionally starting playback. The way out of a load that failed.
   */
  reload: (andPlay?: boolean) => Promise<void>;
  /** Reopens the last book, paused at its saved position. */
  restoreLastBook: () => Promise<void>;
  close: () => Promise<void>;
  togglePlay: () => void;
  seekTo: (positionSec: number) => void;
  nudge: (deltaSec: number) => void;
  skipChapter: (direction: 1 | -1) => void;
  cycleSpeed: () => void;
  cycleSleep: () => void;
  /** Flushes the position, e.g. when the app goes to the background. */
  savePosition: () => void;
};

const engine: AudioEngine = createExpoAudioEngine();

/*
 * The Sound panel's effects follow the session, which moves on every part
 * change. Subscribed once, at module scope, rather than from a screen: the
 * effects belong to playback, and playback outlives whatever is on screen.
 */
engine.onSessionChange((nativePlayer) => {
  useSound.getState().useSession(nativePlayer);
});

/*
 * Pause when the headphones come out.
 *
 * Android broadcasts this as the sound is about to start coming out of the
 * phone's own speaker. expo-audio does not expose it, which is why it is a
 * native module of ours — and why until now unplugging earbuds carried on
 * playing the book out loud.
 */
onBecomingNoisy(() => {
  void engine.pause();
  usePlayer.setState({ playing: false });
});

let unsubscribe: (() => void) | null = null;
let lastPersistedAt = 0;
let lastSubtitle = '';

/**
 * The book the engine actually holds, set only once a load has succeeded.
 *
 * `bookId` alone cannot answer "is this ready to play?": it is set before any
 * of the work, so a failed load leaves the id in place with nothing behind it.
 */
let loadedFor: string | null = null;

/**
 * Which `open` call is the live one. The user can pick another book across any
 * of the awaits in `open`, and without this the slower call writes its book's
 * state over the newer one's.
 */
let openToken = 0;

/**
 * How long to wait for the engine before calling a load failed. Generous — a
 * first load binds the playback service — but never unbounded.
 */
const LOAD_TIMEOUT_MS = 20000;

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

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
    // Only a forced save replaces the book in the library's own list: a
    // position saved every five seconds while playing would otherwise rebuild
    // every shelf behind the Player. The database is written either way.
    useLibrary.getState().recordProgress(id, positionSec, { commit: force });
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

  /**
   * Puts the book down when the lamp is due to go out. Called from the
   * engine's status callback, which the native player drives every 500 ms
   * including in the background.
   *
   * The timer is wall-clock, so time spent paused counts. End of chapter is
   * measured against the position instead.
   */
  const checkSleep = (positionSec: number) => {
    const state = get();
    const option = SLEEP_OPTIONS[state.sleepIndex];

    if (option.kind === 'chapter') {
      if (!state.playing) return;
      const b = book();
      if (!b || b.chapters.length === 0) return;
      // Stop at the boundary rather than rolling through.
      const { endSec } = chapterAt(b, positionSec);
      if (positionSec >= endSec - 1 && endSec < b.durationSec) {
        void engine.pause();
        set({ playing: false, sleepIndex: 0, sleepRemainingSec: null, sleepDeadlineAt: null });
        persist(positionSec, true);
      }
      return;
    }

    if (option.kind !== 'timer' || state.sleepDeadlineAt === null) return;

    const remaining = Math.ceil((state.sleepDeadlineAt - Date.now()) / 1000);
    if (remaining <= 0) {
      void engine.pause();
      set({ playing: false, sleepIndex: 0, sleepRemainingSec: null, sleepDeadlineAt: null });
      persist(positionSec, true);
      return;
    }
    // Only when the displayed second actually changes: this runs twice a
    // second, and the label is the only reader.
    if (remaining !== state.sleepRemainingSec) set({ sleepRemainingSec: remaining });
  };

  return {
    bookId: null,
    positionSec: 0,
    playing: false,
    buffering: false,
    error: null,
    speedIndex: 0,
    sleepIndex: 0,
    sleepDeadlineAt: null,
    sleepRemainingSec: null,

    open: async (bookId) => {
      const b = useLibrary.getState().books.find((x) => x.id === bookId);
      if (!b) return;

      /*
       * A finished book opens at the beginning: its saved position is the last
       * second of the last part, so "Listen again" would otherwise load the
       * end and sit there. The library card keeps the date it was finished.
       */
      const atEnd = b.durationSec > 0 && b.progressSec >= b.durationSec - 1;
      const rewind = !!b.finishedAt && atEnd;
      const startAt = rewind ? 0 : b.progressSec;

      /*
       * Re-opening the book already playing is a no-op, so that leaving the
       * Player and coming back does not reload it — but the engine has to
       * genuinely hold it for that shortcut to be honest, or a failed load
       * leaves the play button spinning for ever. `npm run kb load`.
       *
       * The book that has just finished is the book still loaded, sitting on
       * its last second, so "Listen again" lands on exactly this shortcut and
       * has to rewind rather than hand back the end.
       */
      if (get().bookId === bookId && loadedFor === bookId && !get().error) {
        if (rewind && get().positionSec > 0) get().seekTo(0);
        return;
      }

      const token = ++openToken;
      const current = () => token === openToken;

      await get().close();
      if (!current()) return;

      set({ bookId, positionSec: startAt, playing: false, buffering: true, error: null });

      try {
        const rows = await loadParts(bookId);
        if (!current()) return;
        if (rows.length === 0) {
          set({ buffering: false, error: 'No audio files are recorded for this book.' });
          return;
        }

        // Local files only: streaming off a drive means minutes of seeking
        // before a sound, so a book that is not on the phone is not playable
        // and the Book screen offers to check it out instead. The exception is
        // a library already on the phone, where there is nothing to copy.
        const onDevice = useLibrary.getState().libraryOnDevice;
        const localUris = rows.map((p) =>
          p.local_uri ? localUriFor(p.local_uri) : onDevice ? p.uri : null,
        );
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

        if (__DEV__) {
          console.log(
            `[dueback] play "${b.title}" — ${rows.length} part(s), LOCAL, ` +
              `${Math.round(b.durationSec / 3600)}h, ` +
              `chapters ${b.chapters.length}${b.chaptersFromParts ? ' (per-part)' : ''}, ` +
              `first: ${track.parts[0]?.uri?.slice(0, 80)}`,
          );
        }

        unsubscribe = engine.subscribe((status) => {
          // A status update from a player that has since been replaced must
          // not describe the book now on screen.
          if (!current()) return;
          set({
            positionSec: status.positionSec,
            playing: status.playing,
            // Buffering means "waiting to make a sound", not "idle". A player
            // sitting loaded and paused reports neither, but one that never
            // finished loading reports `isLoaded: false` for ever, and taking
            // that as buffering put the spinner back on a button the user
            // could otherwise have pressed to try again.
            buffering: status.buffering && (status.playing || get().playing),
          });
          syncNowPlaying(status.positionSec);
          checkSleep(status.positionSec);
          persist(status.positionSec);
          if (status.finished) {
            persist(status.positionSec, true);
          }
        });

        // Before `load`, not after: the engine claims the lock screen during
        // load, and it can only do that with the right chapter if it already
        // knows it.
        lastSubtitle = '';
        syncNowPlaying(startAt);

        await useSound.getState().load(bookId);
        if (!current()) return;
        await withTimeout(
          engine.load(track, startAt),
          LOAD_TIMEOUT_MS,
          'The audio engine did not respond.',
        );
        if (!current()) return;
        await engine.setRate(SPEEDS[get().speedIndex]);
        loadedFor = bookId;
        set({ buffering: false });
        // Remembered so the next launch can come back to it.
        void setSetting(SETTING_KEYS.lastBookId, bookId);
      } catch (err) {
        if (!current()) return;
        // Leave nothing half-loaded behind: the next attempt must start from a
        // clean engine, and the spinner must give way to something the user
        // can act on.
        loadedFor = null;
        await engine.unload().catch(() => {});
        set({
          buffering: false,
          playing: false,
          error: (err as Error)?.message ?? 'That book would not open.',
        });
      }
    },

    openAt: async (bookId, positionSec) => {
      await get().open(bookId);
      // Another book may have been opened while this one loaded.
      if (get().bookId !== bookId) return;
      get().seekTo(positionSec);
    },

    reload: async (andPlay = false) => {
      const id = get().bookId;
      if (!id) return;
      loadedFor = null;
      await get().close();
      await get().open(id);
      if (andPlay && !get().error && get().bookId === id) get().togglePlay();
    },

    /**
     * Reopens whatever was playing when the app was last closed: loaded,
     * paused, at the saved position — never started on its own. Silent about
     * failures, since the book may have been returned or forgotten since.
     */
    restoreLastBook: async () => {
      if (get().bookId) return;
      try {
        const id = await getSetting(SETTING_KEYS.lastBookId);
        if (!id) return;
        const book = useLibrary.getState().books.find((b) => b.id === id);
        if (!book) return;
        await get().open(id);
        if (get().error) {
          // It will not play any more — do not keep offering it.
          set({ bookId: null, error: null });
          void setSetting(SETTING_KEYS.lastBookId, null);
        }
      } catch {
        // Never let this stop the app starting.
      }
    },

    close: async () => {
      loadedFor = null;
      if (get().bookId) persist(get().positionSec, true);
      // Stopping is deliberate — do not reopen this on the next launch.
      void setSetting(SETTING_KEYS.lastBookId, null);
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
        sleepDeadlineAt: null,
        sleepRemainingSec: null,
      });
    },

    togglePlay: () => {
      const id = get().bookId;
      /*
       * Nothing is loaded, so there is nothing to play. Pressing play here
       * used to set the button to "pause" and call a player that was not
       * there: the screen claimed to be playing in silence. Try the load
       * again instead, which is what the user is really asking for.
       */
      if (id && loadedFor !== id) {
        set({ playing: false });
        void get().reload(true);
        return;
      }

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
        const timed = option.kind === 'timer';
        return {
          sleepIndex,
          sleepDeadlineAt: timed ? Date.now() + option.minutes * 60_000 : null,
          sleepRemainingSec: timed ? option.minutes * 60 : null,
        };
      }),

    savePosition: () => {
      if (get().bookId) persist(get().positionSec, true);
    },

  };
});

/*
 * Let go of a book whose audio is being deleted — a return, or a copy thrown
 * away. Silence first and tidy up after: the files are going now, and the
 * engine must not be left playing from them.
 */
onBookAudioRemoved((bookId) => {
  const player = usePlayer.getState();
  if (player.bookId !== bookId) return;
  if (player.playing) player.togglePlay();
  void player.close();
});

/** Real seconds needed to finish the book at the current speed. */
export function realSecondsLeft(durationSec: number, positionSec: number, speed: number) {
  return Math.max(0, (durationSec - positionSec) / speed);
}
