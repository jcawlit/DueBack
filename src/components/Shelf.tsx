/**
 * One shelf: face-out covers resting on a wooden ledge, with a paper label card
 * tucked under the left end.
 */

import { memo } from 'react';
import { Text, View } from 'react-native';
import type { Book } from '@/data/types';
import { color, font, shadow, space } from '@/theme/tokens';
import { BookCover } from './BookCover';
import type { Shelf as ShelfModel } from '@/lib/shelves';

type Props = {
  shelf: ShelfModel;
  onPressBook: (book: Book) => void;
  onLongPressBook: (book: Book) => void;
  /** Omitted when there is nothing to check out, which hides the corner tab. */
  onTabBook?: (book: Book) => void;
  onCancelCopy: (book: Book) => void;
  selecting: boolean;
  selectedIds: string[];
};

function ShelfRow({
  shelf,
  onPressBook,
  onLongPressBook,
  onTabBook,
  onCancelCopy,
  selecting,
  selectedIds,
}: Props) {
  return (
    <View style={{ paddingTop: 26, paddingHorizontal: space.lg }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: space.md,
          paddingHorizontal: 10,
          // Room above the covers for the status tags, which sit at top: -9.
          paddingTop: 16,
          minHeight: 136,
          // Keep the whole row, including the ribbons that hang off the bottom
          // of a cover, in front of the ledge below it.
          zIndex: 2,
          elevation: 12,
        }}
      >
        {shelf.books.map((book) => (
          <BookCover
            key={book.id}
            book={book}
            onPress={() => onPressBook(book)}
            onLongPress={() => onLongPressBook(book)}
            onTab={onTabBook ? () => onTabBook(book) : undefined}
            onCancelCopy={() => onCancelCopy(book)}
            selecting={selecting}
            selected={selectedIds.includes(book.id)}
          />
        ))}
      </View>

      {/* The ledge. Its shadow is what makes the covers look like they rest on it. */}
      <View
        style={[
          {
            height: 12,
            backgroundColor: color.wood,
            borderTopWidth: 2,
            borderTopColor: color.woodHighlight,
            zIndex: 1,
          },
          shadow(10, 0.5),
        ]}
      />

      <View style={{ flexDirection: 'row' }}>
        <View
          style={[
            {
              marginTop: space.sm,
              marginLeft: 18,
              backgroundColor: color.paperCard,
              paddingHorizontal: 8,
              paddingVertical: 3,
              transform: [{ rotate: '-1deg' }],
            },
            shadow(2, 0.4),
          ]}
        >
          <Text
            style={{
              fontFamily: font.mono,
              fontSize: 11,
              color: color.inkOnLabel,
            }}
          >
            {shelf.label}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Memoised because the Library screen re-renders as the virtualized list scrolls,
 * and redrawing every mounted shelf's covers on each of those renders is what
 * made scrolling stutter. The screen passes stable callbacks so this holds.
 */
export const Shelf = memo(ShelfRow);
