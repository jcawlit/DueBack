/**
 * The shelves the listener arranged, and whether they are being arranged now.
 *
 * Its own store rather than part of `library`: the Library re-renders the
 * whole shelf list when that one changes, and a drag updates state on every
 * frame of a finger moving. Keeping the two apart is the same reasoning that
 * put scan progress in `scan`.
 */

import { create } from 'zustand';
import {
  applyArrangement,
  createShelf,
  loadShelves,
  removeBookFromShelves,
  renameShelf,
  softDeleteShelf,
  type Shelf,
} from '@/db/shelves';
import {
  cascade,
  placementChanges,
  SHELF_CAPACITY,
  withoutShelf,
} from '@/lib/library/cascade';

type ShelvesState = {
  /** For the source the Library is currently showing. */
  shelves: Shelf[];
  /** Which source `shelves` was loaded for, so a stale load is ignored. */
  loadedFor: string | null | undefined;
  // There was an `editing` mode here. The grip on each cover replaced it:
  // a gesture of its own needs no mode to tell it apart from another.
  load: (sourceId: string | null) => Promise<void>;
  add: (sourceId: string | null, name: string) => Promise<void>;
  rename: (shelfId: string, name: string) => Promise<void>;
  remove: (shelfId: string) => Promise<void>;
  /** Puts a book on a shelf, at the end of it. */
  place: (bookId: string, shelfId: string) => Promise<void>;
  /** Takes a book off whatever shelf it was on. */
  unplace: (bookId: string) => Promise<void>;
  /**
   * Creates the starting shelves, once, if this source has none.
   *
   * Returns whether it made any, so the caller knows to reload.
   */
  seed: (
    sourceId: string | null,
    shelves: { name: string; bookIds: string[] }[],
  ) => Promise<boolean>;
};

export const useShelves = create<ShelvesState>((set, get) => ({
  shelves: [],
  loadedFor: undefined,

  load: async (sourceId) => {
    try {
      const shelves = await loadShelves(sourceId);
      /*
       * Checked after the await, not before. Switching source mid-read would
       * otherwise paint one library's shelves under another's books, which is
       * the kind of bug that looks like data loss.
       */
      set({ shelves, loadedFor: sourceId });
    } catch {
      // An unreadable shelf table is not worth breaking the Library over:
      // custom mode simply has nothing in it until the next load succeeds.
      set({ shelves: [], loadedFor: sourceId });
    }
  },

  add: async (sourceId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await createShelf(sourceId, trimmed);
    await get().load(sourceId);
  },

  rename: async (shelfId, name) => {
    const trimmed = name.trim();
    // An empty name would leave a shelf you cannot tell apart from the next
    // one, and the field it came from is easy to clear by accident.
    if (!trimmed) return;
    await renameShelf(shelfId, trimmed);
    await get().load(get().loadedFor ?? null);
  },

  remove: async (shelfId) => {
    /*
     * The shelf goes; its books do not.
     *
     * `softDeleteShelf` tombstones the placements with it, which was right
     * when there was a loose pile to catch them. There is not one now, so
     * they are moved onto the remaining shelves **first** — and anything
     * that will not fit gets a shelf of its own, because a book with no
     * shelf is a book that has left the Library.
     */
    const sourceId = get().loadedFor ?? null;
    const before = get().shelves.map((s) => ({ id: s.id, bookIds: s.bookIds }));
    const { shelves: after, overflow } = withoutShelf(before, shelfId);

    const changes = placementChanges(before, { shelves: after, loose: [] })
      // The deleted shelf's own rows are rewritten below or carried into
      // `overflow`; nothing here should point at a shelf that is going.
      .filter((change) => change.shelfId !== shelfId);
    if (changes.length > 0) await applyArrangement(changes);

    for (let i = 0; i < overflow.length; i += SHELF_CAPACITY) {
      const made = await createShelf(sourceId, 'Shelf');
      await applyArrangement(
        overflow
          .slice(i, i + SHELF_CAPACITY)
          .map((bookId, position) => ({ bookId, shelfId: made.id, position })),
      );
    }

    await softDeleteShelf(shelfId);
    await get().load(sourceId);
  },

  place: async (bookId, shelfId) => {
    /*
     * The same arithmetic the drag has been drawing all along.
     *
     * `cascade` is pure and the Library renders its result on every frame of
     * a drag, so committing through it means what is written is exactly what
     * was on screen when the finger came up. Two code paths for "where does
     * this book go" would be two chances to disagree.
     */
    const before = get().shelves.map((s) => ({ id: s.id, bookIds: s.bookIds }));
    const after = cascade(before, bookId, shelfId);
    await applyArrangement(placementChanges(before, after));
    await get().load(get().loadedFor ?? null);
  },

  unplace: async (bookId) => {
    await removeBookFromShelves(bookId);
    await get().load(get().loadedFor ?? null);
  },

  seed: async (sourceId, shelves) => {
    /*
     * Only ever on an empty source, and read from the database rather than
     * from this store's state: the guard has to hold against a second call
     * arriving while the first is still writing, or opening custom mode
     * twice in quick succession seeds the library twice.
     */
    const existing = await loadShelves(sourceId);
    if (existing.length > 0 || shelves.length === 0) return false;

    for (const shelf of shelves) {
      const made = await createShelf(sourceId, shelf.name);
      await applyArrangement(
        shelf.bookIds.map((bookId, position) => ({ bookId, shelfId: made.id, position })),
      );
    }
    await get().load(sourceId);
    return true;
  },
}));
