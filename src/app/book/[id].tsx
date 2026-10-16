/**
 * Book — the library card view. Everything known about one book, its stamped
 * checkout history, and the two moves available: keep listening, or return it.
 */

import { Pressable, ScrollView, Share, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useMemo, useState } from 'react';
import { chapterAt, fractionAt, isCheckedOut } from '@/data/types';
import { selectBook, useLibrary } from '@/store/library';
import { usePlayer } from '@/store/player';
import { duplicatesOf, folderLabel } from '@/lib/library/duplicates';
import { bytes, hoursMinutes, hoursLeft, stampDate } from '@/lib/format';
import { color, font, shadow, space, TOUCH } from '@/theme/tokens';
import { BookCover } from '@/components/BookCover';
import { COMPACT_CARD_ESTIMATE, LibraryCard, LibraryCardSheet } from '@/components/LibraryCard';
import { NoteCard, NoteText } from '@/components/NoteCard';
import { ChevronLeft, PauseIcon, PlayIcon, ReturnIcon } from '@/components/icons';
import { MarginsCard } from '@/components/MarginsCard';
import { CharacterSheet } from '@/components/CharacterSheet';
import { NoteSheet } from '@/components/NoteSheet';
import { useNotes } from '@/store/notes';
import { exportNotes } from '@/lib/notes/export';
import { isPro } from '@/lib/pro';
import { useBackup } from '@/store/backup';
import type { Character, Note } from '@/data/notes';

/** The cover's own pixel size at scale 1, from `CoverFace`'s "book" spec. */
const COVER_BOOK_WIDTH = 168;
const COVER_BOOK_HEIGHT = 248;
/**
 * The page edge drawn beside the cover, passed to `BookCover` as `edgeWidth`.
 *
 * A sibling of the cover in a row, not part of it, so the book's outer right
 * edge is the cover plus this. Fixed rather than scaled: `PageEdge` takes the
 * number as given.
 */
const EDGE_WIDTH = 13;
/**
 * How far the card crosses the hero's centre line onto the cover.
 *
 * Small on purpose. The card is laid down *beside* the book and catches its
 * lower corner; the first version draped it across the artwork, which left
 * the whole right half of the screen empty.
 */
const CARD_OVERLAP = 18;
/**
 * How wide the compact card is, as a share of the screen.
 *
 * Down from "the rest of the hero", which made it 200px on a Pixel and loud
 * enough to compete with the cover. Its left edge stays where it was, so the
 * overlap onto the book is unchanged and it is the right edge that comes in.
 */
const CARD_WIDTH_FRACTION = 0.44;
/**
 * The two actions in the top-right, as discs rather than slabs.
 *
 * They are not in the hero any more. The hero is the object — the book and
 * the card tucked into it — and transport belongs in the flow of the page,
 * under the progress it acts on. Play is still the one loud thing: amber,
 * and twice the size of anything near it. Return is an outline at the far
 * end of the row, because it is the one move here you cannot take back by
 * tapping again.
 */
const PLAY_DIAMETER = 72;
const RETURN_DIAMETER = 44;
/**
 * What sits below the hero: the title block, the progress, the transport
 * row, and enough of the margins to show they are there.
 *
 * Back up from 300 now that transport has left the hero and always sits in
 * the flow — a 72px disc and its two lines of text that the cover can no
 * longer have. In practice width is what limits the cover on every phone
 * size checked; this only binds on something very short.
 */
const HERO_CHROME = 390;

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
};

/**
 * Giving the book back, or giving up a place in the queue. Two different
 * moves and two different glyphs, but the same disc beside the same play.
 */
type Secondary = { label: string; kind: 'return' | 'cancel'; onPress: () => void };

/**
 * The play disc. Amber, filled, and the only thing on this screen that size.
 *
 * It shows pause while this book is the one playing, so that coming back to
 * the Book screen mid-listen offers the move you actually want. The states
 * that cannot play — DRM, no readable audio, a hold waiting on the drive —
 * keep the disc but go flat and unpressable; what is wrong is said in the
 * status tag above and the progress line below, not crammed in here.
 */
function PlayButton({ action, playing }: { action: Action; playing: boolean }) {
  const live = !!action.onPress;
  return (
    <Pressable
      onPress={action.onPress}
      disabled={!live}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: !live }}
      style={({ pressed }) => [
        {
          width: PLAY_DIAMETER,
          height: PLAY_DIAMETER,
          borderRadius: PLAY_DIAMETER / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: live ? color.accent : color.panel,
          borderWidth: live ? 0 : 1,
          borderColor: color.border,
          opacity: pressed ? 0.85 : 1,
        },
        live ? shadow(10, 0.35) : null,
      ]}
    >
      {action.busy ? (
        <Text style={{ fontFamily: font.monoMedium, fontSize: 15, color: color.muted }}>
          {action.busy}
        </Text>
      ) : playing ? (
        <PauseIcon size={30} fill={live ? color.ground : color.faint} />
      ) : (
        <PlayIcon size={30} fill={live ? color.ground : color.faint} />
      )}
    </Pressable>
  );
}

/** The return disc: smaller, outlined, and never the thing the eye lands on. */
function ReturnButton({ action, finished }: { action: Secondary; finished: boolean }) {
  const ink = finished ? color.accent : color.muted;
  return (
    <Pressable
      onPress={action.onPress}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={({ pressed }) => ({
        width: RETURN_DIAMETER,
        height: RETURN_DIAMETER,
        borderRadius: RETURN_DIAMETER / 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: finished ? color.accent : color.border,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {action.kind === 'return' ? (
        <ReturnIcon size={22} stroke={ink} />
      ) : (
        <Text style={{ fontFamily: font.mono, fontSize: 11, color: ink }}>stop</Text>
      )}
    </Pressable>
  );
}

/**
 * Play, what pressing it does, and the way out — the one arrangement.
 *
 * The sentence is on the screen now rather than only in the accessibility
 * label. A disc with no words is unambiguous for a book you are part way
 * through and guesswork for one that is not on the phone yet, where the
 * same disc means "copy a gigabyte and then play it".
 */
function TransportRow({
  primary,
  secondary,
  playing,
  finished,
}: {
  primary: Action;
  secondary: Secondary | null;
  playing: boolean;
  finished: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
      <PlayButton action={primary} playing={playing} />

      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontFamily: font.sans, fontSize: 15, color: color.paper }}>
          {primary.sentence}
        </Text>
        {primary.context ? (
          <Text numberOfLines={1} style={{ fontFamily: font.sans, fontSize: 12, color: color.muted }}>
            {primary.context}
          </Text>
        ) : null}
      </View>

      {secondary ? <ReturnButton action={secondary} finished={finished} /> : null}
    </View>
  );
}

export default function BookScreen() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();

  /*
   * The hero is four quadrants, not an overlay.
   *
   * The cover fills the left half top to bottom. The two actions sit in the
   * top-right, the library card in the bottom-right, and the card crosses
   * the centre line by just enough to catch the book's lower corner — laid
   * down beside it, not pasted over it.
   *
   * The cover is sized by *width* first, so that the book and its page edge
   * come to the centre line. Sizing it by height alone is what left it at
   * 40% of the screen with the right half empty.
   */
  const [cardHeight, setCardHeight] = useState(COMPACT_CARD_ESTIMATE);

  const heroWidth = windowWidth - space.xxl * 2;
  const centreX = heroWidth / 2;
  const widthScale = (centreX - EDGE_WIDTH) / COVER_BOOK_WIDTH;
  const heightScale =
    (windowHeight - insets.top - insets.bottom - HERO_CHROME) / COVER_BOOK_HEIGHT;
  // Never past full size, never below 0.6: under that the artwork's own
  // title stops being readable and a short screen is better off scrolling.
  const coverScale = Math.max(0.6, Math.min(1, widthScale, heightScale));
  const coverHeight = COVER_BOOK_HEIGHT * coverScale;

  /*
   * The right column. On a screen too narrow to hold a readable button
   * beside the cover, the actions drop to a row under the progress bar —
   * still two compact buttons, never the full-width slabs they replaced.
   */
  /*
   * The card's bottom sits on the cover's, always. That alignment is what
   * makes the two read as one object, so it is the thing that does not bend:
   * everything else gives way to it.
   */
  const cardLeft = centreX - CARD_OVERLAP;
  const cardWidth = Math.min(
    Math.round(windowWidth * CARD_WIDTH_FRACTION),
    heroWidth - cardLeft,
  );
  const cardTop = Math.max(0, coverHeight - cardHeight);
  const heroHeight = Math.max(coverHeight, cardTop + cardHeight);

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

  /** Whose notes the margins are narrowed to, or null for the whole book. */
  const [whose, setWhose] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [openCharacter, setOpenCharacter] = useState<Character | null>(null);
  const [showCard, setShowCard] = useState(false);

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
  const backupEnabled = useBackup((s) => s.enabled);
  const backupPending = useBackup((s) => s.pending);

  useEffect(() => {
    if (id) void loadNotes(id);
  }, [id, loadNotes]);

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
  const openPlayer = (id: string) => router.push(`/player/${id}`);

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
  const playable = book.files.length > 0 && book.durationSec > 0;

  /*
   * What the compact card says under its stamps. The state first, because
   * that is the question the card is being glanced at to answer, then how to
   * see the rest — a card with three of eleven stamps has to say so.
   *
   * Every one of these is short enough to render whole. At 11px mono in a
   * 181px card there is room for about 23 characters, and the longest here
   * ("NEVER OUT · FULL CARD") is 21. The first version ellipsised to "tap
   * for…", which is a hint that stops before it says anything.
   */
  const cardStatus = `${
    copying
      ? 'COPYING'
      : out
        ? 'ON PHONE'
        : onHold
          ? 'ON HOLD'
          : book.checkouts.length === 0
            ? 'NEVER OUT'
            : 'ON SHELF'
  } · FULL CARD`;

  const backupLine = libraryOnDevice
    ? 'Saved on phone'
    : !backupEnabled
      ? 'Saved on phone · drive backup off'
      : backupPending
        ? 'Saved on phone · drive backup pending'
        : 'Saved on phone and on the drive';

  /** Only this book's margins; the store holds one book at a time. */
  const mine = notesBookId === book.id ? notes : [];
  const editingNote: Note | null = editing
    ? (mine.find((n) => n.id === editing) ?? null)
    : null;

  /*
   * Someone new.
   *
   * The row is written straight away with a placeholder name, so the card
   * that opens is editing a real character rather than holding a draft that
   * might never be saved. They are selected in the strip at the same time,
   * which is what makes the empty "No notes about them yet" state the thing
   * you land on — the honest answer for someone just invented.
   */
  const addBlankCharacter = async () => {
    const made = await addCharacter(book.id, 'New character');
    if (!made) return;
    setWhose(made.id);
    setOpenCharacter(made);
  };

  /** Opens the player and lands on a second — a note's time chip. */
  const playFrom = (sec: number) => {
    router.push(`/player/${book.id}`);
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
      includeCharacters: isPro(),
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
  /** Where you are, said the way you would say it out loud. */
  const placeLine = started
    ? `Chapter ${here.index + 1} · ${hoursLeft(Math.max(0, book.durationSec - position))} left`
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
          : libraryOnDevice
            ? {
                // The library is already on the phone, so there is nothing to
                // copy and nothing to wait for — just play it.
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
                  label: driveConnected ? 'In the queue' : 'Waiting for the drive',
                  sentence: driveConnected ? 'In the queue' : 'Waiting for the drive',
                  context: driveConnected
                    ? 'It will copy when the one ahead finishes'
                    : 'It will copy as soon as the drive is connected',
                  onPress: undefined,
                }
              : {
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
        label: `Return to shelves · frees ${bytes(book.sizeBytes)}`,
        kind: 'return',
        onPress: () => returnBook(book.id),
      }
    : onHold
      ? {
          label: driveConnected ? 'Leave the queue' : 'Cancel the hold',
          kind: 'cancel',
          onPress: () => cancelHold(book.id),
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
          onPress={() => router.back()}
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
            back to the library
          </Text>
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        // The screen used to end in a fixed action block that owned the
        // bottom inset. Nothing is pinned down there now, so the scroll has
        // to clear the gesture bar itself.
        contentContainerStyle={{ paddingBottom: Math.max(36, insets.bottom + 28) }}
        showsVerticalScrollIndicator={false}
      >
        {/*
          The cover and the card as one object: the cover left on the page's
          own margin, the card laid across its lower corner at a slight angle,
          the way one is actually pasted in. The card is the pressable — the
          cover here is artwork, not a control.
        */}
        <View style={{ paddingTop: 18, paddingHorizontal: space.xxl }}>
          <View style={{ height: heroHeight }}>
            <BookCover
              book={book}
              size="book"
              showTag={false}
              showRibbon={false}
              lean={-1.5}
              edgeWidth={EDGE_WIDTH}
              scale={coverScale}
            />

            <Pressable
              onPress={() => setShowCard(true)}
              accessibilityRole="button"
              accessibilityLabel="Library card — show full history"
              style={({ pressed }) => ({
                position: 'absolute',
                left: cardLeft,
                top: cardTop,
                width: cardWidth,
                minHeight: TOUCH,
                transform: [{ rotate: '2.5deg' }],
                opacity: pressed ? 0.88 : 1,
              })}
            >
              <View
                onLayout={(e) => {
                  const measured = Math.round(e.nativeEvent.layout.height);
                  // Only when it actually differs: this feeds the height the
                  // composition reserves, and a loop here would be a layout
                  // that never settles.
                  setCardHeight((current) => (current === measured ? current : measured));
                }}
                style={[
                  {
                    backgroundColor: color.paperCard,
                    borderRadius: 2,
                    paddingTop: 10,
                    paddingHorizontal: 14,
                    overflow: 'hidden',
                  },
                  shadow(8, 0.45),
                ]}
              >
                <LibraryCard bare compact checkouts={book.checkouts} statusLine={cardStatus} />
              </View>
            </Pressable>
          </View>
        </View>

        <View style={{ paddingTop: 26, paddingHorizontal: space.xxl, gap: space.sm }}>
          <Text
            accessibilityRole="header"
            style={{
              fontFamily: font.serif,
              fontSize: 26,
              lineHeight: 26 * 1.08,
              color: color.paper,
            }}
          >
            {book.title}
          </Text>
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            {book.author} · {hoursMinutes(book.durationSec)} · {bytes(book.sizeBytes)}
          </Text>
          {book.narrator ? (
            <Text style={{ fontFamily: font.sans, fontSize: 13, color: color.muted }}>
              read by {book.narrator}
            </Text>
          ) : null}
        </View>

        <View style={{ paddingTop: space.lg, paddingHorizontal: space.xxl, gap: space.sm }}>
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
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
            {progressLabel}
          </Text>

          {/*
            Under the progress, because that is what it acts on, and in one
            arrangement on every screen size. There is no second layout to
            get wrong.
          */}
          <View style={{ paddingTop: space.lg }}>
            <TransportRow
              primary={primary}
              secondary={secondary}
              playing={playingThis}
              finished={finished}
            />
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
                <Text
                  style={{
                    fontFamily: font.mono,
                    fontSize: 11,
                    color: color.accent,
                  }}
                >
                  {folderLabel(twin)}
                  {isCheckedOut(twin) ? ' · on your phone' : ''}
                </Text>
              </Pressable>
            ))}
          </NoteCard>
        ) : null}

        <View style={{ marginTop: space.xxl }}>
          <View style={{ paddingHorizontal: space.xxl }}>
            {/* The tally belongs to the section, not to the All medallion. */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingBottom: space.sm,
              }}
            >
              <Text
                style={{
                  fontFamily: font.mono,
                  fontSize: 11,
                  letterSpacing: 1,
                  color: color.faint,
                }}
              >
                MARGINS
              </Text>
              {mine.length > 0 ? (
                <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
                  {mine.length} {mine.length === 1 ? 'note' : 'notes'}
                </Text>
              ) : null}
            </View>

            {/*
              Undo lives on the card rather than in a slip: the slip has no
              button, and a deletion is the one thing worth offering back
              for longer than a message stays on screen.
            */}
            {undoable ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingVertical: space.sm,
                  borderBottomWidth: 1,
                  borderBottomColor: color.line,
                }}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
                  Note deleted
                </Text>
                <Pressable
                  onPress={() => void undoDelete()}
                  accessibilityRole="button"
                  hitSlop={10}
                >
                  <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                    Undo
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <MarginsCard
              book={book}
              notes={mine}
              characters={isPro() ? characters : []}
              selected={whose}
              onSelect={setWhose}
              onPlayFrom={playFrom}
              onOpenNote={(note) => setEditing(note.id)}
              onOpenCharacter={setOpenCharacter}
              onAddCharacter={isPro() ? () => void addBlankCharacter() : undefined}
            />
          </View>

          {/*
            Where this book's writing is. Said plainly rather than with an
            icon: "pending" here means the phone has it and the drive does
            not yet, which is a fact worth being able to read.
          */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginHorizontal: space.xxl,
              marginTop: space.lg,
            }}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
              {backupLine}
            </Text>
            <Pressable
              onPress={() => void shareNotes()}
              accessibilityRole="button"
              hitSlop={10}
              style={({ pressed }) => ({
                minHeight: TOUCH,
                justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                share notes
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      <NoteSheet
        key={editing ?? 'none'}
        visible={editingNote !== null}
        note={editingNote}
        characters={characters}
        canTag={isPro()}
        justSaved={false}
        onChangeText={(text) => {
          if (editingNote) setNoteText(editingNote.id, text);
        }}
        onAddCharacter={(name, bio) => addCharacter(book.id, name, bio)}
        onUndo={() => setEditing(null)}
        onDelete={(note) => void deleteNote(note.id)}
        onClose={() => {
          setEditing(null);
          void flushNotes();
        }}
      />

      <LibraryCardSheet
        visible={showCard}
        checkouts={book.checkouts}
        title={book.title}
        onClose={() => setShowCard(false)}
      />

      <CharacterSheet
        key={openCharacter?.id ?? 'none'}
        character={openCharacter}
        notes={mine}
        onSave={(fields) => {
          if (openCharacter) void updateCharacter(openCharacter.id, fields);
        }}
        onDelete={() => {
          if (openCharacter) {
            void deleteCharacter(openCharacter.id);
            if (whose === openCharacter.id) setWhose(null);
          }
          setOpenCharacter(null);
        }}
        onPlayFrom={(sec) => {
          setOpenCharacter(null);
          playFrom(sec);
        }}
        onAddToBio={(text) => {
          if (openCharacter) void addToBio(openCharacter.id, text);
        }}
        onClose={() => setOpenCharacter(null)}
      />
    </View>
  );
}
