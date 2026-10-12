/**
 * A face-out book: cover, page edges, bookmark ribbon, status tag and the
 * check-out tab.
 *
 * The interaction model, settled with the user:
 *   tap        → open the Book screen (never starts a 1.5 GB copy by accident)
 *   long-press → check out / return, as a shortcut for people who know it
 *   corner tab → the same move, but visible
 * In select mode the whole cover becomes a checkbox instead.
 */

import { Pressable, View } from 'react-native';
import type { Book } from '@/data/types';
import { isCheckedOut, isInProgress } from '@/data/types';
import { bytes, hoursMinutes } from '@/lib/format';
import { leanFor } from '@/lib/shelves';
import { TOUCH, color, shadow } from '@/theme/tokens';
import { CoverFace, type CoverSize, coverDimensions } from './CoverFace';
import {
  CopyOverlay,
  CornerTab,
  SelectBadge,
  StatusTag,
  tabStateForBook,
  tagForBook,
} from './CoverBadges';
import { PageEdge } from './PageEdge';
import { Ribbon } from './Ribbon';

/** The visible check-out control on each cover. */
const TAB_SIZE = 26;

type Props = {
  book: Book;
  size?: CoverSize;
  /** Tap target. Omitted on the hero covers, which are not interactive. */
  onPress?: () => void;
  onLongPress?: () => void;
  /** The visible tab's action. Omit to hide the tab entirely. */
  onTab?: () => void;
  showEdge?: boolean;
  showRibbon?: boolean;
  showTag?: boolean;
  /** Long form tags ("CHECKED OUT") fit the hero covers; shelves get "OUT". */
  longTag?: boolean;
  selecting?: boolean;
  selected?: boolean;
  /** Override the computed lean; pass 0 to stand a cover up straight. */
  lean?: number;
  edgeWidth?: number;
  /** Shrinks the cover proportionally; see CoverFace. */
  scale?: number;
  /** Stops an in-flight copy. Only shown on the larger covers. */
  onCancelCopy?: () => void;
};

export function BookCover({
  book,
  size = 'shelf',
  onPress,
  onLongPress,
  onTab,
  showEdge = true,
  showRibbon = true,
  showTag = true,
  longTag = false,
  selecting = false,
  selected = false,
  lean,
  edgeWidth,
  scale = 1,
  onCancelCopy,
}: Props) {
  const { width, height } = coverDimensions(size, scale);
  const rotation = lean ?? leanFor(book.id, size === 'tray' ? 3 : 2);
  const tag = showTag ? tagForBook(book, longTag) : null;
  // Shelf and tray covers pivot on the surface they rest on; the big hero covers
  // on Book and Player are free-floating and turn about their middle.
  const origin = size === 'book' || size === 'player' ? 'center' : 'bottom left';
  const copying = book.local.status === 'copying';
  const elevation = size === 'shelf' ? 6 : size === 'tray' ? 5 : 20;

  const label = [
    book.title,
    book.author,
    hoursMinutes(book.durationSec),
    bytes(book.sizeBytes),
    isCheckedOut(book)
      ? 'checked out'
      : book.local.status === 'on-hold'
        ? 'on hold'
        : copying
          ? 'checking out'
          : 'on the shelf',
  ].join(', ');

  const body = (
    <View style={{ position: 'relative' }}>
      <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
        {/*
          The tab and the select tick are children of the cover's own elevated
          layer, not siblings of it. As siblings they lost the Android draw-order
          race against the cover's elevation; as children they always paint last.
        */}
        <View style={shadow(elevation, 0.5)}>
          <CoverFace book={book} size={size} scale={scale} />
          {copying && book.local.status === 'copying' ? (
            <CopyOverlay
              progress={book.local.progress}
              width={width}
              onCancel={size === 'tray' ? undefined : onCancelCopy}
            />
          ) : null}
          {selecting ? (
            <View style={{ position: 'absolute', top: -8, left: -8 }}>
              <SelectBadge selected={selected} />
            </View>
          ) : null}
          {!selecting && onTab && !copying ? (
            <View style={{ position: 'absolute', bottom: 8, right: 8 }}>
              <CornerTab
                state={tabStateForBook(book)}
                size={TAB_SIZE}
                onPress={onTab}
                accessibilityLabel={
                  isCheckedOut(book)
                    ? `Return ${book.title}, frees ${bytes(book.sizeBytes)}`
                    : book.local.status === 'on-hold'
                      ? `Take ${book.title} off hold`
                      : `Check out ${book.title}, ${bytes(book.sizeBytes)}`
                }
              />
            </View>
          ) : null}
        </View>
        {showEdge && size !== 'tray' ? (
          <PageEdge
            durationSec={book.durationSec}
            height={height}
            width={edgeWidth ? Math.round(edgeWidth * scale) : undefined}
            inset={size === 'shelf' ? 3 : 5}
            elevation={size === 'shelf' ? 6 : 20}
          />
        ) : null}
      </View>

      {showRibbon && isInProgress(book) ? (
        <View style={{ position: 'absolute', bottom: -16, left: 26 }}>
          <Ribbon />
        </View>
      ) : null}

      {tag ? (
        <View style={{ position: 'absolute', top: -9, right: 2 }}>
          <StatusTag label={tag.label} variant={tag.variant} />
        </View>
      ) : null}

    </View>
  );

  if (!onPress && !onLongPress) {
    return (
      <View
        style={{
          transform: [{ rotate: `${rotation}deg` }],
          transformOrigin: origin,
        }}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selecting ? { selected } : undefined}
      style={({ pressed }) => ({
        minHeight: Math.max(TOUCH, height),
        transform: [
          { rotate: `${rotation}deg` },
          { translateY: pressed || selected ? -4 : 0 },
        ],
        transformOrigin: origin,
        opacity: selecting && !selected ? 0.62 : 1,
      })}
    >
      {selected ? (
        <View
          style={{
            position: 'absolute',
            top: -5,
            left: -5,
            width: width + 10,
            height: height + 10,
            borderRadius: 4,
            borderWidth: 1.5,
            borderColor: color.accent,
          }}
        />
      ) : null}
      {body}
    </Pressable>
  );
}
