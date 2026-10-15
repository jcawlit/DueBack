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
import { ChevronLeft } from '@/components/icons';
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
/** The cover is scaled down to leave the card somewhere to sit. */
const HERO_COVER_SCALE = 0.88;
/** How far the card is sunk over the cover, and how far past its right edge. */
const CARD_SINK = 40;
const CARD_OVERHANG = 24;
/**
 * The page edge drawn beside the cover, passed to `BookCover` as `edgeWidth`.
 *
 * It is a sibling of the cover in a row, not part of it, so the book's right
 * edge — the thing the card is positioned against — is the cover plus this.
 * Fixed rather than scaled: `PageEdge` takes the number as given.
 */
const EDGE_WIDTH = 13;
/**
 * Title, meta, progress and the two actions: what the cover cannot have.
 *
 * Down from 560, which was the figure when the library card sat in the stack
 * below. It does not any more — it is part of the hero, and `cardDrop` now
 * accounts for it. Leaving 560 in place charged the cover for the card twice
 * and shrank it to 0.71 on a Pixel, well under the 0.88 it is meant to be.
 */
const HERO_CHROME = 430;

export default function BookScreen() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();

  /*
   * The hero is a cover with the library card laid over its lower corner.
   *
   * Two things changed the old sum. The cover is deliberately smaller — the
   * card beside it is the other half of the composition, and a full-size
   * cover leaves it nowhere to sit — and the card hangs below the cover by
   * its own height less the overlap, which is vertical space the cover can
   * no longer have. So the fit is measured against what is left after that
   * drop, and then capped at HERO_COVER_SCALE rather than at 1.
   *
   * The floor stays at 0.6: below that the title on the artwork stops being
   * legible, and a short screen is better served by scrolling.
   */
  const [cardHeight, setCardHeight] = useState(COMPACT_CARD_ESTIMATE);
  const cardDrop = Math.max(0, cardHeight - CARD_SINK);
  const coverScale = Math.max(
    0.6,
    Math.min(
      HERO_COVER_SCALE,
      (windowHeight - insets.top - insets.bottom - HERO_CHROME - cardDrop) / COVER_BOOK_HEIGHT,
    ),
  );
  const coverWidth = COVER_BOOK_WIDTH * coverScale;
  const coverHeight = COVER_BOOK_HEIGHT * coverScale;

  /*
   * The card is as wide as a card, not as wide as the cover: it reaches past
   * the cover's right edge and bleeds left over the artwork, which is what
   * makes it read as laid on top rather than tucked beside. Clamped so it
   * can never run off either side of the screen.
   */
  const heroWidth = windowWidth - space.xxl * 2;
  const cardWidth = Math.round(
    Math.min(windowWidth * 0.52, Math.max(windowWidth * 0.48, 150)),
  );
  const bookWidth = coverWidth + EDGE_WIDTH;
  const cardRight = Math.min(bookWidth + CARD_OVERHANG, heroWidth);
  const cardLeft = Math.max(cardRight - cardWidth, -(space.xxl - 4));

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

  const primary = book.drmProtected
    ? {
        label: "Can't play — protected by DRM",
        onPress: undefined,
        tone: 'muted' as const,
      }
    : !playable
      ? {
          label: 'No audio that can be read',
          onPress: undefined,
          tone: 'muted' as const,
        }
    : copying
      ? {
          label: `Checking out… ${Math.round((book.local.status === 'copying' ? book.local.progress : 0) * 100)}%`,
          onPress: undefined,
          tone: 'muted' as const,
        }
      : out
        ? {
            label: finished ? 'Listen again' : started ? 'Keep listening' : 'Start listening',
            onPress: () => openPlayer(book.id),
            tone: 'accent' as const,
          }
        : libraryOnDevice
          ? {
              // The library is already on the phone, so there is nothing to
              // copy and nothing to wait for — just play it.
              label: 'Play',
              onPress: () => openPlayer(book.id),
              tone: 'accent' as const,
            }
          : onHold
            ? {
                // On hold means two different things depending on what is
                // missing: the drive, or a turn in the queue behind another
                // copy. Saying "waiting for the drive" with the drive plugged
                // in reads as a bug.
                label: driveConnected ? 'In the queue' : 'Waiting for the drive',
                onPress: undefined,
                tone: 'muted' as const,
              }
            : {
                label: driveConnected
                  ? `Check out and play · ${bytes(book.sizeBytes)}`
                  : `Put on hold · ${bytes(book.sizeBytes)}`,
                onPress: () =>
                  driveConnected
                    ? checkOutAndPlay(book.id, openPlayer)
                    : checkOut(book.id),
                tone: 'accent' as const,
              };

  const secondary = out
    ? {
        label: `Return to the shelves · frees ${bytes(book.sizeBytes)}`,
        onPress: () => returnBook(book.id),
      }
    : onHold
      ? {
          label: driveConnected ? 'Leave the queue' : 'Cancel the hold',
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
        contentContainerStyle={{ paddingBottom: 36 }}
        showsVerticalScrollIndicator={false}
      >
        {/*
          The cover and the card as one object: the cover left on the page's
          own margin, the card laid across its lower corner at a slight angle,
          the way one is actually pasted in. The card is the pressable — the
          cover here is artwork, not a control.
        */}
        <View style={{ paddingTop: 18, paddingHorizontal: space.xxl }}>
          <View style={{ height: coverHeight + cardDrop }}>
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
                top: coverHeight - CARD_SINK,
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
                    paddingTop: space.md,
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

      <View
        style={{
          paddingHorizontal: space.xxl,
          paddingBottom: Math.max(26, insets.bottom + 10),
          gap: 10,
        }}
      >
        <Pressable
          onPress={primary.onPress}
          disabled={!primary.onPress}
          accessibilityRole="button"
          accessibilityState={{ disabled: !primary.onPress }}
          style={({ pressed }) => [
            {
              minHeight: 52,
              borderRadius: radius.button,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: primary.tone === 'accent' ? color.accent : color.panel,
              borderWidth: primary.tone === 'accent' ? 0 : 1,
              borderColor: color.border,
              opacity: pressed ? 0.85 : 1,
            },
            primary.tone === 'accent' ? shadow(8, 0.3) : null,
          ]}
        >
          <Text
            style={{
              fontFamily: font.serif,
              fontSize: 18,
              color: primary.tone === 'accent' ? color.ground : color.muted,
            }}
          >
            {primary.label}
          </Text>
        </Pressable>

        {secondary ? (
          <Pressable
            onPress={secondary.onPress}
            accessibilityRole="button"
            style={({ pressed }) => ({
              minHeight: 48,
              borderRadius: radius.button,
              borderWidth: 1,
              borderColor: finished ? color.accent : color.border,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 12,
                color: finished ? color.accent : color.paper,
              }}
            >
              {secondary.label}
            </Text>
          </Pressable>
        ) : null}

        <Text
          style={{
            textAlign: 'center',
            fontFamily: font.mono,
            fontSize: 11,
            color: color.faint,
          }}
        >
          {/*
            No offer to return, deliberately. Finishing a book used to promise
            one here and never make it; the decision taken was that returning
            is the listener's call and their timing, and that the tray marking
            a book DONE is the whole of what the app should say about it.
          */}
          {finished && out
            ? 'all done — return it whenever you like'
            : out
              ? 'your place is kept, however long it sits here'
              : driveConnected
                ? 'checking out copies it to your phone'
                : 'holds check out as soon as the drive is connected'}
        </Text>
      </View>

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
