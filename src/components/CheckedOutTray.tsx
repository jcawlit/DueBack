/**
 * "Checked out" — the books on the phone, pinned to the bottom of the Library.
 * This is the mockups' Bag, renamed: the covers fan out and overlap more tightly
 * as the storage budget fills, and the ruler below measures what is left.
 *
 * Books still on hold appear here too, faded, because they are part of what the
 * user is taking with them even though no bytes have moved yet.
 */

import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, PanResponder, Pressable, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import { color, font, shadow, space } from '@/theme/tokens';
import { GB, gigabytes } from '@/lib/format';
import { BookCover } from './BookCover';
import { ChevronDown } from './icons';
import { DashedEdge } from './DashedEdge';
import { Ruler } from './Ruler';

type Props = {
  books: Book[];
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

const COLLAPSE_MS = 220;

/** How far a drag has to travel before it counts as a deliberate shove. */
const SWIPE_SLOP = 10;

export function CheckedOutTray({
  books,
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
}: Props) {
  const revealHeight = FAN_HEIGHT + (showRuler ? space.md + RULER_HEIGHT : 0);

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
   * A library in phone storage gets one line and stops.
   *
   * No fan, because nothing can be checked out of it; no ruler, because the
   * budget governs copies and there are none; and no collapse, because a
   * single line is already as small as this gets. The panel keeps its edge
   * and its shadow so the bottom of the Library still ends the same way.
   */
  if (onDevice) {
    return (
      <View style={[{ backgroundColor: color.panel }, shadow(14, 0.45)]}>
        <DashedEdge color="#6a5038" />
        <View
          style={{
            paddingHorizontal: space.xl,
            paddingVertical: space.lg,
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
          <Text
            style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}
            // Read as one thing, so it is not announced as two loose numbers.
            accessibilityLabel={`${libraryCount} ${
              libraryCount === 1 ? 'book' : 'books'
            }, ${gigabytes(libraryBytes)} in the library folder`}
          >
            {`${libraryCount} ${libraryCount === 1 ? 'book' : 'books'} · ${gigabytes(libraryBytes)}`}
          </Text>
        </View>
      </View>
    );
  }

  const fill = Math.min(1, (usedBytes + holdBytes) / budgetBytes);
  // Fuller bag, tighter fan: 8px apart when empty, overlapping by 22px when full.
  const overlap = Math.round(8 - fill * 30);
  const count = books.length;

  const summary =
    count === 0
      ? `0 of ${Math.round(budgetBytes / GB)} GB`
      : `${count} ${count === 1 ? 'book' : 'books'} · ${gigabytes(usedBytes)} of ${Math.round(budgetBytes / GB)} GB`;

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
          accessibilityLabel={`Checked out, ${summary}`}
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
          <View
            style={{
              height: FAN_HEIGHT,
              flexDirection: 'row',
              alignItems: 'flex-end',
              paddingLeft: space.xs,
            }}
          >
          {count === 0 ? (
            <Text
              style={{
                fontFamily: font.serif,
                fontSize: 16,
                color: color.muted,
                alignSelf: 'center',
              }}
            >
              Nothing checked out. Bit of a light trip, huh?
            </Text>
          ) : (
            books.map((book, i) => (
              <View
                key={book.id}
                style={{
                  marginLeft: i === 0 ? 0 : overlap,
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
                  // Everything in the tray is checked out, so an "OUT" tag on
                  // each one says nothing. "DONE" does.
                  showTag={book.local.status !== 'checked-out' || !!book.finishedAt}
                  showSpineProgress
                  onPress={() => onPressBook(book)}
                  onLongPress={() => onLongPressBook(book)}
                />
              </View>
            ))
          )}
          </View>

          {showRuler ? (
            <Ruler usedBytes={usedBytes} holdBytes={holdBytes} budgetBytes={budgetBytes} />
          ) : null}
        </Animated.View>
      </View>
    </View>
  );
}
