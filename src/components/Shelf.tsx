/**
 * One shelf: face-out covers resting on a wooden ledge, with a paper label card
 * tucked under the left end.
 */

import { memo } from 'react';
import { Pressable, Text, View, type PanResponderInstance } from 'react-native';
import type { Book } from '@/data/types';
import { color, font, shadow, space } from '@/theme/tokens';
import { BookCover } from './BookCover';
import type { Shelf as ShelfModel } from '@/lib/shelves';

type Props = {
  shelf: ShelfModel;
  onPressBook: (book: Book) => void;
  onLongPressBook: (book: Book) => void;
  onCancelCopy: (book: Book) => void;
  /**
   * Arranging, so a cover is something you pick up rather than open.
   *
   * When set, each cover gets its own responder and the row reports where
   * it is, so a finger can be matched to a shelf. Absent the whole time
   * anyone is only reading, which is almost all of the time.
   */
  dragHandlersFor?: (book: Book) => PanResponderInstance;
  /**
   * Where this row is, in list content coordinates, and what it can take.
   *
   * The identity travels with the box because the drag matches a finger to
   * a box and then has to know which shelf it found — and a shelf of seven
   * books is three rows, all of them the same drop target.
   */
  onMeasure?: (
    key: string,
    box: { top: number; height: number; shelfId?: string; unshelved?: boolean },
  ) => void;
  /** The row a held book would land on, drawn so the drop is not a guess. */
  isDropTarget?: boolean;
  /** Renaming, while arranging. Absent for a generated or loose row. */
  onPressLabel?: () => void;
  /** The book currently in the air, which should not also be on the shelf. */
  liftedBookId?: string | null;
};

function ShelfRow({
  shelf,
  onPressBook,
  onLongPressBook,
  onCancelCopy,
  dragHandlersFor,
  onMeasure,
  isDropTarget,
  liftedBookId,
  onPressLabel,
}: Props) {
  return (
    <View
      style={{ paddingTop: 26, paddingHorizontal: space.lg }}
      onLayout={
        onMeasure
          ? (e) =>
              onMeasure(shelf.key, {
                top: e.nativeEvent.layout.y,
                height: e.nativeEvent.layout.height,
                shelfId: shelf.shelfId,
                unshelved: shelf.unshelved,
              })
          : undefined
      }
    >
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
        {shelf.books.map((book) =>
          dragHandlersFor ? (
            // The responder wraps the cover rather than going inside it, so
            // `BookCover` stays a thing that draws a book and nothing else.
            <View
              key={book.id}
              {...dragHandlersFor(book).panHandlers}
              // Faded where it came from, so the shelf shows the gap it left.
              style={{ opacity: liftedBookId === book.id ? 0.25 : 1 }}
            >
              <BookCover book={book} onCancelCopy={() => onCancelCopy(book)} />
            </View>
          ) : (
            <BookCover
              key={book.id}
              book={book}
              onPress={() => onPressBook(book)}
              onLongPress={() => onLongPressBook(book)}
              onCancelCopy={() => onCancelCopy(book)}
            />
          ),
        )}
        {shelf.books.length === 0 ? (
          <Text
            style={{
              fontFamily: font.mono,
              fontSize: 11,
              color: color.faint,
              alignSelf: 'center',
            }}
          >
            {/* An empty shelf is the one you just made, so it says what to do. */}
            drag a book here
          </Text>
        ) : null}
      </View>

      {/* The ledge. Its shadow is what makes the covers look like they rest on it. */}
      <View
        style={[
          {
            height: 12,
            backgroundColor: isDropTarget ? color.checkout : color.wood,
            borderTopWidth: 2,
            borderTopColor: isDropTarget ? color.checkout : color.woodHighlight,
            zIndex: 1,
          },
          shadow(10, 0.5),
        ]}
      />

      <View style={{ flexDirection: 'row' }}>
        {/*
          The label card is the rename control while arranging: it is
          already the shelf's name, sitting under the shelf, and a separate
          pencil beside it would be a second thing meaning the same.
        */}
        <Pressable
          onPress={onPressLabel}
          disabled={!onPressLabel}
          accessibilityRole={onPressLabel ? 'button' : undefined}
          accessibilityLabel={onPressLabel ? `Rename ${shelf.label}` : undefined}
          style={[
            {
              marginTop: space.sm,
              marginLeft: 18,
              backgroundColor: color.paperCard,
              paddingHorizontal: 8,
              paddingVertical: 3,
              transform: [{ rotate: '-1deg' }],
              // Dashed while arranging, so it reads as editable.
              borderWidth: onPressLabel ? 1 : 0,
              borderStyle: 'dashed',
              borderColor: color.inkOnLabel,
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
        </Pressable>
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
