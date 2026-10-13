/**
 * "Checked out" — the books on the phone, pinned to the bottom of the Library.
 * This is the mockups' Bag, renamed: the covers fan out and overlap more tightly
 * as the storage budget fills, and the ruler below measures what is left.
 *
 * Books still on hold appear here too, faded, because they are part of what the
 * user is taking with them even though no bytes have moved yet.
 */

import { Text, View } from 'react-native';
import type { Book } from '@/data/types';
import { color, font, shadow, space } from '@/theme/tokens';
import { GB, gigabytes } from '@/lib/format';
import { BookCover } from './BookCover';
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
};

/** Rotations reused from the mockup, so the fan looks hand-stacked. */
const LEANS = [-3, 2, -1.5, 3, -2, 1.5, -2.5, 2.5, -1, 1];

export function CheckedOutTray({
  books,
  usedBytes,
  holdBytes,
  budgetBytes,
  onPressBook,
  onLongPressBook,
  showRuler = true,
}: Props) {
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
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'baseline',
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}
          >
            Checked out
          </Text>
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            {summary}
          </Text>
        </View>

        <View
          style={{
            height: 92,
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
      </View>
    </View>
  );
}
