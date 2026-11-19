/**
 * "Checked out" — the books on the phone, pinned to the bottom of the Library.
 * This is the mockups' Bag, renamed: the covers fan out and overlap more tightly
 * as the storage budget fills, and the ruler below measures what is left.
 *
 * Books still on hold appear here too, faded, because they are part of what the
 * user is taking with them even though no bytes have moved yet.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Animated,
  Easing,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import type { Book } from '@/data/types';
import { showsGroupLabels, trayBooks, type TrayGroup } from '@/lib/library/tray';
import { color, font, shadow, space } from '@/theme/tokens';
import { GB, gigabytes } from '@/lib/format';
import { BookCover } from './BookCover';
import { ChevronDown } from './icons';
import { DashedEdge } from './DashedEdge';
import { Ruler } from './Ruler';

type Props = {
  /**
   * The books on the phone, grouped by where they came from: the drive, then
   * each server, then anything from a server not signed into.
   *
   * Grouped rather than flat because a book from a removed server used to
   * belong to no view at all and sat there holding gigabytes invisibly. With
   * one group — the common case, and every case without a server — this
   * renders exactly as the flat list did.
   */
  groups: TrayGroup[];
  usedBytes: number;
  holdBytes: number;
  budgetBytes: number;
  onPressBook: (book: Book) => void;
  onLongPressBook: (book: Book) => void;
  /** Hidden when the drive is not connected, where the tray has no ruler room. */
  showRuler?: boolean;
  /** Shut down to the header row. Remembered across launches by `useUi`. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /**
   * The library is already in phone storage, so nothing is ever checked out.
   *
   * `checkOut` refuses for such a library — a second copy of a file already on
   * the phone is the thing this app exists not to make — so the fan would
   * always be empty and the ruler would always read zero. The section says
   * where the library is and what it takes up instead.
   */
  onDevice?: boolean;
  /** Books in the library, and their total size. Only read when `onDevice`. */
  libraryCount?: number;
  libraryBytes?: number;
  /** Where they are, so the panel can name the folder rather than imply one. */
  libraryPath?: string;
};

/** Rotations reused from the mockup, so the fan looks hand-stacked. */
const LEANS = [-3, 2, -1.5, 3, -2, 1.5, -2.5, 2.5, -1, 1];

/** The fan of covers. Fixed, so the tray's height never depends on the art. */
const FAN_HEIGHT = 92;

/**
 * The ruler: an 18px trough, a 5px gap, and one line of 11px mono labels.
 *
 * A constant rather than a measurement because the collapse animates height,
 * and height cannot be driven natively — so it needs a number before the
 * first frame, not after a layout pass. Measuring instead would mean either
 * a frame of the tray at full height before it shuts, or a second hidden
 * copy of the covers to measure.
 *
 * Rounded **up** deliberately. Over by a pixel or two is slack absorbed by
 * the 18px of padding below; under by a pixel clips the bottom of the GB
 * labels, and would do it permanently.
 */
const RULER_HEIGHT = 40;

/**
 * The strip holding "Drive" and a server's name over their own covers.
 *
 * A constant for the same reason `RULER_HEIGHT` is one: the collapse animates
 * height, so the reveal needs a number before the first frame rather than
 * after a layout pass. Only counted when there is more than one group, so a
 * tray with no server is the exact height it always was.
 */
const GROUP_LABEL_HEIGHT = 13;

const COLLAPSE_MS = 220;

/** How far a drag has to travel before it counts as a deliberate shove. */
const SWIPE_SLOP = 10;

export function CheckedOutTray({
  groups,
  usedBytes,
  holdBytes,
  budgetBytes,
  onPressBook,
  onLongPressBook,
  showRuler = true,
  collapsed = false,
  onToggleCollapsed,
  onDevice = false,
  libraryCount = 0,
  libraryBytes = 0,
  libraryPath = '',
}: Props) {
  /*
   * One flat list for everything that is about the whole tray — the count,
   * how tightly the fan overlaps, the ruler, and whether there is anything in
   * it at all. Only the rendering cares where a book came from.
   */
  const books = useMemo(() => trayBooks(groups), [groups]);
  const labelled = showsGroupLabels(groups);

  // The covers plus their names. The room for a cover never changes, so the
  // fan does not get shorter when a server appears.
  const fanHeight = FAN_HEIGHT + (labelled ? GROUP_LABEL_HEIGHT + space.xs : 0);
  const revealHeight = fanHeight + (showRuler ? space.md + RULER_HEIGHT : 0);

  // `useState` rather than `useRef`, as `Slip` does: an Animated value is
  // read during render, which is exactly what a ref must not be.
  const [reveal] = useState(() => new Animated.Value(collapsed ? 0 : 1));

  useEffect(() => {
    const animation = Animated.timing(reveal, {
      toValue: collapsed ? 0 : 1,
      duration: COLLAPSE_MS,
      easing: Easing.out(Easing.cubic),
      // Height is a layout property; there is no native driver for it.
      useNativeDriver: false,
    });
    animation.start();
    // Stopped rather than left running if the tray is toggled again mid-slide.
    return () => animation.stop();
  }, [collapsed, reveal]);

  /*
   * The gesture lives on the header strip, not the whole tray.
   *
   * Everything below the header is covers that take a tap and a long press,
   * and a parent that could claim a drag off one of them would have to win
   * the responder away from the child to do it. The header is the handle —
   * the same bargain a bottom sheet makes — and the arrow on it says so.
   */
  const handle = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dy) > SWIPE_SLOP && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > SWIPE_SLOP && !collapsed) onToggleCollapsed?.();
          if (gesture.dy < -SWIPE_SLOP && collapsed) onToggleCollapsed?.();
        },
      }),
    [collapsed, onToggleCollapsed],
  );

  /*
   * A library in phone storage, holding nothing, gets one line and stops.
   *
   * No fan and no ruler: its own books cannot be checked out, so the fan
   * would be empty and the ruler would read zero, and "Nothing checked out"
   * was the wrong reading of a shelf where everything is already here.
   *
   * **Only when nothing is checked out.** An import is checked out from the
   * moment it exists — the phone holds the only copy — and it does occupy the
   * budget, so a tray with imports in it has a fan to show and a ruler that
   * means something. Taking the panel for the whole tray hid them.
   */
  if (onDevice && books.length === 0) {
    return (
      <View style={[{ backgroundColor: color.panel }, shadow(14, 0.45)]}>
        <DashedEdge color="#6a5038" />
        <View
          style={{
            paddingHorizontal: space.xl,
            paddingVertical: space.lg,
            gap: 4,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: space.md,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}
            >
              On this phone
            </Text>
            <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
              {gigabytes(libraryBytes)}
            </Text>
          </View>
          {/*
            The folder, named. "Nothing checked out" was the old reading of
            this state and it was the wrong one twice over: nothing can be
            checked out of a library already on the phone, and the books are
            not absent — they are all here, in a folder the listener chose.
          */}
          <Text
            style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}
            numberOfLines={2}
          >
            {libraryCount === 0
              ? 'No books indexed yet'
              : `All ${libraryCount} ${libraryCount === 1 ? 'book is' : 'books are'} in ${
                  libraryPath || 'your library folder'
                }`}
          </Text>
        </View>
      </View>
    );
  }

  const fill = Math.min(1, (usedBytes + holdBytes) / budgetBytes);
  // Fuller bag, tighter fan: 8px apart when empty, overlapping by 22px when full.
  const overlap = Math.round(8 - fill * 30);
  const count = books.length;

  /*
   * The size against the budget, and nothing else.
   *
   * It carried the book count and the per-group counts too — "4 books · 12.1
   * of 32 GB · 3 Drive · 1 Home" — and on a phone the right-hand end of that
   * ran off the screen. Everything it said is said better somewhere else: the
   * count is the covers, and the groups are now named over their own stacks.
   * What is left is the one fact the fan cannot show.
   */
  const summary = `${(usedBytes / GB).toFixed(1)} of ${Math.round(budgetBytes / GB)} GB`;

  /*
   * The whole thing in words, for a screen reader, which has no covers to
   * count and no room it can run out of.
   */
  const spoken = [
    `${count} ${count === 1 ? 'book' : 'books'}`,
    summary,
    ...(labelled ? groups.map((g) => `${g.books.length} ${g.label}`) : []),
  ].join(', ');

  return (
    <View style={[{ backgroundColor: color.panel }, shadow(14, 0.45)]}>
      <DashedEdge color="#6a5038" />
      <View
        style={{
          paddingHorizontal: space.xl,
          paddingTop: space.lg,
          paddingBottom: 18,
          gap: space.md,
        }}
      >
        <Pressable
          onPress={onToggleCollapsed}
          disabled={!onToggleCollapsed}
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={`Checked out, ${spoken}`}
          accessibilityHint={
            collapsed ? 'Opens the checked-out tray' : 'Shuts the checked-out tray'
          }
          // Tappable as well as swipeable: a gesture nobody finds is not an
          // affordance, and the arrow has to do something when pressed.
          {...handle.panHandlers}
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: space.md,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}
          >
            Checked out
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
              {summary}
            </Text>
            {onToggleCollapsed ? (
              <Animated.View
                style={{
                  // Points down when open — push it down — and up when shut.
                  transform: [
                    {
                      rotate: reveal.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['180deg', '0deg'],
                      }),
                    },
                  ],
                }}
              >
                <ChevronDown size={18} stroke={color.muted} />
              </Animated.View>
            ) : null}
          </View>
        </Pressable>

        <Animated.View
          style={{
            height: reveal.interpolate({
              inputRange: [0, 1],
              outputRange: [0, revealHeight],
            }),
            opacity: reveal,
            overflow: 'hidden',
            gap: space.md,
          }}
          // Nothing in a shut tray should take a tap it cannot show the result of.
          pointerEvents={collapsed ? 'none' : 'auto'}
        >
          {count === 0 ? (
            <View style={{ height: FAN_HEIGHT, justifyContent: 'center', paddingLeft: space.xs }}>
              <Text style={{ fontFamily: font.serif, fontSize: 16, color: color.muted }}>
                Nothing checked out. Bit of a light trip, huh?
              </Text>
            </View>
          ) : (
            /*
             * Scrolls sideways, because the fan runs out of phone.
             *
             * The covers tighten as the budget fills — that is the whole
             * gesture of the thing, a bag getting fuller — but tightening is
             * bounded and a 32 GB budget is not: ten books reached the right
             * edge and the tenth was simply cut in half, with nothing to say
             * it was there. Found on a phone with ten books out.
             *
             * Tightening further to fit would have been the other answer, and
             * it is worse: past a certain overlap the covers stop being
             * recognisable, and the overlap is carrying a meaning of its own.
             */
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ height: fanHeight }}
              contentContainerStyle={{
                flexDirection: 'row',
                alignItems: 'flex-end',
                paddingLeft: space.xs,
                // Room past the last cover, so the end of the fan does not sit
                // flush against the edge and read as another cut-off.
                paddingRight: space.xl,
              }}
            >
              {/*
                The groups laid out left to right, each under its own name,
                with a rule between them. The fan's own counter runs across all
                of them so the lean and the stacking stay continuous — it should
                read as one fanned stack with divisions, not as several little
                stacks.

                With one group there is no name and no rule and nothing else
                changes, which is every library without a server.
              */}
              {groups.map((group, g) => {
                const before = groups.slice(0, g).reduce((n, x) => n + x.books.length, 0);
                return (
                  <View
                    key={group.id}
                    style={{ flexDirection: 'row', alignItems: 'flex-end' }}
                    accessibilityLabel={`${group.books.length} from ${group.label}`}
                  >
                    {g > 0 ? (
                      <View
                        style={{
                          width: 1,
                          height: FAN_HEIGHT * 0.62,
                          marginLeft: space.md,
                          marginRight: space.sm,
                          backgroundColor: color.border,
                        }}
                      />
                    ) : null}
                    <View style={{ alignItems: 'flex-start' }}>
                      {labelled ? (
                        <Text
                          numberOfLines={1}
                          style={{
                            fontFamily: font.mono,
                            fontSize: 10,
                            lineHeight: GROUP_LABEL_HEIGHT,
                            marginBottom: space.xs,
                            color: color.faint,
                            // The name belongs to the stack under it, so it
                            // starts where the stack does rather than centring
                            // over a width that changes with every checkout.
                            paddingLeft: 2,
                          }}
                        >
                          {group.label}
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
                        {group.books.map((book, j) => {
                          const i = before + j;
                          return (
                            <View
                              key={book.id}
                              style={{
                                marginLeft: j === 0 ? 0 : overlap,
                                zIndex: i + 1,
                                opacity: book.local.status === 'on-hold' ? 0.55 : 1,
                              }}
                            >
                              <BookCover
                                book={book}
                                size="tray"
                                lean={LEANS[i % LEANS.length]}
                                showEdge={false}
                                showRibbon={false}
                                // Everything in the tray is checked out, so an
                                // "OUT" tag on each one says nothing. "DONE" does.
                                showTag={book.local.status !== 'checked-out' || !!book.finishedAt}
                                showSpineProgress
                                onPress={() => onPressBook(book)}
                                onLongPress={() => onLongPressBook(book)}
                              />
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}

          {showRuler ? (
            <Ruler usedBytes={usedBytes} holdBytes={holdBytes} budgetBytes={budgetBytes} />
          ) : null}
        </Animated.View>
      </View>
    </View>
  );
}
