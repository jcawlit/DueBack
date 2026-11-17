/**
 * One shelf: face-out covers resting on a wooden ledge, with a paper label card
 * tucked under the left end.
 */

import { memo } from 'react';
import { Pressable, Text, View, type PanResponderInstance } from 'react-native';
import type { Book } from '@/data/types';
import { color, font, shadow, space } from '@/theme/tokens';
import { BookCover } from './BookCover';
import { ChevronDown, MoveIcon } from './icons';
import type { Shelf as ShelfModel } from '@/lib/shelves';

type Props = {
  shelf: ShelfModel;
  onPressBook: (book: Book) => void;
  onLongPressBook: (book: Book) => void;
  onCancelCopy: (book: Book) => void;
  /**
   * The grip, in the bottom-right corner of every cover.
   *
   * Its own small view with its own responder, which is what lets press
   * and hold mean two things on one cover: drag by the grip, check out
   * anywhere else. Absent outside custom mode, where there are no
   * hand-arranged shelves to drag between.
   */
  dragHandlersFor?: (bookId: string) => PanResponderInstance;
  /**
   * Where this row is, in list content coordinates, and what it can take.
   *
   * The identity travels with the box because the drag matches a finger to
   * a box and then has to know which shelf it found — and a shelf of seven
   * books is three rows, all of them the same drop target.
   */
  onMeasure?: (
    key: string,
    box: { pageY: number; height: number; shelfId?: string },
  ) => void;
  /** The row a held book would land on, drawn so the drop is not a guess. */
  isDropTarget?: boolean;
  /**
   * Renaming. Absent for a generated or loose row, which has no name of
   * its own to change.
   *
   * Takes the shelf id rather than being a closure over it, so the screen
   * can hand down one callback that never changes — a fresh arrow per row
   * defeats the `memo` below and redraws every shelf on every frame.
   */
  onRenameShelf?: (shelfId: string, name: string) => void;
  /** Moves this shelf one place. Absent at the end it cannot move toward. */
  onMoveShelf?: (shelfId: string, by: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /**
   * Bumped when the colour scheme changes.
   *
   * Unused in here, and it has to be a prop rather than a hook: the `memo`
   * below is what stops every mounted shelf redrawing as the list scrolls,
   * and it compares props. Without something that differs, a shelf keeps the
   * colours it last painted while the rest of the app changes around it.
   */
  paletteVersion?: number;
  /** The book currently in the air, which should not also be on the shelf. */
  liftedBookId?: string | null;
};

/** One nudge of a shelf, up or down. */
function ShelfStep({
  direction,
  disabled,
  label,
  onPress,
}: {
  direction: -1 | 1;
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 30,
        height: 30,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.25 : pressed ? 0.6 : 1,
        // Pointing the one chevron the app has in the direction it means.
        transform: [{ rotate: direction === -1 ? '180deg' : '0deg' }],
      })}
    >
      <ChevronDown size={16} stroke={color.muted} />
    </Pressable>
  );
}

function ShelfRow({
  shelf,
  onPressBook,
  onLongPressBook,
  onCancelCopy,
  dragHandlersFor,
  onMeasure,
  isDropTarget,
  liftedBookId,
  onRenameShelf,
  onMoveShelf,
  canMoveUp,
  canMoveDown,
}: Props) {
  // Only a hand-arranged shelf has a name of its own to change.
  const renameable = !!onRenameShelf && !!shelf.shelfId;

  return (
    <View
      style={{ paddingTop: 26, paddingHorizontal: space.lg }}
      /*
        Measured in window coordinates, not from the layout event.

        `e.nativeEvent.layout.y` is relative to the cell the `FlatList`
        wraps each item in, which is zero for every row — so every row
        claimed the same box and every drop landed on whichever was found
        first. `measureInWindow` asks where the row actually is.
      */
      onLayout={
        onMeasure
          ? (e) =>
              e.currentTarget.measureInWindow((_x, pageY, _w, height) =>
                onMeasure(shelf.key, { pageY, height, shelfId: shelf.shelfId }),
              )
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
        {shelf.books.map((book) => (
          <View
            key={book.id}
            // Faded where it came from, so the shelf shows the gap it left.
            style={{ opacity: liftedBookId === book.id ? 0.25 : 1 }}
          >
            <BookCover
              book={book}
              onPress={() => onPressBook(book)}
              onLongPress={() => onLongPressBook(book)}
              onCancelCopy={() => onCancelCopy(book)}
            />
            {dragHandlersFor ? (
              /*
                The bottom-right quadrant of the cover, which is a target
                worth aiming at on a small cover — and far enough from the
                middle that a press meant for the book is not a press meant
                for this. The icon sits in its corner rather than its
                centre, so it reads as a grip on the cover and not a badge
                over the art.
              */
              <View
                {...dragHandlersFor(book.id).panHandlers}
                accessibilityRole="button"
                accessibilityLabel={`Move ${book.title} to another shelf`}
                accessibilityHint="Press and hold, then drag"
                style={{
                  position: 'absolute',
                  right: 0,
                  bottom: 0,
                  width: '50%',
                  height: '50%',
                  alignItems: 'flex-end',
                  justifyContent: 'flex-end',
                  padding: 4,
                  zIndex: 20,
                  // Android stacks on elevation, and the cover it sits on
                  // carries 6. Without this the grip is under the art and
                  // the touches go to the cover instead.
                  elevation: 20,
                }}
              >
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 3,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: color.groundWash,
                    borderWidth: 1,
                    borderColor: color.border,
                  }}
                >
                  <MoveIcon size={13} stroke={color.paper} />
                </View>
              </View>
            ) : null}
          </View>
        ))}
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
          onPress={renameable ? () => onRenameShelf!(shelf.shelfId!, shelf.shelfName ?? '') : undefined}
          disabled={!renameable}
          accessibilityRole={renameable ? 'button' : undefined}
          accessibilityLabel={renameable ? `Rename ${shelf.label}` : undefined}
          style={[
            {
              marginTop: space.sm,
              marginLeft: 18,
              backgroundColor: color.paperCard,
              paddingHorizontal: 8,
              paddingVertical: 3,
              transform: [{ rotate: '-1deg' }],
              // Dashed while arranging, so it reads as editable.
              borderWidth: renameable ? 1 : 0,
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

        {/*
          Beside the name, because moving a shelf is a thing you do to the
          shelf and its name is where the shelf is addressed. A step at a
          time: shelves are few, and a second drag on this screen would
          need telling apart from the one that moves books.
        */}
        {renameable && onMoveShelf ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: space.sm }}>
            <ShelfStep
              direction={-1}
              disabled={!canMoveUp}
              label={`Move ${shelf.label} up`}
              onPress={() => onMoveShelf(shelf.shelfId!, -1)}
            />
            <ShelfStep
              direction={1}
              disabled={!canMoveDown}
              label={`Move ${shelf.label} down`}
              onPress={() => onMoveShelf(shelf.shelfId!, 1)}
            />
          </View>
        ) : null}
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
