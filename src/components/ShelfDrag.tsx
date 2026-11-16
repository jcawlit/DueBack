/**
 * Dragging a book from one shelf to another, by the grip on its cover.
 *
 * `PanResponder` and `Animated`, like `ChapterScrubber` and `Slip`. No
 * gesture-handler and no reanimated: both are native, neither is a direct
 * dependency, and adding one means a development build for something that
 * works without it.
 *
 * **The responder is created once per book and never again.** The first
 * version built one inside the shelf's render, so every state change during a
 * drag — and a drag is nothing but state changes — replaced the responder
 * that was holding the finger, and the moves stopped arriving. It looked like
 * one book working once and then the feature being dead. Everything mutable
 * is therefore read from a ref, and the responders live in a map keyed by
 * book id.
 *
 * Three coordinate spaces have to agree, which is the other thing to be
 * careful with:
 *
 * - a shelf row reports its box in **list content** coordinates, which is
 *   what `onLayout` gives an item inside a `FlatList`;
 * - a finger arrives in **page** coordinates;
 * - `content = page - listTop + scrollOffset` turns one into the other, and
 *   getting it wrong drops books on the wrong shelf.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, View, type PanResponderInstance } from 'react-native';
import type { Book } from '@/data/types';
import { BookCover } from './BookCover';

/** How long the grip is held before the book comes off the shelf. */
const HOLD_MS = 200;

/**
 * The band at each end of the list where holding a book scrolls it.
 *
 * Deep: a third of a phone screen, so reaching it is easy and the speed
 * has room to build across it.
 */
const EDGE = 150;
/** Pixels per tick at the inside of the band, where the scroll just starts. */
const EDGE_SLOW = 6;
/** And at the very edge, where you have clearly asked to go a long way. */
const EDGE_FAST = 90;
const EDGE_MS = 16;

/**
 * A row's place on the glass, and the scroll it was measured at.
 *
 * Window coordinates, not list-content ones. `onLayout` on a `FlatList`
 * item reports `y` relative to the cell the list wraps it in, which is
 * zero for every row — so every box looked identical and every drop found
 * whichever row happened to be first in the map. That was the top shelf,
 * every time, from anywhere.
 *
 * `measureInWindow` gives the real thing. It goes stale as the list
 * scrolls, which is what `atScroll` is for: how far the list had scrolled
 * when the row said where it was, so the difference since can be taken off.
 */
type Box = { pageY: number; height: number; atScroll: number; shelfId?: string };

/** What a row reports; the scroll is added here, where it is known. */
export type RowBox = { pageY: number; height: number; shelfId?: string };

export type DragState = {
  bookId: string;
  /** Page coordinates of the finger, for drawing the floating cover. */
  x: number;
  y: number;
  /** The row the finger is over, if it can take a book. */
  overShelfId: string | null;
};

export function useShelfDrag({
  onDrop,
  scrollBy,
}: {
  onDrop: (bookId: string, shelfId: string) => void;
  scrollBy: (delta: number) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);

  const boxes = useRef(new Map<string, Box>());
  const listTop = useRef(0);
  const viewportBottom = useRef(0);
  const scrollOffset = useRef(0);
  const current = useRef<DragState | null>(null);
  const responders = useRef(new Map<string, PanResponderInstance>());

  /*
   * The callbacks, behind a ref.
   *
   * A responder made once closes over whatever these were at the time, and
   * the screen hands down new arrow functions on every render. Reading them
   * through a ref is what lets the responder outlive them.
   */
  const callbacks = useRef({ onDrop, scrollBy });
  // Updated after the render rather than during it. Nothing reads these
  // until a finger is on the glass, which is long after either way.
  useEffect(() => {
    callbacks.current = { onDrop, scrollBy };
  });

  const setCurrent = (next: DragState | null) => {
    current.current = next;
    setDrag(next);
  };

  const measure = useCallback((key: string, box: RowBox) => {
    boxes.current.set(key, { ...box, atScroll: scrollOffset.current });
  }, []);

  /**
   * Drops boxes for rows that are no longer on screen, and **keeps the
   * rest**.
   *
   * It used to clear the lot, which was a bug with a very particular
   * shape. The live preview makes a new row array on every frame of a
   * drag, so the clear ran on every frame — but a row only re-reports
   * itself through `onLayout` when its layout actually changes. After the
   * first frame the map was empty and stayed empty: no row could be found,
   * nothing highlighted, and the drop committed nothing. Leaving custom
   * mode and coming back remounted the rows, bought one working drag, and
   * then did the same thing again.
   *
   * Pruning by key keeps every box that is still true. A row that moved
   * gets a fresh `onLayout` because its layout changed, which is exactly
   * when a box needs replacing and the only time it does.
   */
  const retainBoxes = useCallback((keys: string[]) => {
    const live = new Set(keys);
    for (const key of boxes.current.keys()) {
      if (!live.has(key)) boxes.current.delete(key);
    }
  }, []);

  const setViewport = useCallback((top: number, height: number) => {
    listTop.current = top;
    viewportBottom.current = top + height;
  }, []);

  const setScrollOffset = useCallback((y: number) => {
    scrollOffset.current = y;
  }, []);

  /** One responder per book, built the first time that book is asked for. */
  const handlersFor = useCallback((bookId: string): PanResponderInstance => {
    const existing = responders.current.get(bookId);
    if (existing) return existing;

    let held: ReturnType<typeof setTimeout> | null = null;
    let edge: ReturnType<typeof setInterval> | null = null;
    let lifted = false;
    let lastY = 0;

    const stopEdge = () => {
      if (edge) clearInterval(edge);
      edge = null;
    };
    const clearHold = () => {
      if (held) clearTimeout(held);
      held = null;
    };

    const rowAt = (pageY: number): Box | null => {
      for (const box of boxes.current.values()) {
        // Where the row is now: where it said it was, less whatever the
        // list has scrolled since it said so.
        const top = box.pageY - (scrollOffset.current - box.atScroll);
        if (pageY >= top && pageY < top + box.height) return box;
      }
      return null;
    };

    const track = (pageX: number, pageY: number) => {
      const over = rowAt(pageY);
      setCurrent({
        bookId,
        x: pageX,
        y: pageY,
        overShelfId: over?.shelfId ?? null,
      });
    };

    /**
     * How far and how fast to scroll for a finger at this height.
     *
     * Proportional to how deep into the band it is, so resting just inside
     * creeps and holding at the very edge travels several shelves a second.
     * A fixed step meant one speed, and one speed is either too slow to
     * cross a library or too fast to stop on a shelf.
     */
    const edgeSpeed = (pageY: number): number => {
      const fromTop = pageY - listTop.current;
      const fromBottom = viewportBottom.current - pageY;
      const depth = fromTop < EDGE ? EDGE - fromTop : fromBottom < EDGE ? EDGE - fromBottom : 0;
      if (depth <= 0) return 0;
      const share = Math.min(1, depth / EDGE);
      const speed = EDGE_SLOW + share * (EDGE_FAST - EDGE_SLOW);
      return fromTop < EDGE ? -speed : speed;
    };

    /*
     * One loop for the whole drag, reading the finger's latest position
     * each tick. Restarting an interval on every move event made the
     * scrolling stutter — each new move cancelled the tick that was about
     * to fire — and pinned it to a single speed.
     */
    const edgeScroll = (pageY: number) => {
      lastY = pageY;
      if (edgeSpeed(pageY) === 0) {
        stopEdge();
        return;
      }
      if (edge) return;
      edge = setInterval(() => {
        const speed = edgeSpeed(lastY);
        if (speed === 0) {
          stopEdge();
          return;
        }
        callbacks.current.scrollBy(speed);
      }, EDGE_MS);
    };

    const finish = (commit: boolean) => {
      clearHold();
      stopEdge();
      const state = current.current;
      lifted = false;
      setCurrent(null);
      if (!commit || !state) return;
      if (state.overShelfId) callbacks.current.onDrop(bookId, state.overShelfId);
      // Dropped on nothing: the book stays put, which is the forgiving answer
      // and the one a misjudged drag wants.
    };

    const responder = PanResponder.create({
      // The grip is its own small view, so claiming its touches takes nothing
      // away from the cover it sits on.
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      /*
       * Refuses to hand the gesture over once it has it.
       *
       * The shelves live in a `FlatList`, and on Android a scroll view asks
       * for the responder the moment a finger moves. Saying yes mid-drag is
       * the book snapping back to where it started.
       */
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,

      onPanResponderGrant: (event) => {
        const { pageX, pageY } = event.nativeEvent;
        lifted = false;
        held = setTimeout(() => {
          lifted = true;
          track(pageX, pageY);
        }, HOLD_MS);
      },
      onPanResponderMove: (event) => {
        const { pageX, pageY } = event.nativeEvent;
        if (!lifted) return;
        track(pageX, pageY);
        edgeScroll(pageY);
      },
      onPanResponderRelease: () => finish(true),
      onPanResponderTerminate: () => finish(false),
    });

    responders.current.set(bookId, responder);
    return responder;
  }, []);

  return { drag, handlersFor, measure, retainBoxes, setViewport, setScrollOffset };
}

/**
 * The lifted cover, following the finger.
 *
 * Takes the book by id from whatever the screen is currently showing rather
 * than from a copy captured when the drag started, so a cover that changes
 * mid-drag — a copy finishing, say — is drawn as it actually is.
 *
 * Drawn over everything and taking no touches, so the responder underneath
 * keeps receiving the gesture that is moving it.
 */
export function DragGhost({ drag, books }: { drag: DragState | null; books: Book[] }) {
  const book = drag ? books.find((b) => b.id === drag.bookId) : null;
  if (!drag || !book) return null;
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 999 }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          // Centred under the finger and lifted clear of it, so the cover is
          // not the thing hiding where you are about to put it.
          left: drag.x - 44,
          top: drag.y - 120,
          opacity: 0.92,
          transform: [{ rotate: '-3deg' }, { scale: 1.06 }],
        }}
      >
        <BookCover book={book} showEdge={false} showRibbon={false} showTag={false} />
      </Animated.View>
    </View>
  );
}
