/**
 * A face-out book: cover, page edges, bookmark ribbon, status tag and the
 * check-out tab.
 *
 * The interaction model, settled with the user:
 *   tap        → open the Book screen (never starts a 1.5 GB copy by accident)
 *   long-press → check out / return, as a shortcut for people who know it
 *   corner tab → the same move, but visible
 */

import { Pressable, View } from 'react-native';
import type { Book } from '@/data/types';
import { isCheckedOut, isInProgress, progressFraction } from '@/data/types';
import { bytes, hoursMinutes } from '@/lib/format';
import { leanFor } from '@/lib/shelves';
import { TOUCH, color, shadow } from '@/theme/tokens';
import { CoverFace, type CoverSize, coverDimensions } from './CoverFace';
import {
  CopyOverlay,
  DrmStamp,
  StatusTag,
  tagForBook,
} from './CoverBadges';
import { PageEdge } from './PageEdge';
import { Ribbon } from './Ribbon';

type Props = {
  book: Book;
  size?: CoverSize;
  /** Tap target. Omitted on the hero covers, which are not interactive. */
  onPress?: () => void;
  onLongPress?: () => void;
  /** The visible tab's action. Omit to hide the tab entirely. */
  showEdge?: boolean;
  showRibbon?: boolean;
  showTag?: boolean;
  /** Long form tags ("CHECKED OUT") fit the hero covers; shelves get "OUT". */
  longTag?: boolean;
  /** Override the computed lean; pass 0 to stand a cover up straight. */
  lean?: number;
  edgeWidth?: number;
  /** Shrinks the cover proportionally; see CoverFace. */
  scale?: number;
  /** Stops an in-flight copy. Only shown on the larger covers. */
  onCancelCopy?: () => void;
  /**
   * Draws how far through the book you are up the cover's left edge.
   *
   * For the checked-out tray, where the covers carry no page edge and no
   * ribbon: those books are the ones being listened to, and how far through
   * each one is was the fact the tray could not tell you.
   */
  showSpineProgress?: boolean;
};

export function BookCover({
  book,
  size = 'shelf',
  onPress,
  onLongPress,
  showEdge = true,
  showRibbon = true,
  showTag = true,
  longTag = false,
  lean,
  edgeWidth,
  scale = 1,
  onCancelCopy,
  showSpineProgress = false,
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
    // The stamp is decorative to a screen reader unless the fact is spoken.
    book.drmProtected ? "protected by DRM, can't be played" : '',
    book.finishedAt ? 'finished' : '',
    showSpineProgress && !book.finishedAt && book.progressSec > 0
      ? `${Math.round(progressFraction(book) * 100)}% through`
      : '',
  ]
    .filter(Boolean)
    .join(', ');

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
          {showSpineProgress && book.progressSec > 0 ? (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: 3,
                backgroundColor: color.troughDeep,
                justifyContent: 'flex-end',
                overflow: 'hidden',
              }}
            >
              {/* Fills from the bottom up, like a bookmark climbing the spine. */}
              <View
                style={{
                  height: `${Math.max(2, progressFraction(book) * 100)}%`,
                  backgroundColor: book.finishedAt ? color.accent : color.ribbon,
                }}
              />
            </View>
          ) : null}
          {book.drmProtected ? (
            <View
              style={{
                position: 'absolute',
                // Low and left: the corner tab owns bottom-right, and a
                // stamp across the title would hide what the book is.
                bottom: Math.round(height * 0.09),
                left: Math.round(width * 0.08),
              }}
            >
              <DrmStamp coverWidth={width} />
            </View>
          ) : null}
          {copying && book.local.status === 'copying' ? (
            <CopyOverlay
              progress={book.local.progress}
              width={width}
              onCancel={size === 'tray' ? undefined : onCancelCopy}
            />
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
      style={({ pressed }) => ({
        minHeight: Math.max(TOUCH, height),
        transform: [{ rotate: `${rotation}deg` }, { translateY: pressed ? -4 : 0 }],
        transformOrigin: origin,
      })}
    >
      {body}
    </Pressable>
  );
}
