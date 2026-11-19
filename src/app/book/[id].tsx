/**
 * Book — the library card view. Everything known about one book, its stamped
 * checkout history, and the two moves available: keep listening, or return it.
 */

import { Pressable, ScrollView, Share, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useMemo, useState } from 'react';
import { chapterAt, fractionAt, isCheckedOut, isRemote } from '@/data/types';
import { selectBook, useLibrary } from '@/store/library';
import { useSources } from '@/store/sources';
import { fetchDetail } from '@/lib/abs/catalogue';
import { usePlayer } from '@/store/player';
import { duplicatesOf, folderLabel } from '@/lib/library/duplicates';
import { bytes, hoursClock, hoursMinutes, hoursLeft, relativeTime, stampDate } from '@/lib/format';
import { color, font, space, TOUCH } from '@/theme/tokens';
import { useTheme } from '@/store/theme';
import { BookCover } from '@/components/BookCover';
import { LibraryCardSheet } from '@/components/LibraryCard';
import { BookTabs, type BookTab } from '@/components/BookTabs';
import { ChaptersTab } from '@/components/ChaptersTab';
import { NotesTab } from '@/components/NotesTab';
import { CharactersTab } from '@/components/CharactersTab';
import { NoteCard, NoteText } from '@/components/NoteCard';
import { ChevronLeft, PauseIcon, PlayIcon } from '@/components/icons';
import { CharacterSheet } from '@/components/CharacterSheet';
import { BookDetailsSheet, type ScannedDetails } from '@/components/BookDetailsSheet';
import type { BookOverride } from '@/lib/library/overrides';
import { clearOverride, loadOverride, saveOverride } from '@/db/overrides';
import { loadScannedDetails } from '@/db/books';
import { storeUserCover } from '@/lib/files/covers';
import * as ImagePicker from 'expo-image-picker';
import { NoteSheet } from '@/components/NoteSheet';
import { useMiniPlayerInset } from '@/components/MiniPlayer';
import { useNotes } from '@/store/notes';
import { exportNotes } from '@/lib/notes/export';
import { canUseCharacters, exportIsComplete } from '@/lib/pro';
import { useGate } from '@/store/pro';
import { markLabel, markLabelCaps, markWordPlural } from '@/lib/library/marks';
import { useBackup } from '@/store/backup';
import type { Character, Note } from '@/data/notes';

/**
 * The cover beside the facts, at about 104pt wide.
 *
 * Not a hero any more. This screen is about deciding what to do with the
 * book, so the artwork identifies it and the column beside it carries what
 * the decision is made on.
 */
const COVER_SCALE = 104 / 168;

type Action = {
  /** The whole sentence, for a screen reader: the short form plus the size. */
  label: string;
  /** What the row says beside the disc. */
  sentence: string;
  /** The quiet line under it: where you are, or what this would cost. */
  context?: string;
  onPress?: () => void;
  /** A copy in flight: shown as a percentage in place of the glyph. */
  busy?: string;
  /**
   * What kind of action it is, which decides its colour.
   *
   * `play` is the lamp amber everything else in the app uses for "go".
   * `checkout` is the green, for the one action that puts a book on the
   * phone — it is the decision on this screen, so it is the thing the eye
   * should land on.
   */
  tone?: 'play' | 'checkout';
};

/**
 * Giving the book back, or giving up a place in the queue. Two different
 * moves and two different glyphs, but the same disc beside the same play.
 */
/**
 * The quieter line under the button.
 *
 * `checkout` is green and `return` is red, because they are the two moves
 * that change what the phone is holding and they are opposites. `cancel`
 * stays grey: backing out of a queue costs nothing either way.
 */
type Secondary = {
  label: string;
  kind: 'return' | 'cancel' | 'checkout';
  onPress: () => void;
};

/**
 * The one action, as a bar across the page.
 *
 * It carries three things because all three are wanted at once: a glyph so
 * it is findable without reading, what pressing it does, and where it would
 * put you. The states that cannot play keep the bar and go flat — what is
 * wrong is said in the stamp above and the line inside it, not by taking
 * the control away and leaving a hole.
 */
function PrimaryAction({ action, playing }: { action: Action; playing: boolean }) {
  const live = !!action.onPress;
  return (
    <Pressable
      onPress={action.onPress}
      disabled={!live}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: !live }}
      style={({ pressed }) => ({
        minHeight: 54,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 18,
        borderRadius: 10,
        backgroundColor: live
          ? action.tone === 'checkout'
            ? color.checkout
            : color.accent
          : color.panel,
        borderWidth: live ? 0 : 1,
        borderColor: color.border,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {playing ? (
        <PauseIcon size={18} fill={live ? color.ground : color.faint} />
      ) : (
        <PlayIcon size={18} fill={live ? color.ground : color.faint} />
      )}
      <Text
        style={{
          fontFamily: font.serif,
          fontSize: 18,
          color: live ? color.ground : color.muted,
        }}
      >
        {action.sentence}
      </Text>
      <View style={{ flex: 1 }} />
      {action.context ? (
        <Text
          numberOfLines={1}
          style={{
            flexShrink: 1,
            fontFamily: font.mono,
            fontSize: 11,
            color: live ? color.ground : color.faint,
          }}
        >
          {action.context}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function BookScreen() {
  /*
   * Subscribed so a change of scheme repaints this screen.
   *
   * The colours themselves live in a module object that swaps in place, so
   * nothing here reads them differently — but a component that does not run
   * again keeps what it last painted. One line per screen, and everything
   * the screen renders comes with it.
   */
  useTheme((s) => s.version);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const book = useLibrary(selectBook(id));
  const books = useLibrary((s) => s.books);
  const driveConnected = useLibrary((s) => s.driveConnected);
  const libraryOnDevice = useLibrary((s) => s.libraryOnDevice);
  const checkOut = useLibrary((s) => s.checkOut);
  const returnBook = useLibrary((s) => s.returnBook);
  const cancelHold = useLibrary((s) => s.cancelHold);
  const checkOutAndPlay = useLibrary((s) => s.checkOutAndPlay);

  // Before the early return below, because hooks cannot run conditionally.
  const twins = useMemo(() => (book ? duplicatesOf(books, book) : []), [books, book]);
  /*
   * The live position, while this is the book playing.
   *
   * The library's own copy is only committed when playback pauses or stops, so
   * that saving it does not rebuild every shelf. This is the one screen that
   * would show the gap — and the engine's figure is the better answer anyway,
   * being where the listener actually is.
   */
  const livePosition = usePlayer((s) => (book && s.bookId === book.id ? s.positionSec : null));
  /** Playing *this* book: the disc shows pause rather than play. */
  const playingThis = usePlayer((s) => (book ? s.bookId === book.id && s.playing : false));

  const [tab, setTab] = useState<BookTab>('notes');
  /** Whose notes the list is narrowed to, or null for the whole book. */
  const [whose, setWhose] = useState<string | null>(null);
  const [showCard, setShowCard] = useState(false);
  /** Somebody is being invented: the editor is open with nothing written. */
  const [makingCharacter, setMakingCharacter] = useState(false);
  const miniPlayerInset = useMiniPlayerInset();
  /*
   * Two gates, and they are deliberately not the same question. Making a
   * character is the paid part; having one in your own export is not, and
   * never will be — see the promises in `lib/pro.ts`.
   */
  const canAddCharacters = useGate(canUseCharacters);
  const exportComplete = useGate(exportIsComplete);
  const [editing, setEditing] = useState<string | null>(null);
  const [openCharacter, setOpenCharacter] = useState<Character | null>(null);
  /** The details sheet, and what it needs to show a difference. */
  const [editingDetails, setEditingDetails] = useState(false);
  const [scanned, setScanned] = useState<ScannedDetails | null>(null);
  const [override, setOverride] = useState<BookOverride | null>(null);

  const notes = useNotes((s) => s.notes);
  const notesBookId = useNotes((s) => s.bookId);
  const characters = useNotes((s) => s.characters);
  const loadNotes = useNotes((s) => s.load);
  const setNoteText = useNotes((s) => s.setNoteText);
  const flushNotes = useNotes((s) => s.flush);
  const deleteNote = useNotes((s) => s.deleteNote);
  const undoDelete = useNotes((s) => s.undoDelete);
  const undoable = useNotes((s) => s.undoable);
  const addCharacter = useNotes((s) => s.addCharacter);
  const updateCharacter = useNotes((s) => s.updateCharacter);
  const deleteCharacter = useNotes((s) => s.deleteCharacter);
  const addToBio = useNotes((s) => s.addToBio);
  const showSlip = useLibrary((s) => s.showSlip);
  const sources = useSources((s) => s.sources);
  const refresh = useLibrary((s) => s.refresh);
  const refreshBook = useLibrary((s) => s.refreshBook);
  const stream = usePlayer((s) => s.stream);
  const backupEnabled = useBackup((s) => s.enabled);
  const backupPending = useBackup((s) => s.pending);

  useEffect(() => {
    if (id) void loadNotes(id);
  }, [id, loadNotes]);

  /*
   * What the files say, and what has been corrected, read when the sheet is
   * opened rather than on every visit to the screen. Two queries that nothing
   * else on this screen needs — `loadBooks` has already layered the
   * corrections into the book being displayed.
   */
  useEffect(() => {
    if (!editingDetails || !id) return;
    let alive = true;
    void (async () => {
      const [facts, saved] = await Promise.all([loadScannedDetails(id), loadOverride(id)]);
      if (!alive) return;
      setScanned(facts);
      setOverride(saved);
    })();
    return () => {
      alive = false;
    };
  }, [editingDetails, id]);

  /*
   * A book from a server is re-read on open, which is where its chapters
   * come from: the catalogue knows how long a book is, not what it is made
   * of. Cheap, cached, and the only way a chapter list stays current when
   * the book changes on the server.
   *
   * Nothing here can fail visibly. If the server cannot be reached, the
   * cached record from last time is used and the screen says so — the
   * alternative is a downloaded book with no chapters because the wifi is
   * off, which is the case this most needs to survive.
   */
  /** Said when the chapters on screen came from the cache, not the server. */
  const [serverNote, setServerNote] = useState<string | null>(null);
  const bookSourceId = book?.sourceId;
  const bookRemoteId = book?.remoteId;
  const bookRowId = book?.id;
  useEffect(() => {
    if (!bookRowId || !bookSourceId || !bookRemoteId) return;
    let alive = true;
    void (async () => {
      const client = await useSources.getState().clientFor(bookSourceId).catch(() => null);
      const result = await fetchDetail(client, bookRowId, bookRemoteId).catch(() => null);
      if (!alive || !result) return;
      setServerNote(
        result.cached
          ? `Chapters as the server last gave them${result.cachedAt ? `, ${relativeTime(result.cachedAt)}` : ''}.`
          : null,
      );
      // The chapters are written to the database, so the screen has to
      // re-read to see them.
      if (!result.cached) await refresh();
    })();
    return () => {
      alive = false;
    };
  }, [bookRowId, bookSourceId, bookRemoteId, refresh]);

  // The offer to undo a deletion does not sit there for the rest of the
  // session; long enough to change your mind, not long enough to be furniture.
  const clearUndo = useNotes((s) => s.clearUndo);
  useEffect(() => {
    if (!undoable) return;
    const timer = setTimeout(clearUndo, 12000);
    return () => clearTimeout(timer);
  }, [undoable, clearUndo]);

  if (!book) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: color.ground,
          alignItems: 'center',
          justifyContent: 'center',
          padding: space.xl,
          gap: space.md,
        }}
      >
        <Text style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}>
          Not on the shelf.
        </Text>
        <Pressable onPress={() => router.replace('/')} accessibilityRole="button">
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
            back to the library
          </Text>
        </Pressable>
      </View>
    );
  }

  const out = isCheckedOut(book);
  /*
   * A book from a server reaches the phone over the network, so the
   * drive's availability is not what decides whether it can be fetched.
   * Everything else on this screen — the hero, the chapters, the notes,
   * the characters — is read from the database and does not care where the
   * book came from.
   */
  const remote = isRemote(book);
  /** Which server it came from, for the download line. */
  const sourceLabel =
    sources.find((source) => source.id === book.sourceId)?.label ?? 'the server';
  const copying = book.local.status === 'copying';
  const onHold = book.local.status === 'on-hold';
  const position = livePosition ?? book.progressSec;
  const fraction = fractionAt(book, position);
  const started = position > 60;
  const finished = !!book.finishedAt;

  const progressLabel = finished
    ? `finished ${stampDate(book.finishedAt!)}`
    : started
      ? `${Math.round(fraction * 100)}% · ${hoursLeft(Math.max(0, book.durationSec - position))} to go`
      : 'not started';

  /** The primary action depends entirely on where the audio currently lives. */
  /*
   * `navigate`, not `push`. The player can be reached from here and from
   * the mini player, and pushing a second copy of it onto the stack is how
   * going back starts bouncing between two screens instead of leaving.
   */
  const openPlayer = (id: string) => router.navigate(`/player/${id}`);

  /**
   * The one action that matters, whatever state the book is in. A book that is
   * not on the phone is checked out and then played, rather than opening a
   * player that has nothing to play.
   */
  /*
   * Nothing in the folder could be read as audio. The store refuses to check
   * such a book out, but two routes to the Player do not pass through that
   * refusal — a book already on the phone, and one checked out before its
   * files went bad — and both offered Play on a book with no parts at all.
   */
  /*
   * `files` is what a scan found in a folder, so a drive book with none has
   * nothing that can be opened and is genuinely dead.
   *
   * A book on a server has none until it is downloaded, which is simply its
   * state on the shelf. Testing it the same way put "No audio that can be
   * read" — a dead end with no button — over a book that streams and
   * downloads perfectly well, while the stream link sat underneath it
   * contradicting the sentence above it.
   */
  const playable = remote
    ? book.durationSec > 0
    : book.files.length > 0 && book.durationSec > 0;

  const backupLine = libraryOnDevice
    ? 'Saved on phone'
    : !backupEnabled
      ? 'Saved on phone · drive backup off'
      : backupPending
        ? 'Saved on phone · drive backup pending'
        : 'Saved on phone and on the drive';

  /** Only this book's notes; the store holds one book at a time. */
  const mine = notesBookId === book.id ? notes : [];
  const editingNote: Note | null = editing
    ? (mine.find((n) => n.id === editing) ?? null)
    : null;

  /*
   * Someone new, written only when it is saved.
   *
   * This used to create the row first, named "New character", so that the
   * editor had something real to edit. Backing out left one behind, and a
   * book could collect several — all of them unnameable in a mention,
   * because they shared a name.
   */
  const saveNewCharacter = async (fields: { name: string; aliases: string; bio: string }) => {
    const made = await addCharacter(book.id, fields.name, fields.bio);
    if (!made) return;
    if (fields.aliases.trim()) {
      await updateCharacter(made.id, { name: fields.name, aliases: fields.aliases, bio: fields.bio });
    }
    setWhose(made.id);
  };

  /** Opens the player and lands on a second — a note's time chip. */
  const playFrom = (sec: number) => {
    router.navigate(`/player/${book.id}`);
    void usePlayer.getState().openAt(book.id, sec);
  };

  /*
   * Always free, and always the whole of it. This is the listener's own
   * writing; an app that holds it hostage is not one worth trusting with it.
   */
  const shareNotes = async () => {
    await flushNotes();
    const page = exportNotes({
      title: book.title,
      author: book.author,
      chapters: book.chapters,
      notes: useNotes.getState().notes,
      characters,
      /*
       * Always. This read `isPro()`, which quietly stripped a listener's own
       * characters out of their own export — the exact hostage-taking the
       * rules disclaim. Nobody saw it, because `isPro()` had returned true
       * for everyone since the day it was written.
       */
      includeCharacters: exportComplete,
    });
    try {
      await Share.share({ message: page, title: `${book.title} — notes` });
    } catch {
      showSlip({ kind: 'note', text: 'The notes could not be shared.' });
    }
  };

  /*
   * Two labels for every action: the whole sentence for a screen reader, and
   * a short form for a button half the screen wide. The size that used to
   * ride along in the label ("· 1.2 GB") is not lost — it is in the meta
   * line under the title, where it was already.
   */
  /*
   * The disc carries no words, so every one of these labels is what a screen
   * reader says and the only full sentence left. The size that used to ride
   * along in it is in the meta line under the title.
   */
  const copyPercent = Math.round(
    (book.local.status === 'copying' ? book.local.progress : 0) * 100,
  );
  const here = chapterAt(book, position);
  const chapterLabel = book.chapters.length > 0 ? markLabel(book, here.index) : null;
  /*
   * Where pressing the bar would put you: the chapter, and the position to
   * the minute. Seconds were three characters of precision nobody asked
   * for, and they pushed the line past the end of the button.
   */
  const placeNow = [chapterLabel, hoursClock(position)].filter(Boolean).join(' · ');

  /*
   * The state, stamped on beside the book with the date it changed. It
   * replaces the tag that used to sit in the header, which said the same
   * thing from as far from the book as the screen allows.
   */
  const lastOut = book.checkouts.length > 0 ? book.checkouts[book.checkouts.length - 1] : null;
  const shelfStamp = copying
    ? 'CHECKING OUT'
    : out
      ? `CHECKED OUT${lastOut ? ` · ${stampDate(lastOut.out)}` : ''}`
      : onHold
        ? 'ON HOLD'
        : book.finishedAt
          ? `FINISHED · ${stampDate(book.finishedAt)}`
          : null;

  /** The two ends of the progress line: how far in, and how far left. */
  const progressLeft = finished
    ? 'Finished'
    : started
      ? `${Math.round(fraction * 100)}%${chapterLabel ? ` · ${chapterLabel}` : ''}`
      : 'Not started';
  const progressRight = finished
    ? hoursMinutes(book.durationSec)
    : `${hoursLeft(Math.max(0, book.durationSec - position))} left`;
  /** Where you are, said the way you would say it out loud. */
  const placeLine = started
    ? placeNow
    : `${book.chapters.length || 1} chapters · ${hoursMinutes(book.durationSec)}`;

  const primary: Action = book.drmProtected
    ? {
        label: "Can't play — protected by DRM",
        sentence: "Can't play — protected by DRM",
        context: 'Only the shop that sold it can open this file',
        onPress: undefined,
      }
    : !playable
      ? {
          label: 'No audio that can be read',
          sentence: 'No audio that can be read',
          context: 'Nothing in the folder could be opened',
          onPress: undefined,
        }
      : copying
        ? {
            label: `Checking out… ${copyPercent}%`,
            sentence: 'Checking out…',
            context: `${copyPercent}% of ${bytes(book.sizeBytes)} copied`,
            onPress: undefined,
            busy: `${copyPercent}%`,
          }
        : out
          ? {
              label: finished ? 'Listen again' : started ? 'Keep listening' : 'Start listening',
              sentence: finished ? 'Listen again' : started ? 'Keep listening' : 'Start listening',
              context: placeLine,
              onPress: () => openPlayer(book.id),
            }
          : libraryOnDevice && !remote
            ? {
                /*
                 * The library is already on the phone, so there is nothing
                 * to copy and nothing to wait for — just play it.
                 *
                 * `!remote` because this is about where the *drive's*
                 * library lives. A book on a server is not in it, and has
                 * no audio on the phone until it is downloaded: offering
                 * Play for one sent the player at a book with no files.
                 */
                label: 'Play',
                sentence: started ? 'Keep listening' : 'Start listening',
                context: placeLine,
                onPress: () => openPlayer(book.id),
              }
            : onHold
              ? {
                  // On hold means two different things depending on what is
                  // missing: the drive, or a turn in the queue behind another
                  // copy. Saying "waiting for the drive" with the drive plugged
                  // in reads as a bug.
                  label: remote || driveConnected ? 'In the queue' : 'Waiting for the drive',
                  sentence: remote || driveConnected ? 'In the queue' : 'Waiting for the drive',
                  context:
                    remote || driveConnected
                      ? 'It will start when the one ahead finishes'
                      : 'It will copy as soon as the drive is connected',
                  onPress: undefined,
                }
              : remote
                ? {
                    /*
                     * Streaming is the way in for a book on a server.
                     *
                     * Downloading was, and it made the shelf feel like a
                     * queue of chores: every book asked for a wait and a
                     * few hundred megabytes before it would make a sound.
                     * A server is on the network, and the thing you
                     * usually want from it is to hear the book now.
                     *
                     * The download is still there, underneath, for the
                     * listening you do without a network. It is the one
                     * that needs saying out loud — "to phone" — because it
                     * is the one that takes room.
                     */
                    label: started ? 'Keep listening' : 'Start listening',
                    sentence: started ? 'Keep listening' : 'Start listening',
                    context: `Streams from ${sourceLabel} · ${placeLine}`,
                    onPress: () => {
                      void stream(book.id).then(() => openPlayer(book.id));
                    },
                  }
                : {
                    // The decision on this screen, so it wears the green.
                    tone: 'checkout',
                    label: driveConnected
                      ? `Check out and play · ${bytes(book.sizeBytes)}`
                      : `Put on hold · ${bytes(book.sizeBytes)}`,
                    sentence: driveConnected ? 'Check out and play' : 'Put on hold',
                    context: driveConnected
                      ? `Copies ${bytes(book.sizeBytes)} to your phone first`
                      : `${bytes(book.sizeBytes)} · waiting for the drive`,
                    onPress: () =>
                      driveConnected
                        ? checkOutAndPlay(book.id, openPlayer)
                        : checkOut(book.id),
                  };

  const secondary: Secondary | null = out
    ? {
        /*
         * One word for it, whichever library it came from. "Delete the
         * download" described the plumbing; returning a book is what the
         * reader is doing, and the server's copy goes back to being a
         * book on a shelf exactly as the drive's does.
         */
        label: `Return book · frees ${bytes(book.sizeBytes)}`,
        kind: 'return',
        onPress: () => returnBook(book.id),
      }
      : onHold
      ? {
          label: remote || driveConnected ? 'Leave the queue' : 'Cancel the hold',
          kind: 'cancel',
          onPress: () => cancelHold(book.id),
        }
    : remote && !copying
        ? {
            /*
             * The other way to listen, under the one that streams.
             *
             * Streaming needs the network for as long as you listen; a
             * download needs it once and then never again. That is the
             * whole trade, and it is why this is the one that names the
             * size — it is what the choice actually costs.
             *
             * "Check out", not "download": a book reaching the phone is a
             * checkout wherever it came from, and this app has one word
             * for that. The server fetches rather than copies, which is a
             * fact about plumbing and not about what the reader is doing.
             */
            label: `Check out · ${bytes(book.sizeBytes)}`,
            kind: 'checkout',
            onPress: () => checkOutAndPlay(book.id, openPlayer),
          }
        : playable && !copying && driveConnected && !libraryOnDevice
          ? {
              /*
               * Check it out without starting it.
               *
               * The button above copies and then plays, which is what you
               * want standing in front of a book you mean to read now. It
               * is not what you want filling a bag for a flight, and until
               * this line the only way to take a book without starting it
               * was to press play and then pause.
               *
               * The server library has had this split since streaming
               * became the way in; this is the drive's half of it.
               */
              label: `Check out · ${bytes(book.sizeBytes)}`,
              kind: 'checkout',
              onPress: () => checkOut(book.id),
            }
          : null;

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <View
        style={{
          paddingTop: 14,
          paddingHorizontal: space.md,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Pressable
          /*
           * The library, not whatever came before. Reached from the player
           * — which happens whenever the player was opened from the mini
           * player rather than from here — going back landed on the
           * player again, and the two bounced off each other.
           */
          onPress={() => router.navigate('/')}
          accessibilityRole="button"
          accessibilityLabel="Back to the library"
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            minHeight: TOUCH,
            paddingHorizontal: 8,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <ChevronLeft />
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            Library
          </Text>
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        // Nothing is pinned to the bottom of this screen, so the scroll has
        // to clear the gesture bar and the docked player itself.
        contentContainerStyle={{ paddingBottom: insets.bottom + 36 + miniPlayerInset }}
        showsVerticalScrollIndicator={false}
      >
        {/*
          The book, said once: what it looks like, what it is, and where it
          is. The cover is a thumbnail here rather than a hero — this screen
          is about deciding what to do with the book, and the facts beside
          it are what that decision is made on.
        */}
        <View
          style={{
            paddingTop: space.sm,
            paddingHorizontal: space.xl,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 18,
          }}
        >
          <BookCover
            book={book}
            size="book"
            showTag={false}
            showRibbon={false}
            lean={0}
            edgeWidth={10}
            scale={COVER_SCALE}
          />

          <View style={{ flex: 1, minWidth: 0, gap: 6, paddingTop: 4 }}>
            <Text
              accessibilityRole="header"
              style={{
                fontFamily: font.serif,
                fontSize: 25,
                lineHeight: 25 * 1.05,
                color: color.paper,
              }}
            >
              {book.title}
            </Text>
            <Text style={{ fontFamily: font.sans, fontSize: 14, color: color.paperCard }}>
              {book.author}
            </Text>
            {book.narrator ? (
              <Text style={{ fontFamily: font.sans, fontSize: 13, color: color.muted }}>
                read by {book.narrator}
              </Text>
            ) : null}
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
              {hoursMinutes(book.durationSec)} · {bytes(book.sizeBytes)}
            </Text>

            {/*
              A plain link rather than a long-press, because nobody goes
              looking for a gesture to fix a title. It says "edited" once
              something has been corrected, so a book that does not match its
              files says so on the screen where you would wonder why.
            */}
            <Pressable
              onPress={() => setEditingDetails(true)}
              accessibilityRole="button"
              accessibilityLabel="Edit this book's title, author and cover"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: 4 })}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                {book.overridden ? 'edited · details →' : 'edit details →'}
              </Text>
            </Pressable>

            {/*
              Stamped on at a slight angle, the way a date is. It says the
              state and when it changed, which together are what the old tag
              in the header was saying from much further away.
            */}
            {shelfStamp ? (
              <View
                style={{
                  alignSelf: 'flex-start',
                  marginTop: 6,
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                  borderWidth: 1.5,
                  borderColor: color.accent,
                  transform: [{ rotate: '-2deg' }],
                }}
              >
                <Text
                  style={{
                    fontFamily: font.mono,
                    fontSize: 10,
                    letterSpacing: 0.8,
                    color: color.accent,
                  }}
                >
                  {shelfStamp}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={{ paddingTop: space.xl, paddingHorizontal: space.xl, gap: 14 }}>
          <View style={{ gap: 7 }}>
            <View
              style={{
                height: 4,
                borderRadius: 2,
                backgroundColor: color.line,
                overflow: 'hidden',
              }}
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel={progressLabel}
            >
              <View
                style={{
                  width: `${Math.max(fraction * 100, started ? 2 : 0)}%`,
                  height: '100%',
                  backgroundColor: color.ribbon,
                }}
              />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
                {progressLeft}
              </Text>
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
                {progressRight}
              </Text>
            </View>
          </View>

          <PrimaryAction action={primary} playing={playingThis} />

          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: -6,
            }}
          >
            {secondary ? (
              <Pressable
                onPress={secondary.onPress}
                accessibilityRole="button"
                accessibilityLabel={secondary.label}
                style={({ pressed }) => ({
                  minHeight: TOUCH,
                  justifyContent: 'center',
                  paddingHorizontal: 4,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text
                  style={{
                    fontFamily: font.mono,
                    fontSize: 12,
                    color:
                      secondary.kind === 'checkout'
                        ? color.checkout
                        : secondary.kind === 'return'
                          ? color.warning
                          : color.muted,
                  }}
                >
                  {secondary.label}
                </Text>
              </Pressable>
            ) : (
              <View />
            )}

            <Pressable
              onPress={() => setShowCard(true)}
              accessibilityRole="button"
              accessibilityLabel="Library card — when this book went out and came back"
              style={({ pressed }) => ({
                minHeight: TOUCH,
                justifyContent: 'center',
                paddingHorizontal: 4,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text
                style={{
                  fontFamily: font.mono,
                  fontSize: 12,
                  color: color.muted,
                  textDecorationLine: 'underline',
                }}
              >
                Library card
              </Text>
            </Pressable>
          </View>
        </View>

        {book.drmProtected ? (
          <NoteCard stamp="PROTECTED">
            <NoteText>
              {`This file is encrypted — an Audible or iTunes purchase that only their own apps can open. Due Back can list it, but nothing can play it from here. A version you own outright will work.`}
            </NoteText>
          </NoteCard>
        ) : null}

        {book.missingFromDrive ? (
          <NoteCard stamp="NOT ON THE DRIVE">
            <NoteText>
              {`The last scan couldn't find this one on the drive — moved, renamed or deleted.`}
              {out ? ' Your phone has the only copy, so returning it will ask twice.' : ''}
            </NoteText>
          </NoteCard>
        ) : null}

        {/*
          Not a warning: two copies may be entirely deliberate. It is here so
          that nobody checks out 1.5 GB twice without knowing they have it.
        */}
        {twins.length > 0 ? (
          <NoteCard stamp="ALSO IN THE LIBRARY" tone="quiet">
            <NoteText>
              {`The same title and author ${twins.length === 1 ? 'is' : 'are'} also in:`}
            </NoteText>
            {twins.map((twin) => (
              <Pressable
                key={twin.id}
                onPress={() => router.replace(`/book/${twin.id}`)}
                accessibilityRole="button"
                accessibilityLabel={`Open the copy in ${folderLabel(twin)}`}
                style={({ pressed }) => ({
                  minHeight: 32,
                  justifyContent: 'center',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                  {folderLabel(twin)}
                  {isCheckedOut(twin) ? ' · on your phone' : ''}
                </Text>
              </Pressable>
            ))}
          </NoteCard>
        ) : null}

        <View style={{ marginTop: space.md }}>
          <BookTabs
            active={tab}
            chaptersLabel={markWordPlural(book)}
            counts={{
              chapters: book.chapters.length,
              notes: mine.length,
              characters: characters.length,
            }}
            onChange={setTab}
          />
        </View>

        {/*
          Undo lives here rather than in a slip: the slip has no button, and
          a deletion is the one thing worth offering back for longer than a
          message stays on screen.
        */}
        {undoable && tab === 'notes' ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginHorizontal: space.xl,
              paddingVertical: space.sm,
              borderBottomWidth: 1,
              borderBottomColor: color.line,
            }}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
              Note deleted
            </Text>
            <Pressable onPress={() => void undoDelete()} accessibilityRole="button" hitSlop={10}>
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>Undo</Text>
            </Pressable>
          </View>
        ) : null}

        {tab === 'chapters' ? (
          <>
            {remote ? (
              <View style={{ paddingHorizontal: space.xl, paddingTop: space.sm, gap: 4 }}>
                {serverNote ? (
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.warning }}>
                    {serverNote}
                  </Text>
                ) : null}
                {/*
                  The way to the plain server view, which is where the
                  things only a tester wants — the remote id, when the
                  record was cached, what the last progress push did —
                  live. Kept off this screen and one tap away from it.
                */}
                <Pressable
                  onPress={() => router.push(`/abs/${book.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel="Server details for this book"
                  style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: 4 })}
                >
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                    {sourceLabel} · server details →
                  </Text>
                </Pressable>
              </View>
            ) : null}
            <ChaptersTab book={book} notes={mine} currentIndex={here.index} onPlayFrom={playFrom} />
          </>
        ) : null}

        {tab === 'notes' ? (
          <NotesTab
            book={book}
            notes={mine}
            /*
              Always the real list. This passed `[]` without Pro, hiding
              characters somebody had already made — from their own notes.
              Pro gates making them, never seeing them.
            */
            characters={characters}
            selected={whose}
            onSelect={setWhose}
            onPlayFrom={playFrom}
            onOpenNote={(note) => setEditing(note.id)}
            onExport={() => void shareNotes()}
          />
        ) : null}

        {tab === 'characters' ? (
          <CharactersTab
            book={book}
            characters={characters}
            notes={mine}
            onOpen={setOpenCharacter}
            // The gate that was right all along: making a new one is paid.
            onAdd={canAddCharacters ? () => setMakingCharacter(true) : undefined}
          />
        ) : null}

        {/*
          Where this book's writing is. Said plainly rather than with an
          icon: "pending" here means the phone has it and the drive does not
          yet, which is a fact worth being able to read.
        */}
        <Text
          style={{
            marginTop: space.xl,
            marginHorizontal: space.xl,
            fontFamily: font.mono,
            fontSize: 11,
            color: color.faint,
          }}
        >
          {backupLine}
        </Text>
      </ScrollView>

      {/*
        Mounted only while open, and only once what it needs has arrived. It
        shows the difference between the screen and the files, so rendering it
        before the scan's own values are read would mean a first frame in
        which every field looked uncorrected.
      */}
      {editingDetails && scanned ? (
        <BookDetailsSheet
          book={book}
          scanned={scanned}
          override={override}
          onSave={(patch) => {
            void (async () => {
              await saveOverride(book.id, patch);
              setOverride(await loadOverride(book.id));
              // One book, not the library. `refresh` rebuilds every book,
              // part, chapter and checkout, which is a visible stutter right
              // after Save on a real library.
              await refreshBook(book.id);
            })();
          }}
          onPickCover={() => {
            void (async () => {
              /*
               * No permission request: the system photo picker hands back one
               * chosen file and needs none. Asking would be a dialog that
               * buys nothing, on a app whose whole point is that it wants
               * nothing from you.
               */
              const picked = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: 'images',
                allowsEditing: true,
                // A cover is square. Cropping on the way in means the shelf
                // never has to guess what to cut.
                aspect: [1, 1],
              });
              if (picked.canceled || !picked.assets[0]) return;
              const stored = await storeUserCover(book.id, picked.assets[0].uri);
              if (!stored) return;
              await saveOverride(book.id, { coverFile: stored.fileName });
              setOverride(await loadOverride(book.id));
              await refreshBook(book.id);
            })();
          }}
          onClearCover={() => {
            void (async () => {
              await saveOverride(book.id, { coverFile: null });
              setOverride(await loadOverride(book.id));
              await refreshBook(book.id);
            })();
          }}
          onRevertAll={() => {
            void (async () => {
              await clearOverride(book.id);
              setOverride(null);
              await refreshBook(book.id);
            })();
          }}
          onClose={() => setEditingDetails(false)}
        />
      ) : null}

      <LibraryCardSheet
        visible={showCard}
        checkouts={book.checkouts}
        title={book.title}
        onClose={() => setShowCard(false)}
      />

      <NoteSheet
        key={editing ?? 'none'}
        visible={editingNote !== null}
        note={editingNote}
        chapterLabel={
          editingNote && book.chapters.length > 0
            ? markLabelCaps(book, chapterAt(book, editingNote.positionSec).index)
            : null
        }
        characters={characters}
        atSec={editingNote?.positionSec ?? 0}
        canTag={canAddCharacters}
        onSave={(text) => {
          if (editingNote) {
            setNoteText(editingNote.id, text.trim());
            void flushNotes();
          }
          setEditing(null);
        }}
        onAddCharacter={(name, bio) => addCharacter(book.id, name, bio)}
        onDelete={(note) => void deleteNote(note.id)}
        onClose={() => setEditing(null)}
      />

      <CharacterSheet
        key={openCharacter?.id ?? (makingCharacter ? 'new' : 'none')}
        book={book}
        character={openCharacter}
        creating={makingCharacter}
        characters={characters}
        notes={mine}
        onSave={(fields) => {
          if (openCharacter) void updateCharacter(openCharacter.id, fields);
          else void saveNewCharacter(fields);
        }}
        onDelete={() => {
          if (openCharacter) {
            void deleteCharacter(openCharacter.id);
            if (whose === openCharacter.id) setWhose(null);
          }
          setOpenCharacter(null);
          setMakingCharacter(false);
        }}
        onPlayFrom={(sec) => {
          setOpenCharacter(null);
          playFrom(sec);
        }}
        onAddToBio={(text) => {
          if (openCharacter) void addToBio(openCharacter.id, text);
        }}
        onClose={() => {
          setOpenCharacter(null);
          setMakingCharacter(false);
        }}
      />
    </View>
  );
}
