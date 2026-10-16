/**
 * Player. Chapter-level scrubbing above, whole-book context below, and the four
 * controls that matter on a long book: contents, speed and the sleep lamp.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chapterAt, fractionAt, isCheckedOut } from '@/data/types';
import { selectBook, useLibrary } from '@/store/library';
import { useNotes } from '@/store/notes';
import { isPro } from '@/lib/pro';
import { SLEEP_OPTIONS, SPEEDS, realSecondsLeft, usePlayer } from '@/store/player';
import { clock, finishTime, hoursLeft } from '@/lib/format';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import { BookObject, cardStatusFor } from '@/components/BookObject';
import { ChapterScrubber } from '@/components/ChapterScrubber';
import { ContentsSheet } from '@/components/ContentsSheet';
import { NoteSheet } from '@/components/NoteSheet';
import { SoundPanel } from '@/components/SoundPanel';
import { useSound } from '@/store/sound';
import { LampGlow } from '@/components/LampGlow';
import {
  ChevronDown,
  Forward30,
  PauseIcon,
  PlayIcon,
  Replay30,
  SkipNextIcon,
  SkipPreviousIcon,
} from '@/components/icons';

export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [contentsOpen, setContentsOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  /** The note the sheet is editing, and whether the pencil has just made it. */
  const [editing, setEditing] = useState<{ noteId: string; justSaved: boolean } | null>(null);

  /*
   * Everything below the object — the book and chapter block, the scrubber,
   * the transport row, the whole-book line and the tray. `BookObject` fits
   * the cover into what is left, though in practice width is what limits it
   * on every phone size checked.
   *
   * The screen does not scroll, so this is also what keeps the tray on it.
   * Measured against the new column: the play disc lost 16px and the tray
   * became a line of words rather than five icon-and-label slabs, but the
   * book title line and the transport row's padding took it back.
   */
  const CHROME_HEIGHT = 460;

  const book = useLibrary(selectBook(id));

  const open = usePlayer((s) => s.open);
  const positionSec = usePlayer((s) => s.positionSec);
  const playing = usePlayer((s) => s.playing);
  const speedIndex = usePlayer((s) => s.speedIndex);
  const sleepIndex = usePlayer((s) => s.sleepIndex);
  const sleepRemainingSec = usePlayer((s) => s.sleepRemainingSec);
  const activeBookId = usePlayer((s) => s.bookId);
  const buffering = usePlayer((s) => s.buffering);
  const playbackError = usePlayer((s) => s.error);

  const togglePlay = usePlayer((s) => s.togglePlay);
  const nudge = usePlayer((s) => s.nudge);
  const seekTo = usePlayer((s) => s.seekTo);
  const cycleSpeed = usePlayer((s) => s.cycleSpeed);
  const cycleSleep = usePlayer((s) => s.cycleSleep);
  const skipChapter = usePlayer((s) => s.skipChapter);
  const reload = usePlayer((s) => s.reload);

  const notes = useNotes((s) => s.notes);
  const notesBookId = useNotes((s) => s.bookId);
  const characters = useNotes((s) => s.characters);
  const loadNotes = useNotes((s) => s.load);
  const addBookmark = useNotes((s) => s.addBookmark);
  const setNoteText = useNotes((s) => s.setNoteText);
  const flushNotes = useNotes((s) => s.flush);
  const deleteNote = useNotes((s) => s.deleteNote);
  const addCharacter = useNotes((s) => s.addCharacter);

  const soundSettings = useSound((s) => s.effective);
  const soundCaps = useSound((s) => s.capabilities);
  const soundPossible = useSound((s) => s.possible);
  const soundOwn = useSound((s) => s.own !== null);
  const soundSaveError = useSound((s) => s.saveError);
  const setPreset = useSound((s) => s.setPreset);
  const setSlider = useSound((s) => s.setSlider);
  const resetSoundToDefault = useSound((s) => s.useDefaultForBook);
  const makeSoundDefault = useSound((s) => s.makeDefault);

  useEffect(() => {
    if (id) void open(id);
  }, [id, open]);

  useEffect(() => {
    if (id) void loadNotes(id);
  }, [id, loadNotes]);


  // Deliberately no teardown here. Playback belongs to the app, not to this
  // screen: leaving it should not stop the audio, and coming back should not
  // reload and re-buffer a book that is already playing. The engine is
  // released when another book is opened, or when the app goes away.

  if (!book) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: color.ground,
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.md,
        }}
      >
        <Text style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}>
          Nothing to play.
        </Text>
        <Pressable onPress={() => router.replace('/')} accessibilityRole="button">
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
            back to the library
          </Text>
        </Pressable>
      </View>
    );
  }

  // Until `open` lands, the position still belongs to whatever played last.
  const position = activeBookId === book.id ? positionSec : book.progressSec;
  const { chapter, index, lengthSec } = chapterAt(book, position);
  const inChapter = Math.max(0, position - chapter.startSec);

  /*
   * The notes in this chapter, as seconds from its start — the scrubber knows
   * nothing about the book, only the chapter it is showing.
   */
  const mine = notesBookId === book.id ? notes : [];
  const chapterEnd = chapter.startSec + lengthSec;
  const marks = mine
    .filter((n) => n.positionSec >= chapter.startSec && n.positionSec < chapterEnd)
    .map((n) => n.positionSec - chapter.startSec);

  const editingNote = editing ? (mine.find((n) => n.id === editing.noteId) ?? null) : null;

  /*
   * The pencil saves first and asks later. The bookmark exists before the
   * sheet opens, so a tap while walking has already done its job whatever
   * happens next — including the sheet being swiped away unread.
   */
  const writeNote = async () => {
    const made = await addBookmark(book.id, position, book.chapters);
    if (made) setEditing({ noteId: made.id, justSaved: true });
  };

  const closeSheet = () => {
    setEditing(null);
    // Everything half-typed goes to the database now, not after a pause: this
    // is one of the two moments the autosave exists to survive.
    void flushNotes();
  };

  const speed = SPEEDS[speedIndex];
  const sleep = SLEEP_OPTIONS[sleepIndex];
  const sleepOn = sleep.kind !== 'off';
  const sleepLabel =
    sleep.kind === 'timer' && sleepRemainingSec !== null
      ? `off in ${clock(sleepRemainingSec)}`
      : sleep.label;

  const bookFraction = fractionAt(book, position);
  const secondsLeft = realSecondsLeft(book.durationSec, position, speed);
  const bookLabel = `whole book ${Math.floor(bookFraction * 100)}% · ${hoursLeft(secondsLeft)} left at ${speed}× · done ${finishTime(secondsLeft)}`;

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <LampGlow size={Math.min(300, windowHeight * 0.33)} top={insets.top + 30} />

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
          <ChevronDown />
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            the library
          </Text>
        </Pressable>
      </View>

      {/* The same object the Book screen opens with, at the player's size. */}
      <View style={{ paddingTop: 14 }}>
        <BookObject
          book={book}
          size="player"
          chrome={insets.top + insets.bottom + CHROME_HEIGHT}
          status={cardStatusFor(book, isCheckedOut(book), book.local.status === 'copying', book.local.status === 'on-hold')}
        />
      </View>

      <View style={{ paddingTop: 22, paddingHorizontal: space.xxl, gap: space.xs }}>
        {/*
          Which book this is, said once and quietly. The chapter is the
          heading here — it is what changes while you listen — but a chapter
          title alone leaves nothing saying what you are in.
        */}
        <Text numberOfLines={1} style={{ fontFamily: font.sans, fontSize: 13, color: color.muted }}>
          {book.title}
        </Text>
        {chapter.part ? (
          <Text
            style={{
              fontFamily: font.mono,
              fontSize: 11,
              letterSpacing: 1.1,
              color: color.muted,
            }}
          >
            {chapter.part}
          </Text>
        ) : null}
        <Text
          accessibilityRole="header"
          style={{
            fontFamily: font.serif,
            fontSize: 26,
            lineHeight: 26 * 1.1,
            color: color.paper,
          }}
        >
          {chapter.title}
        </Text>
      </View>

      <View style={{ paddingTop: 22, paddingHorizontal: space.xxl, gap: 8 }}>
        <ChapterScrubber
          positionSec={inChapter}
          lengthSec={lengthSec}
          marks={marks}
          onSeek={(value) => seekTo(chapter.startSec + value)}
        />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            {clock(inChapter)}
          </Text>
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            -{clock(lengthSec - inChapter)}
          </Text>
        </View>
      </View>

      {/*
        One loud thing, on the left. The skips are ghosts beside it and the
        chapter jumps are the quietest controls on the screen, at the far
        end: they move you furthest, and are the ones you least often want.
      */}
      <View
        style={{
          paddingTop: 20,
          paddingHorizontal: space.xxl,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
        }}
      >
        <Pressable
          onPress={togglePlay}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          style={({ pressed }) => [
            {
              width: 68,
              height: 68,
              borderRadius: 34,
              backgroundColor: color.accent,
              alignItems: 'center',
              justifyContent: 'center',
              transform: [{ scale: pressed ? 0.96 : 1 }],
            },
            shadow(12, 0.3),
          ]}
        >
          {buffering ? (
            <ActivityIndicator size="small" color={color.ground} />
          ) : playing ? (
            <PauseIcon />
          ) : (
            <PlayIcon />
          )}
        </Pressable>

        <GhostDisc
          size={48}
          onPress={() => nudge(-30)}
          accessibilityLabel="Back 30 seconds"
          numeral="30"
        >
          <Replay30 />
        </GhostDisc>

        <GhostDisc
          size={48}
          onPress={() => nudge(30)}
          accessibilityLabel="Forward 30 seconds"
          numeral="30"
        >
          <Forward30 />
        </GhostDisc>

        <View style={{ flex: 1 }} />

        <GhostDisc size={36} onPress={() => skipChapter(-1)} accessibilityLabel="Previous chapter">
          <SkipPreviousIcon size={18} stroke={color.muted} />
        </GhostDisc>
        <GhostDisc size={36} onPress={() => skipChapter(1)} accessibilityLabel="Next chapter">
          <SkipNextIcon size={18} stroke={color.muted} />
        </GhostDisc>
      </View>

      {playbackError ? (
        <View
          style={{
            marginTop: space.lg,
            marginHorizontal: space.xxl,
            borderWidth: 1,
            borderColor: color.warningInk,
            borderRadius: radius.button,
            padding: space.md,
            gap: space.xs,
          }}
        >
          <Text
            style={{
              fontFamily: font.monoMedium,
              fontSize: 10,
              letterSpacing: 0.9,
              color: color.warning,
            }}
          >
            CAN&apos;T PLAY
          </Text>
          <Text
            style={{
              fontFamily: font.sans,
              fontSize: 13,
              lineHeight: 13 * 1.4,
              color: '#cbbb9e',
            }}
          >
            {playbackError}
          </Text>
          {/*
            A load can fail for reasons that have gone by the time the message
            is read — the drive was busy, the playback service had not bound
            yet. Offering the retry here saves leaving the screen and coming
            back, which was the only way out of it.
          */}
          <Pressable
            onPress={() => void reload(true)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              alignSelf: 'flex-start',
              minHeight: TOUCH,
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
              try again
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View style={{ paddingTop: 22, paddingHorizontal: space.xxl, gap: space.sm }}>
        <View
          style={{
            height: 3,
            borderRadius: 2,
            backgroundColor: color.trough,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${bookFraction * 100}%`,
              height: '100%',
              backgroundColor: color.bookLine,
            }}
          />
        </View>
        <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
          {bookLabel}
        </Text>
      </View>

      <View style={{ flex: 1 }} />

      {/*
        The tray, as a line of words. It was five icon-and-label slabs on a
        ruled-off strip, which made the quietest things on the screen look
        like the most structural. Same handlers, same states, no furniture.
      */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          paddingHorizontal: space.xxl,
          paddingTop: space.md,
          paddingBottom: Math.max(22, insets.bottom + 6),
          gap: space.lg,
        }}
      >
        <TrayAction
          label="note"
          onPress={() => void writeNote()}
          accessibilityLabel="Save a bookmark here and write a note"
        />
        <TrayAction
          label="sound"
          onPress={() => setSoundOpen(true)}
          accessibilityLabel="Sound: presets and tone controls"
          active={soundSettings.preset !== 'off'}
        />
        <TrayAction
          label="contents"
          onPress={() => setContentsOpen(true)}
          accessibilityLabel={`Contents, chapter ${index + 1} of ${book.chapters.length}`}
        />
        <TrayAction
          label={`${speed}×`}
          onPress={cycleSpeed}
          accessibilityLabel={`Playback speed ${speed} times. Tap to change.`}
          bright
        />
        <TrayAction
          label={sleepLabel}
          onPress={cycleSleep}
          accessibilityLabel={`Sleep timer: ${sleepLabel}. Tap to change.`}
          active={sleepOn}
        />
      </View>

      <NoteSheet
        /*
         * Keyed on the note so each one opens fresh — no confirmation line or
         * half-finished character form carried over from the last.
         */
        key={editing?.noteId ?? 'none'}
        visible={editingNote !== null}
        note={editingNote}
        characters={characters}
        canTag={isPro()}
        justSaved={editing?.justSaved ?? false}
        onChangeText={(text) => {
          if (editingNote) setNoteText(editingNote.id, text);
        }}
        onAddCharacter={(name, bio) => addCharacter(book.id, name, bio)}
        onUndo={() => {
          if (editingNote) void deleteNote(editingNote.id);
          setEditing(null);
        }}
        onDelete={(note) => void deleteNote(note.id)}
        onClose={closeSheet}
      />

      <SoundPanel
        visible={soundOpen}
        settings={soundSettings}
        capabilities={soundCaps}
        possible={soundPossible}
        hasOwn={soundOwn}
        saveError={soundSaveError}
        onPreset={(preset) => void setPreset(preset)}
        onSlider={(which, value) => void setSlider(which, value)}
        onUseDefault={() => void resetSoundToDefault()}
        onMakeDefault={() => void makeSoundDefault()}
        onClose={() => setSoundOpen(false)}
      />

      <ContentsSheet
        visible={contentsOpen}
        book={book}
        currentIndex={index}
        onSelect={(chapterIndex) => {
          seekTo(book.chapters[chapterIndex].startSec);
          setContentsOpen(false);
        }}
        onClose={() => setContentsOpen(false)}
      />
    </View>
  );
}

/**
 * A skip or a chapter jump: the icon, an outline, and nothing else.
 *
 * Ghosts beside the play disc — same shape, none of the colour, so the one
 * amber thing on the screen stays the one amber thing.
 */
function GhostDisc({
  size,
  onPress,
  accessibilityLabel,
  numeral,
  children,
}: {
  size: number;
  onPress: () => void;
  accessibilityLabel: string;
  /** The number written across a 30-second skip. */
  numeral?: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      // The disc is drawn small; the touch target is not.
      hitSlop={Math.max(0, Math.round((TOUCH - size) / 2))}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: color.line,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {children}
      {numeral ? (
        <Text
          style={{
            position: 'absolute',
            fontFamily: font.mono,
            fontSize: 10,
            color: color.paper,
          }}
        >
          {numeral}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** One word in the tray. Amber only when the thing it names is running. */
function TrayAction({
  label,
  onPress,
  accessibilityLabel,
  active = false,
  bright = false,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  /** A sound preset or a sleep timer actually doing something. */
  active?: boolean;
  /** The speed, which is always a value rather than a state. */
  bright?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={10}
      style={({ pressed }) => ({
        minHeight: TOUCH,
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{
          fontFamily: active || bright ? font.monoMedium : font.mono,
          fontSize: 12,
          color: active ? color.accent : bright ? color.paper : color.muted,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
