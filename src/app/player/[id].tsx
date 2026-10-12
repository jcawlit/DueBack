/**
 * Player. Chapter-level scrubbing above, whole-book context below, and the four
 * controls that matter on a long book: contents, speed and the sleep lamp.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chapterAt } from '@/data/types';
import { selectBook, useLibrary } from '@/store/library';
import { SLEEP_OPTIONS, SPEEDS, realSecondsLeft, usePlayer } from '@/store/player';
import { clock, finishTime, hoursLeft } from '@/lib/format';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import { BookCover } from '@/components/BookCover';
import { ChapterScrubber } from '@/components/ChapterScrubber';
import { ContentsSheet } from '@/components/ContentsSheet';
import { LampGlow } from '@/components/LampGlow';
import { Slip } from '@/components/Slip';
import {
  ChevronDown,
  ContentsIcon,
  Forward30,
  LampIcon,
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

  // Everything but the cover — header, chapter, scrubber, transport, book line
  // and the control row — needs about this much height. The cover takes the
  // rest, down to a floor where it is still recognisably a book.
  const CHROME_HEIGHT = 468;
  const coverScale = Math.max(
    0.58,
    Math.min(1, (windowHeight - insets.top - insets.bottom - CHROME_HEIGHT) / 282),
  );

  const book = useLibrary(selectBook(id));
  const slip = useLibrary((s) => s.slip);
  const dismissSlip = useLibrary((s) => s.dismissSlip);

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

  useEffect(() => {
    if (id) void open(id);
  }, [id, open]);

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

  const speed = SPEEDS[speedIndex];
  const sleep = SLEEP_OPTIONS[sleepIndex];
  const sleepOn = sleep.kind !== 'off';
  const sleepLabel =
    sleep.kind === 'timer' && sleepRemainingSec !== null
      ? `off in ${clock(sleepRemainingSec)}`
      : sleep.label;

  const bookFraction = Math.min(1, position / book.durationSec);
  const secondsLeft = realSecondsLeft(book.durationSec, position, speed);
  const bookLabel = `whole book ${Math.floor(bookFraction * 100)}% · ${hoursLeft(secondsLeft)} left at ${speed}× · done ${finishTime(secondsLeft)}`;

  return (
    <View style={{ flex: 1, backgroundColor: color.ground, paddingTop: insets.top }}>
      <LampGlow size={300 * coverScale} top={insets.top + 30} />

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
        <Pressable
          onPress={() => router.push(`/book/${book.id}`)}
          accessibilityRole="button"
          accessibilityLabel="Open the library card"
          style={({ pressed }) => ({
            minHeight: TOUCH,
            justifyContent: 'center',
            paddingHorizontal: 10,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            library card
          </Text>
        </Pressable>
      </View>

      <View style={{ alignItems: 'center', paddingTop: 14 }}>
        <BookCover
          book={book}
          size="player"
          showTag={false}
          showRibbon={false}
          lean={-1.5}
          edgeWidth={14}
          scale={coverScale}
        />
      </View>

      <View style={{ paddingTop: 28, paddingHorizontal: space.xxl, gap: space.xs }}>
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

      <View
        style={{
          paddingTop: 18,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
        }}
      >
        <Pressable
          onPress={() => skipChapter(-1)}
          accessibilityRole="button"
          accessibilityLabel="Previous chapter"
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <SkipPreviousIcon />
        </Pressable>

        <Pressable
          onPress={() => nudge(-30)}
          accessibilityRole="button"
          accessibilityLabel="Back 30 seconds"
          style={({ pressed }) => ({
            width: 52,
            height: 52,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Replay30 />
          <Text
            style={{
              position: 'absolute',
              top: 22,
              fontFamily: font.mono,
              fontSize: 10,
              color: color.paper,
            }}
          >
            30
          </Text>
        </Pressable>

        <Pressable
          onPress={togglePlay}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          style={({ pressed }) => [
            {
              width: 84,
              height: 84,
              borderRadius: radius.play,
              backgroundColor: color.accent,
              alignItems: 'center',
              justifyContent: 'center',
              borderBottomWidth: 4,
              borderBottomColor: 'rgba(0,0,0,0.2)',
              transform: [{ rotate: '-2deg' }, { scale: pressed ? 0.96 : 1 }],
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

        <Pressable
          onPress={() => nudge(30)}
          accessibilityRole="button"
          accessibilityLabel="Forward 30 seconds"
          style={({ pressed }) => ({
            width: 52,
            height: 52,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Forward30 />
          <Text
            style={{
              position: 'absolute',
              top: 22,
              fontFamily: font.mono,
              fontSize: 10,
              color: color.paper,
            }}
          >
            30
          </Text>
        </Pressable>

        <Pressable
          onPress={() => skipChapter(1)}
          accessibilityRole="button"
          accessibilityLabel="Next chapter"
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <SkipNextIcon />
        </Pressable>
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

      <View
        style={{
          flexDirection: 'row',
          paddingHorizontal: space.lg,
          paddingTop: 10,
          paddingBottom: Math.max(22, insets.bottom + 6),
          gap: space.sm,
          borderTopWidth: 1,
          borderTopColor: color.line,
        }}
      >
        <TrayButton
          label="contents"
          onPress={() => setContentsOpen(true)}
          accessibilityLabel={`Contents, chapter ${index + 1} of ${book.chapters.length}`}
          icon={<ContentsIcon />}
        />
        <TrayButton
          label="speed"
          onPress={cycleSpeed}
          accessibilityLabel={`Playback speed ${speed} times. Tap to change.`}
          tone="bright"
          icon={
            <Text
              style={{
                fontFamily: font.serif,
                fontSize: 17,
                lineHeight: 20,
                color: color.paper,
              }}
            >
              {speed}×
            </Text>
          }
        />
        <TrayButton
          label={sleepLabel}
          onPress={cycleSleep}
          accessibilityLabel={`Sleep timer: ${sleepLabel}. Tap to change.`}
          active={sleepOn}
          icon={<LampIcon stroke={sleepOn ? color.accent : color.muted} />}
        />
      </View>

      {slip ? <Slip slip={slip} onDismiss={dismissSlip} bottom={110} /> : null}

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

/** One of the four controls in the Player's bottom row. */
function TrayButton({
  label,
  icon,
  onPress,
  accessibilityLabel,
  active = false,
  tone = 'muted',
}: {
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  /** Amber, reserved for a running sleep timer. */
  active?: boolean;
  tone?: 'muted' | 'bright';
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 56,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {icon}
      <Text
        numberOfLines={1}
        style={{
          fontFamily: font.mono,
          fontSize: 11,
          color: active ? color.accent : tone === 'bright' ? color.paper : color.muted,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
