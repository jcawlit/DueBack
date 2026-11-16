/**
 * Lifting a book off one shelf and putting it on another.
 *
 * `PanResponder` and `Animated`, like everything else that moves in this app.
 * No gesture-handler and no reanimated: both are native, neither is a direct
 * dependency here, and adding one means a development build for a feature
 * that works without it.
 *
 * The parts, because they have to agree about coordinates:
 *
 * - every shelf row reports its box in **list content** coordinates, which is
 *   what `onLayout` gives an item inside a `FlatList`;
 * - the screen records where the list starts and how far it has scrolled;
 * - a finger arrives in **page** coordinates, so
 *   `content = page - listTop + scrollOffset` is what turns one into the
 *   other, and getting that wrong drops books on the wrong shelf.
 *
 * Press and hold, not drag-from-touch, even inside the edit mode: the covers
 * are small and close together, and a mode where brushing the screen moves
 * somebody's library is not one to leave switched on.
 */

import { useCallback, useRef, useState } from 'react';
import { Animated, PanResponder, View } from 'react-native';
import type { Book } from '@/data/types';
import { BookCover } from './BookCover';

/** How long a finger has to stay still before the book comes off the shelf. */
const HOLD_MS = 220;

/** Within this much of an edge, the list scrolls while you hold a book there. */
const EDGE = 90;
/** Pixels per tick of edge scrolling. One tick is one animation frame-ish. */
const EDGE_STEP = 14;
const EDGE_MS = 16;

type Box = { top: number; height: number; shelfId?: string; unshelved?: boolean };

export type DragState = {
  book: Book;
  /** Page coordinates of the finger, for drawing the floating cover. */
  x: number;
  y: number;
  /** The row the finger is over, if it can take a book. */
  overShelfId: string | null;
  overUnshelved: boolean;
};

export function useShelfDrag({
  enabled,
  onDrop,
  onDropOff,
  scrollBy,
}: {
  enabled: boolean;
  onDrop: (bookId: string, shelfId: string) => void;
  /** Dropped on the loose pile: taken off whatever shelf it was on. */
  onDropOff: (bookId: string) => void;
  scrollBy: (delta: number) => void;
}) {
  /*
   * The bottom of the list on screen, for deciding when a held book is
   * near the edge. Kept in here rather than handed in per call, so the
   * screen does not need a wrapper around `handlersFor` whose identity
   * changes on every render.
   */
  const [drag, setDrag] = useState<DragState | null>(null);

  /*
   * Refs, not state, for everything the gesture reads. A PanResponder created
   * once would otherwise close over the first render's values, and recreating
   * it on every frame of a drag is what it is trying to avoid.
   */
  const boxes = useRef(new Map<string, Box>());
  const listTop = useRef(0);
  const scrollOffset = useRef(0);
  const held = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifted = useRef(false);
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const current = useRef<DragState | null>(null);
  const viewportBottom = useRef(0);

  const setCurrent = (next: DragState | null) => {
    current.current = next;
    setDrag(next);
  };

  const measure = useCallback((key: string, box: Box) => {
    boxes.current.set(key, box);
  }, []);


  const setScrollOffset = useCallback((y: number) => {
    scrollOffset.current = y;
  }, []);

  const stopEdgeScroll = () => {
    if (edgeTimer.current) {
      clearInterval(edgeTimer.current);
      edgeTimer.current = null;
    }
  };

  /** Which row a finger at this page position is over. */
  const rowAt = (pageY: number): Box | null => {
    const contentY = pageY - listTop.current + scrollOffset.current;
    for (const box of boxes.current.values()) {
      if (contentY >= box.top && contentY < box.top + box.height) return box;
    }
    return null;
  };

  const edgeScroll = (pageY: number, viewportBottom: number) => {
    stopEdgeScroll();
    const nearTop = pageY - listTop.current < EDGE;
    const nearBottom = viewportBottom - pageY < EDGE;
    if (!nearTop && !nearBottom) return;
    const delta = nearTop ? -EDGE_STEP : EDGE_STEP;
    edgeTimer.current = setInterval(() => scrollBy(delta), EDGE_MS);
  };

  /**
   * A responder per cover, made fresh for each one.
   *
   * `onStartShouldSetPanResponder` claims the touch immediately so the hold
   * timer can run, which means a cover in edit mode no longer takes a tap.
   * That is the trade of being in a mode: while you are arranging, a cover is
   * a thing you move rather than a thing you open.
   */
  const handlersFor = (book: Book) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => enabled,
      onPanResponderGrant: (event) => {
        const { pageX, pageY } = event.nativeEvent;
        lifted.current = false;
        held.current = setTimeout(() => {
          lifted.current = true;
          const over = rowAt(pageY);
          setCurrent({
            book,
            x: pageX,
            y: pageY,
            overShelfId: over?.shelfId ?? null,
            overUnshelved: !!over?.unshelved,
          });
        }, HOLD_MS);
      },
      onPanResponderMove: (event) => {
        const { pageX, pageY } = event.nativeEvent;
        if (!lifted.current) {
          // Moved before the hold finished: it was a drag of the list, not of
          // a book. Let the timer go so nothing lifts under the finger.
          if (held.current) clearTimeout(held.current);
          held.current = null;
          return;
        }
        const over = rowAt(pageY);
        setCurrent({
          book,
          x: pageX,
          y: pageY,
          overShelfId: over?.shelfId ?? null,
          overUnshelved: !!over?.unshelved,
        });
        edgeScroll(pageY, viewportBottom.current);
      },
      onPanResponderRelease: () => {
        if (held.current) clearTimeout(held.current);
        held.current = null;
        stopEdgeScroll();
        const state = current.current;
        lifted.current = false;
        setCurrent(null);
        if (!state) return;
        if (state.overShelfId) onDrop(state.book.id, state.overShelfId);
        else if (state.overUnshelved) onDropOff(state.book.id);
        // Dropped on nothing: the book stays where it was, which is the
        // forgiving answer and the one a misjudged drag wants.
      },
      onPanResponderTerminate: () => {
        if (held.current) clearTimeout(held.current);
        held.current = null;
        stopEdgeScroll();
        lifted.current = false;
        setCurrent(null);
      },
    });

  const setViewport = useCallback((top: number, height: number) => {
    listTop.current = top;
    viewportBottom.current = top + height;
  }, []);

  return { drag, handlersFor, measure, setViewport, setScrollOffset };
}

/**
 * The lifted cover, following the finger.
 *
 * Drawn over everything and taking no touches, so the responder underneath
 * keeps receiving the gesture that is moving it.
 */
export function DragGhost({ drag }: { drag: DragState | null }) {
  if (!drag) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 999 }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          // Centred under the finger, and lifted clear of it so the cover is
          // not the thing hiding where you are about to put it.
          left: drag.x - 44,
          top: drag.y - 110,
          opacity: 0.92,
          transform: [{ rotate: '-3deg' }, { scale: 1.06 }],
        }}
      >
        <BookCover
          book={drag.book}
          showEdge={false}
          showRibbon={false}
          showTag={false}
        />
      </Animated.View>
    </View>
  );
}
