/**
 * The book as a thing: its cover, with the library card tucked into the
 * lower-right corner the way one is pasted into a real one.
 *
 * Shared by the Book screen and the Player so they open with the same object
 * rather than two drawings of it. Nothing here acts on the book — no play,
 * no return, no status tag. Transport belongs in the flow of each screen,
 * under the progress it acts on; this is what you are looking at.
 *
 * The composition is four quadrants with only two of them used: the cover
 * fills the left half top to bottom, the card sits in the bottom-right and
 * crosses the centre line by just enough to catch the book's corner. Its
 * bottom is pinned to the cover's, which is what makes the two read as one
 * object, and it is the one measurement that never bends.
 */

import { useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import type { Book } from '@/data/types';
import { color, shadow, space, TOUCH } from '@/theme/tokens';
import { BookCover } from './BookCover';
import { coverDimensions, type CoverSize } from './CoverFace';
import { COMPACT_CARD_ESTIMATE, LibraryCard, LibraryCardSheet } from './LibraryCard';

/**
 * The page edge drawn beside the cover, passed to `BookCover` as `edgeWidth`.
 *
 * It is a sibling of the cover in a row, not part of it, so the book's outer
 * right edge is the cover plus this. Fixed rather than scaled: `PageEdge`
 * takes the number as given.
 */
const EDGE_WIDTH: Record<string, number> = { book: 13, player: 14 };

/**
 * How far the card crosses the centre line onto the cover.
 *
 * Small on purpose. The card is laid down *beside* the book and catches its
 * lower corner; draping it across the artwork left the whole right half of
 * the screen empty.
 */
const CARD_OVERLAP = 18;

/** How wide the card is, as a share of the screen. */
const CARD_WIDTH_FRACTION = 0.44;

export function BookObject({
  book,
  size,
  chrome,
  status,
}: {
  book: Book;
  size: CoverSize;
  /**
   * Everything below this on the screen, which the cover cannot have.
   *
   * In practice width is what limits the cover on every phone size checked;
   * this only binds on something very short.
   */
  chrome: number;
  /** The compact card's bottom line, e.g. "ON PHONE · FULL CARD". */
  status: string;
}) {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [cardHeight, setCardHeight] = useState(COMPACT_CARD_ESTIMATE);
  const [showCard, setShowCard] = useState(false);

  const edge = EDGE_WIDTH[size] ?? 13;
  const base = coverDimensions(size, 1);

  const heroWidth = windowWidth - space.xxl * 2;
  const centreX = heroWidth / 2;
  // Width before height: the book and its page edge come to the centre line.
  // Sizing by height alone is what once left the cover at 40% of the screen
  // with the right half empty.
  const widthScale = (centreX - edge) / base.width;
  const heightScale = (windowHeight - chrome) / base.height;
  // Never past full size, never below 0.6: under that the artwork's own
  // title stops being readable and a short screen is better off scrolling.
  const coverScale = Math.max(0.6, Math.min(1, widthScale, heightScale));
  const coverHeight = base.height * coverScale;

  const cardLeft = centreX - CARD_OVERLAP;
  const cardWidth = Math.min(
    Math.round(windowWidth * CARD_WIDTH_FRACTION),
    heroWidth - cardLeft,
  );
  const cardTop = Math.max(0, coverHeight - cardHeight);
  const height = Math.max(coverHeight, cardTop + cardHeight);

  return (
    <View style={{ paddingHorizontal: space.xxl }}>
      <View style={{ height }}>
        <BookCover
          book={book}
          size={size}
          showTag={false}
          showRibbon={false}
          lean={-1.5}
          edgeWidth={edge}
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
              // composition reserves, and a loop here would be a layout that
              // never settles.
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
            <LibraryCard bare compact checkouts={book.checkouts} statusLine={status} />
          </View>
        </Pressable>
      </View>

      <LibraryCardSheet
        visible={showCard}
        checkouts={book.checkouts}
        title={book.title}
        onClose={() => setShowCard(false)}
      />
    </View>
  );
}

/**
 * What the compact card says under its stamps.
 *
 * The state first, because that is the question the card is glanced at to
 * answer, then how to see the rest — a card showing one of eleven stamps has
 * to say so. Every one of these renders whole: at 11px mono in a 181px card
 * there is room for about 23 characters and the longest here is 21.
 */
export function cardStatusFor(book: Book, out: boolean, copying: boolean, onHold: boolean): string {
  const state = copying
    ? 'COPYING'
    : out
      ? 'ON PHONE'
      : onHold
        ? 'ON HOLD'
        : book.checkouts.length === 0
          ? 'NEVER OUT'
          : 'ON SHELF';
  return `${state} · FULL CARD`;
}
