/**
 * What a shelf of three looks like after a fourth book is pushed onto it.
 *
 * A shelf is one ledge and holds three face-out covers, which is what the
 * drawing has always been. Pushing a book onto a full one sends the book at
 * the far end down to the shelf below, which sends its last book down in
 * turn, and whatever falls off the bottom goes back to the loose pile. No
 * book is ever lost, and nothing is created to catch one.
 *
 * Pure, and the drag renders its result on every frame so the cascade is
 * visible while a finger is still moving. That is also why it has to be
 * cheap: it runs many times a second and never touches the database.
 */

/** A shelf as this works on it: an id and the books on it, in order. */
// Relative, with the extension, as `grouping.ts` imports its parser: the
// `@/` alias is Metro's and Node's test runner cannot resolve it. A
// type-only import would have been erased and got away with it; this is a
// value.
import { PER_SHELF } from '../shelves.ts';

export type Arrangement = { id: string; bookIds: string[] };

/**
 * One ledge of face-out covers.
 *
 * Taken from the number the shelves are drawn with rather than written
 * again, so the capacity and the drawing cannot drift apart.
 */
export const SHELF_CAPACITY = PER_SHELF;

/**
 * Takes a book off whatever shelf it is on, leaving the rest in order.
 *
 * Every placement starts here. A book being dragged within its own shelf
 * would otherwise be counted twice and push one of its neighbours off for no
 * reason.
 */
export function withoutBook(shelves: Arrangement[], bookId: string): Arrangement[] {
  return shelves.map((shelf) => ({
    id: shelf.id,
    bookIds: shelf.bookIds.filter((id) => id !== bookId),
  }));
}

export type Cascade = {
  shelves: Arrangement[];
  /**
   * Books pushed off the bottom shelf, in the order they fell.
   *
   * They belong to no shelf now, which in the Library is the loose pile at
   * the bottom. Returned rather than silently dropped so the caller can see
   * what it has to write.
   */
  loose: string[];
};

/**
 * Pushes a book onto a shelf, and lets the overflow fall.
 *
 * The book goes on at the **front**, and it is the far end of the shelf that
 * falls. Putting it at the back would make the book you just dropped the one
 * that overflows, which is the one thing a drop must never do.
 *
 * A target that does not exist leaves everything alone, which is what a drop
 * onto a shelf deleted on another phone mid-drag should do.
 */
export function cascade(
  shelves: Arrangement[],
  bookId: string,
  targetShelfId: string,
): Cascade {
  const lifted = withoutBook(shelves, bookId);
  const at = lifted.findIndex((shelf) => shelf.id === targetShelfId);
  if (at === -1) return { shelves: lifted, loose: [] };

  const out = lifted.map((shelf) => ({ id: shelf.id, bookIds: [...shelf.bookIds] }));
  const loose: string[] = [];

  /*
   * Carried down a shelf at a time: whatever will not fit here goes onto
   * the front of the next, which may push its own last books along.
   *
   * A list rather than a single book, because a shelf can arrive holding
   * more than three — a merge from another phone can do it — and carrying
   * one at a time would leave the overfill in place for ever. Popped from
   * the end, unshifted at the front, so the order along the shelves is the
   * order the books were already in.
   */
  let carrying: string[] = [bookId];
  for (let i = at; i < out.length && carrying.length > 0; i += 1) {
    out[i].bookIds.unshift(...carrying);
    carrying = [];
    while (out[i].bookIds.length > SHELF_CAPACITY) {
      carrying.unshift(out[i].bookIds.pop()!);
    }
  }
  loose.push(...carrying);

  return { shelves: out, loose };
}

export type Placement = { bookId: string; shelfId: string | null; position: number };

/**
 * Which books ended up somewhere different, and where.
 *
 * Only the differences, because every one is a row written to the database
 * and a cascade usually moves two or three books out of hundreds.
 */
export function placementChanges(
  before: Arrangement[],
  after: Cascade,
): Placement[] {
  const was = new Map<string, { shelfId: string; position: number }>();
  for (const shelf of before) {
    shelf.bookIds.forEach((id, position) => was.set(id, { shelfId: shelf.id, position }));
  }

  const changes: Placement[] = [];
  for (const shelf of after.shelves) {
    shelf.bookIds.forEach((bookId, position) => {
      const previous = was.get(bookId);
      if (previous?.shelfId === shelf.id && previous.position === position) return;
      changes.push({ bookId, shelfId: shelf.id, position });
    });
  }
  for (const bookId of after.loose) {
    // Already loose and still loose is not a change worth a write.
    if (!was.has(bookId)) continue;
    changes.push({ bookId, shelfId: null, position: 0 });
  }
  return changes;
}

/**
 * Taking a shelf away without taking its books away.
 *
 * A deleted shelf used to tombstone its books' placements too, which was
 * right while there was a loose pile for them to fall into. There is not any
 * more — every book is on a shelf — so orphaning them meant they vanished
 * from the Library entirely. The books belonged to the listener; the shelf
 * was only a label on a ledge.
 *
 * They move onto the shelf that took its place, from the front, in the order
 * they were in. Capacity pushes the surplus down the shelves below, and
 * anything still carrying at the bottom needs a shelf of its own — the
 * caller makes those, which is why they come back as `overflow` rather than
 * being quietly dropped.
 */
export function withoutShelf(
  shelves: Arrangement[],
  shelfId: string,
): { shelves: Arrangement[]; overflow: string[] } {
  const at = shelves.findIndex((shelf) => shelf.id === shelfId);
  if (at === -1) return { shelves, overflow: [] };

  const orphans = shelves[at].bookIds;
  const rest = shelves
    .filter((shelf) => shelf.id !== shelfId)
    .map((shelf) => ({ id: shelf.id, bookIds: [...shelf.bookIds] }));

  if (orphans.length === 0 || rest.length === 0) {
    return { shelves: rest, overflow: rest.length === 0 ? [...orphans] : [] };
  }

  /*
   * Onto the shelf that is now in its place, or the last one if it was the
   * bottom shelf. Pushed in reverse so the first orphan ends up first.
   */
  const target = Math.min(at, rest.length - 1);
  let carrying = [...orphans];
  for (let i = target; i < rest.length && carrying.length > 0; i += 1) {
    rest[i].bookIds.unshift(...carrying);
    carrying = [];
    while (rest[i].bookIds.length > SHELF_CAPACITY) {
      carrying.unshift(rest[i].bookIds.pop()!);
    }
  }
  return { shelves: rest, overflow: carrying };
}
