/**
 * Book — the library card view. Everything known about one book, its stamped
 * checkout history, and the two moves available: keep listening, or return it.
 */

import { Pressable, ScrollView, Share, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useMemo, useState } from 'react';
import { fractionAt, isCheckedOut } from '@/data/types';
import { selectBook, useLibrary } from '@/store/library';
import { usePlayer } from '@/store/player';
import { duplicatesOf, folderLabel } from '@/lib/library/duplicates';
import { bytes, hoursMinutes, hoursLeft, stampDate } from '@/lib/format';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import { BookCover } from '@/components/BookCover';
import { COMPACT_CARD_ESTIMATE, LibraryCard, LibraryCardSheet } from '@/components/LibraryCard';
import { StatusTag } from '@/components/CoverBadges';
import { NoteCard, NoteText } from '@/components/NoteCard';
import { ChevronLeft, PlayIcon } from '@/components/icons';
import { CardStack, type BookTab, type StackTab } from '@/components/CardStack';
import { NotesCard } from '@/components/NotesCard';
import { CharacterSheet, CharactersCard } from '@/components/CharactersCard';
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
/** The two compact actions stacked in the top-right, and the air below them. */
const ACTION_HEIGHT = 46;
const ACTION_GAP = 10;
const ACTION_STACK = ACTION_HEIGHT * 2 + ACTION_GAP;
const CARD_CLEARANCE = 12;
/** Under this, the right column cannot hold a button label worth reading. */
const MIN_ACTION_COLUMN = 130;
/**
 * What sits below the hero: the title block, the progress block and its
 * footnote, and enough of the card stack to show it is there.
 *
 * Down from 430, and from 560 before that. The full-width action slabs are
 * gone from the bottom of the screen — the actions are in the hero now — so
 * the cover is no longer charged for them.
 */
const HERO_CHROME = 300;

type Action = {
  /** The whole sentence, for a screen reader. */
  label: string;
  /** What fits in a button half the screen wide. */
  short: string;
  onPress?: () => void;
  tone: 'accent' | 'muted';
  /** Whether pressing this starts audio, and so earns the play glyph. */
  plays?: boolean;
};

type Secondary = { label: string; short: string; onPress: () => void };

/** The amber action. Compact: one line, and the glyph only when it plays. */
function PrimaryButton({ action }: { action: Action }) {
  const accent = action.tone === 'accent';
  return (
    <Pressable
      onPress={action.onPress}
      disabled={!action.onPress}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: !action.onPress }}
      style={({ pressed }) => [
        {
          flex: 1,
          minHeight: ACTION_HEIGHT,
          borderRadius: radius.button,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingHorizontal: space.sm,
          backgroundColor: accent ? color.accent : color.panel,
          borderWidth: accent ? 0 : 1,
          borderColor: color.border,
          opacity: pressed ? 0.85 : 1,
        },
        accent ? shadow(8, 0.3) : null,
      ]}
    >
      {action.plays && action.onPress ? <PlayIcon size={13} fill={color.ground} /> : null}
      <Text
        numberOfLines={1}
        style={{
          fontFamily: font.serif,
          fontSize: 15,
          color: accent ? color.ground : color.muted,
        }}
      >
        {action.short}
      </Text>
    </Pressable>
  );
}

/** The outline action. Deliberately not a slab: returning is not an accident. */
function SecondaryButton({ action, finished }: { action: Secondary; finished: boolean }) {
  return (
    <Pressable
      onPress={action.onPress}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: ACTION_HEIGHT,
        borderRadius: radius.button,
        borderWidth: 1,
        borderColor: finished ? color.accent : color.border,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.sm,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{ fontFamily: font.mono, fontSize: 12, color: finished ? color.accent : color.paper }}
      >
        {action.short}
      </Text>
    </Pressable>
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
  const actionLeft = centreX + 4;
  const actionWidth = heroWidth - actionLeft;

  /*
   * The card's bottom sits on the cover's, always. That alignment is what
   * makes the two read as one object, so it is the thing that does not bend:
   * everything else gives way to it.
   */
  const cardLeft = centreX - CARD_OVERLAP;
  const cardWidth = heroWidth - cardLeft;
  const cardTop = Math.max(0, coverHeight - cardHeight);
  const heroHeight = Math.max(coverHeight, cardTop + cardHeight);

  /*
   * Which means the actions only stay in the top-right if they genuinely
   * fit above the card. Two conditions, and the second is the one that
   * bites: a narrow screen shrinks the cover by width, but the button
   * stack is a fixed 102px, so on a 360dp phone there is no room for both
   * above a card whose bottom is pinned to the cover. Forcing it anyway
   * pushed the card 25px below the book, which is the composition coming
   * apart. They drop to a row under the progress bar instead.
   */
  const actionsInHero =
    actionWidth >= MIN_ACTION_COLUMN && cardTop >= ACTION_STACK + CARD_CLEARANCE;

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

  const [tab, setTab] = useState<BookTab>('notes');
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
   */
  const cardStatus = `${
    copying
      ? 'CHECKING OUT'
      : out
        ? 'ON YOUR PHONE'
        : onHold
          ? 'ON HOLD'
          : book.checkouts.length === 0
            ? 'NEVER CHECKED OUT'
            : 'ON THE SHELF'
  } · tap for full card`;

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
   * Two faces of the same thing: your record of this book. Chapters used to
   * sit here and was dropped — the player's Contents sheet is the same list.
   * The library card left the stack when it moved into the hero, where it is
   * a thing you see rather than a tab you have to think to open.
   */
  const tabs: StackTab<BookTab>[] = [
    { key: 'notes', label: 'Notes', hint: 'What you wrote while listening' },
    ...(isPro()
      ? [{ key: 'characters' as const, label: 'Characters', hint: 'Who is in this book' }]
      : []),
  ];

  /** Opens the player and lands on a second — a note's time chip. */
  const playFrom = (sec: number) => {
    router.push(`/player/${book.id}`);
    void usePlayer.getState().openAt(book.id, sec);
  };

  const addBlankCharacter = async () => {
    const made = await addCharacter(book.id, 'New character');
    if (made) setOpenCharacter(made);
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
  const primary: Action = book.drmProtected
    ? {
        label: "Can't play — protected by DRM",
        short: "Can't play",
        onPress: undefined,
        tone: 'muted',
      }
    : !playable
      ? {
          label: 'No audio that can be read',
          short: 'No audio',
          onPress: undefined,
          tone: 'muted',
        }
    : copying
      ? {
          label: `Checking out… ${Math.round((book.local.status === 'copying' ? book.local.progress : 0) * 100)}%`,
          short: `Checking out ${Math.round((book.local.status === 'copying' ? book.local.progress : 0) * 100)}%`,
          onPress: undefined,
          tone: 'muted',
        }
      : out
        ? {
            label: finished ? 'Listen again' : started ? 'Keep listening' : 'Start listening',
            short: finished ? 'Listen again' : started ? 'Keep listening' : 'Start listening',
            onPress: () => openPlayer(book.id),
            tone: 'accent',
            plays: true,
          }
        : libraryOnDevice
          ? {
              // The library is already on the phone, so there is nothing to
              // copy and nothing to wait for — just play it.
              label: 'Play',
              short: 'Play',
              onPress: () => openPlayer(book.id),
              tone: 'accent',
              plays: true,
            }
          : onHold
            ? {
                // On hold means two different things depending on what is
                // missing: the drive, or a turn in the queue behind another
                // copy. Saying "waiting for the drive" with the drive plugged
                // in reads as a bug.
                label: driveConnected ? 'In the queue' : 'Waiting for the drive',
                short: driveConnected ? 'In the queue' : 'Waiting',
                onPress: undefined,
                tone: 'muted',
              }
            : {
                label: driveConnected
                  ? `Check out and play · ${bytes(book.sizeBytes)}`
                  : `Put on hold · ${bytes(book.sizeBytes)}`,
                short: driveConnected ? 'Check out' : 'Put on hold',
                onPress: () =>
                  driveConnected
                    ? checkOutAndPlay(book.id, openPlayer)
                    : checkOut(book.id),
                tone: 'accent',
                plays: driveConnected,
              };

  const secondary: Secondary | null = out
    ? {
        label: `Return to the shelves · frees ${bytes(book.sizeBytes)}`,
        short: 'Return to shelves',
        onPress: () => returnBook(book.id),
      }
    : onHold
      ? {
          label: driveConnected ? 'Leave the queue' : 'Cancel the hold',
          short: driveConnected ? 'Leave the queue' : 'Cancel the hold',
          onPress: () => cancelHold(book.id),
        }
      : null;

  const tag = out
    ? { label: 'CHECKED OUT', variant: 'solid' as const }
    : onHold
      ? { label: 'ON HOLD', variant: 'outline' as const }
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
        {tag ? (
          <View style={{ marginRight: space.md }}>
            <StatusTag label={tag.label} variant={tag.variant} />
          </View>
        ) : null}
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

            {actionsInHero ? (
              <View
                style={{
                  position: 'absolute',
                  left: actionLeft,
                  top: 0,
                  width: actionWidth,
                  gap: ACTION_GAP,
                }}
              >
                <PrimaryButton action={primary} />
                {secondary ? <SecondaryButton action={secondary} finished={finished} /> : null}
              </View>
            ) : null}

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
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
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
            No offer to return, deliberately. Finishing a book used to promise
            one here and never make it; the decision taken was that returning
            is the listener's call and their timing, and that the tray marking
            a book DONE is the whole of what the app should say about it.
          */}
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
            {finished && out
              ? 'all done — return it whenever you like'
              : out
                ? 'your place is kept, however long it sits here'
                : driveConnected
                  ? 'checking out copies it to your phone'
                  : 'holds check out as soon as the drive is connected'}
          </Text>

          {/*
            Too narrow for a button beside the cover, so they come down here —
            still the same two compact buttons, side by side.
          */}
          {actionsInHero ? null : (
            <View style={{ flexDirection: 'row', gap: ACTION_GAP, paddingTop: space.sm }}>
              <PrimaryButton action={primary} />
              {secondary ? <SecondaryButton action={secondary} finished={finished} /> : null}
            </View>
          )}
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
          <CardStack tabs={tabs} active={tab} onChange={setTab}>
            {tab === 'notes' ? (
              <>
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
                      borderBottomColor: color.paperRule,
                    }}
                  >
                    <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.stampFaded }}>
                      Note deleted
                    </Text>
                    <Pressable
                      onPress={() => void undoDelete()}
                      accessibilityRole="button"
                      hitSlop={10}
                    >
                      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.stampBack }}>
                        Undo
                      </Text>
                    </Pressable>
                  </View>
                ) : null}

                <NotesCard
                  book={book}
                  notes={mine}
                  characters={characters}
                  onPlayFrom={playFrom}
                  onEdit={(note) => setEditing(note.id)}
                  onDelete={(note) => void deleteNote(note.id)}
                />
              </>
            ) : null}

            {tab === 'characters' ? (
              <CharactersCard
                characters={characters}
                notes={mine}
                onOpen={setOpenCharacter}
                onAdd={() => void addBlankCharacter()}
              />
            ) : null}
          </CardStack>

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
          if (openCharacter) void deleteCharacter(openCharacter.id);
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
