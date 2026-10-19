/**
 * Playback state.
 *
 * All audio goes through the `AudioEngine` interface, which hides the fact
 * that a book may be one file or a hundred and twenty-seven. Everything here
 * is expressed in whole-book seconds: chapters, progress and the scrubber all
 * share one timeline, and the engine works out which file that lands in.
 */

import { create } from 'zustand';
import { chapterAt, isRemote, type Book } from '@/data/types';
import { createExpoAudioEngine } from '@/lib/audio/expoAudioEngine';
import { SPEEDS, type AudioEngine, type EngineTrack } from '@/lib/audio/engine';
import { loadParts } from '@/db/books';
import { SETTING_KEYS, getSetting, setSetting } from '@/db/schema';
import { localUriFor } from '@/lib/files/copy';
import { onBecomingNoisy } from '@/lib/audio/soundFx';
import { useSound } from './sound';
import { onBookAudioRemoved, onBookCheckedOut, useLibrary } from './library';
import { flushProgressPush, reconcileBeforePlay, setStreaming } from './absProgress';
import { StreamSession, SYNC_INTERVAL_MS, isTranscode } from '@/lib/abs/session';
import { describeAbsError } from '@/lib/abs/errors';
import { absDeviceId } from '@/lib/abs/device';
import { loadTokens } from '@/lib/abs/tokens';
import { setSourceClosedListener, useSources } from './sources';
import { getSource } from '@/db/sources';
import { timestamp } from '@/lib/format';

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

  /**
   * True while the book on screen is coming off a server rather than off
   * the phone. It occupies no budget and is not checked out; it is simply
   * a different way of reaching the same book.
   */
  streaming: boolean;

  open: (bookId: string) => Promise<void>;
  /** Plays a book from a server without downloading it. */
  stream: (bookId: string) => Promise<void>;
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

/* ----------------------------------------------------------- streaming */

/** The open session, if the book playing is being streamed. */
let session: StreamSession | null = null;
/** Which book that session belongs to. */
let streamBookId: string | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
/** When listening was last counted, for working out the delta. */
let lastListenAt = 0;

/**
 * The most wall-clock time one status update may contribute.
 *
 * Updates arrive twice a second while playing, so anything much larger than
 * that is the app having been asleep rather than somebody having listened.
 * Counting that gap would inflate the listening statistics the server keeps,
 * and nothing ever subtracts it again.
 */
const MAX_LISTEN_STEP_SEC = 2;

function countListening(playing: boolean) {
  const now = Date.now();
  if (!playing || !session) {
    lastListenAt = now;
    return;
  }
  if (lastListenAt > 0) {
    session.listened(Math.min(MAX_LISTEN_STEP_SEC, (now - lastListenAt) / 1000));
  }
  lastListenAt = now;
}

/**
 * The engine's view of a session.
 *
 * A transcode is one HLS playlist covering the whole book, so it becomes a
 * single part and the player's own timeline does the rest. Direct play
 * hands back the real files, which keep their offsets and carry the
 * Authorization header — the one thing that must never go in the URL.
 */
function trackFor(
  book: Book,
  info: { playMethod: number; tracks: { startSec: number; durationSec: number; url: string }[] },
  accessToken: string,
): EngineTrack {
  const transcode = info.playMethod === 2;
  const parts = transcode
    ? [
        {
          // The HLS url is scoped to an unguessable session id that dies
          // with the session, which is why it needs no credential — and
          // why it must never be cached across app restarts.
          uri: info.tracks[0]?.url ?? '',
          startSec: 0,
          durationSec: book.durationSec,
        },
      ]
    : info.tracks.map((t) => ({
        uri: t.url,
        startSec: t.startSec,
        durationSec: t.durationSec,
        headers: { Authorization: `Bearer ${accessToken}` },
      }));

  return {
    bookId: book.id,
    title: book.title,
    author: book.author || undefined,
    artworkUri: book.coverThumbPath,
    durationSec: book.durationSec,
    parts,
  };
}

function stopSyncTimer() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

/** Ends the session with one final sync, and forgets it. */
async function endSession(positionSec: number) {
  stopSyncTimer();
  const ending = session;
  const bookId = streamBookId;
  session = null;
  streamBookId = null;
  if (bookId) setStreaming(bookId, false);
  if (ending) await ending.close(positionSec);
}

/*
 * The Sound panel's effects follow the session, which moves on every part
 * change. Subscribed once, at module scope, rather than from a screen: the
 * effects belong to playback, and playback outlives whatever is on screen.
 */
engine.onSessionChange((nativePlayer) => {
  useSound.getState().useSession(nativePlayer);
});

/*
 * The handoff from streaming to the local copy.
 *
 * A book can be checked out while it is streaming, and when the files
 * land the listener should not notice anything except that it now works
 * offline. The session is closed with its final sync first — so the
 * server hears the last of the streamed listening exactly once — and
 * playback then reopens from the same second, off the phone.
 *
 * Registered at module scope because it belongs to playback rather than
 * to any screen, and because the download may well finish while the
 * player is not the thing on top.
 */
/*
 * Signing out of a server, or removing it, stops anything streaming from it.
 *
 * Not automatic: the engine holds the track addresses and the header it was
 * given when playback started, so a book goes on playing — and its session
 * goes on reporting — against credentials the app has just been told to
 * forget. A book already downloaded is untouched, because it needs nothing
 * from the server to play.
 */
setSourceClosedListener((sourceId) => {
  const state = usePlayer.getState();
  if (!state.streaming || !state.bookId) return;
  const book = useLibrary.getState().books.find((b) => b.id === state.bookId);
  if (book?.sourceId !== sourceId) return;

  void (async () => {
    // `close` carries the session's final sync, which is still worth
    // sending: the listening happened, whatever happens to the account now.
    await usePlayer.getState().close();
    useLibrary.getState().showSlip({
      kind: 'note',
      stamp: 'SIGNED OUT',
      text: `${book.title} stopped — it was playing from a server you just signed out of.`,
    });
  })();
});

onBookCheckedOut((bookId) => {
  const state = usePlayer.getState();
  if (!state.streaming || state.bookId !== bookId) return;
  const at = state.positionSec;
  const wasPlaying = state.playing;

  void (async () => {
    /*
     * The position goes to the database first, because what comes next
     * reads it from there rather than being told. Recorded while the book
     * still counts as streaming, so the progress push stays suppressed and
     * the session — which is about to carry this same second in its final
     * sync — remains the only thing reporting it.
     */
    useLibrary.getState().recordProgress(bookId, at, { commit: true });

    /*
     * `reload`, not `open`.
     *
     * `open` returns early when it already holds the book asked for, and
     * during a handoff it always does: same book, already loaded, no
     * error. So it did nothing at all — the session stayed open and the
     * downloaded files were never picked up, which is why playback did
     * not come back by itself.
     *
     * `reload` is the path that means "throw away what you are holding
     * and open this again": it clears the loaded marker, closes — which
     * is what ends the session, with its final sync — and loads the local
     * copy at the position just recorded.
     */
    await usePlayer.getState().reload(wasPlaying);
  })();
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
    streaming: false,

    /**
     * Plays a book straight off the server.
     *
     * The session is the whole of the difference. A streamed book reports
     * its listening through that session and through nothing else — never
     * also a progress PATCH — because the server adds `timeListened` up
     * across every session row it holds, and double-reporting inflates the
     * listener's statistics permanently.
     */
    stream: async (bookId) => {
      const b = useLibrary.getState().books.find((x) => x.id === bookId);
      if (!b?.sourceId || !b.remoteId) return;

      await get().close();

      const sourceId = b.sourceId;
      const remoteId = b.remoteId;
      const source = await getSource(sourceId).catch(() => null);
      const client = await useSources.getState().clientFor(sourceId).catch(() => null);
      const tokens = await loadTokens(sourceId).catch(() => null);
      if (!source || !client || !tokens) {
        set({ bookId, error: 'Sign in to the server again to stream this book.' });
        return;
      }

      // The same rule as everywhere: the newer write wins, and the
      // comparison happens before a note is played.
      const adopted = await reconcileBeforePlay(bookId);
      const book = useLibrary.getState().books.find((x) => x.id === bookId) ?? b;
      const startAt = adopted ?? book.progressSec;
      if (adopted !== null) {
        useLibrary.getState().showSlip({
          kind: 'note',
          stamp: 'PICKED UP',
          text: `Picked up where you left off on another device — ${timestamp(adopted)}.`,
        });
      }

      set({ bookId, positionSec: startAt, playing: false, buffering: true, error: null, streaming: true });

      const deviceId = await absDeviceId();
      const live = new StreamSession(client, remoteId, deviceId, book.durationSec, {
        /*
         * A replacement session means new addresses. For a transcode they
         * are the whole of the stream, so the engine has to be handed the
         * new ones; for direct play the tracks are ordinary files whose
         * URLs did not change, and reloading would put a gap in the audio
         * for nothing.
         */
        onReopened: (next) => {
          if (!isTranscode(next)) return;
          const at = get().positionSec;
          void engine
            .load(trackFor(book, next, tokens.accessToken), at)
            .then(() => (get().playing ? engine.play() : undefined))
            .catch(() => set({ error: 'The stream could not be picked up again.' }));
        },
        onLost: () => {
          // Keep playing if audio is still arriving; the position is
          // correct locally either way and the next attempt will report.
          console.warn('[abs] streaming without a session');
        },
      });

      let opened;
      try {
        opened = await live.open();
      } catch (error) {
        console.warn(`[dueback] opening a stream for ${book.title} failed`, error);
        set({ buffering: false, streaming: false, error: describeAbsError(error, 'stream') });
        return;
      }

      session = live;
      streamBookId = bookId;
      lastListenAt = Date.now();
      // Stops the progress PATCH for as long as this session owns the book.
      setStreaming(bookId, true);
      loadedFor = bookId;

      unsubscribe?.();
      unsubscribe = engine.subscribe((status) => {
        if (get().bookId !== bookId) return;
        countListening(status.playing);
        set({
          positionSec: status.positionSec,
          playing: status.playing,
          buffering: status.buffering,
        });
        persist(status.positionSec, false);
        if (status.finished) {
          void get().close();
        }
      });

      try {
        await engine.load(trackFor(book, opened, tokens.accessToken), startAt);
        await engine.play();
      } catch (error) {
        console.warn(`[dueback] playing the stream for ${book.title} failed`, error);
        await endSession(startAt);
        set({ buffering: false, streaming: false, error: describeAbsError(error, 'stream') });
        return;
      }

      stopSyncTimer();
      syncTimer = setInterval(() => {
        if (!session) return;
        void session.sync(get().positionSec);
      }, SYNC_INTERVAL_MS);
    },

    open: async (bookId) => {
      let b = useLibrary.getState().books.find((x) => x.id === bookId);
      if (!b) return;

      /*
       * Settle the position with the server before deciding where to start.
       *
       * Every route to playback comes through here — the mini player, "Keep
       * listening", the checked-out tray, the player route — which is why
       * the comparison lives here and not on a screen. Doing it when a
       * screen opened missed all of those, and lost even on the screen that
       * did it whenever Play was pressed before the round trip came back:
       * that is what made picking up another device's position work only
       * sometimes.
       *
       * Bounded, and silent on failure. A book already on the phone must
       * play whatever the server is doing.
       */
      /*
       * Already holding this book, with no error: the screen is asking to
       * open what is playing. There is nothing to settle, and settling
       * anyway is actively harmful during a stream — the session's own
       * sync has just written our position to the server, so the server
       * reads as "newer" and the book would be yanked back to wherever
       * the last sync left it.
       */
      const alreadyLive = get().bookId === bookId && loadedFor === bookId && !get().error;
      const adopted =
        !alreadyLive && isRemote(b) ? await reconcileBeforePlay(bookId) : null;
      if (adopted !== null) {
        b = useLibrary.getState().books.find((x) => x.id === bookId) ?? b;
        useLibrary.getState().showSlip({
          kind: 'note',
          stamp: 'PICKED UP',
          text: `Picked up where you left off on another device — ${timestamp(adopted)}.`,
        });
      }

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
      if (alreadyLive) {
        if (rewind && get().positionSec > 0) get().seekTo(0);
        /*
         * A position taken from the server still has to be moved to, even
         * on the shortcut: the database and the shelves now say one thing
         * and the engine is still sitting where it was.
         */
        else if (adopted !== null) get().seekTo(adopted);
        return;
      }

      /*
       * Past the shortcut, so this really is taking over, and any stream
       * running is finished with.
       *
       * Deliberately here and not at the top of this function. It was at
       * the top, which meant that pressing Stream and then navigating to
       * the player — where the screen asks to open the book it can already
       * see — killed the session before the shortcut above had the chance
       * to say there was nothing to do. The stream kept playing with
       * nothing reporting it, or fell through to loading local files that
       * a streamed book does not have.
       */
      await endSession(get().positionSec);
      set({ streaming: false });

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
        //
        // `libraryOnDevice` is about the USB library sitting in phone
        // storage, where a part's own `uri` is already local and playable.
        // It says nothing about a book from a server, whose `uri` is a
        // placeholder and never fetchable — so a remote book is playable
        // only from a downloaded copy, and offering `p.uri` for one would
        // hand the audio engine a string it cannot open.
        const onDevice = useLibrary.getState().libraryOnDevice && !isRemote(b);
        const localUris = rows.map((p) =>
          p.local_uri ? localUriFor(p.local_uri) : onDevice ? p.uri : null,
        );
        if (localUris.some((u) => !u)) {
          set({
            buffering: false,
            error: isRemote(b)
              ? 'This book is not downloaded yet. Check it out first.'
              : 'This book is not on your phone yet. Check it out first.',
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
      // The final sync rides the close, so the server hears the last of
      // the listening in the same request that ends the session.
      await endSession(get().positionSec);
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
        streaming: false,
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
        /*
         * A pause ends the session, carrying its final sync. Sessions live
         * in the server's memory and an abandoned one reports nothing and
         * is tidied up by nobody; resuming opens a fresh one.
         */
        if (get().streaming) void endSession(get().positionSec);
        /*
         * A downloaded book pushes its place now rather than waiting out
         * the throttle. Stopping is exactly the moment the position
         * matters to another device, and a minute of silence afterwards
         * reads as the sync not working at all.
         */
        else if (id) void flushProgressPush(id);
        return;
      }

      // Resuming a stream needs a session again. For direct play the track
      // URLs are ordinary files and did not change, so only the reporting
      // has to be restarted; a transcode is handed new addresses by
      // `onReopened` and reloads itself.
      if (get().streaming && !session && id) void get().stream(id);

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
      const id = get().bookId;
      if (!id) return;
      persist(get().positionSec, true);
      /*
       * Going away is the other moment a position matters elsewhere, so a
       * downloaded book sends it now instead of waiting out the throttle.
       * A stream needs nothing here: its session is reporting already, and
       * pausing or closing carries the final sync.
       */
      if (!get().streaming) void flushProgressPush(id);
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
