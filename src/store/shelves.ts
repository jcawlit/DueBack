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
  createShelf,
  loadShelves,
  placeBookOnShelf,
  removeBookFromShelves,
  renameShelf,
  softDeleteShelf,
  type Shelf,
} from '@/db/shelves';

type ShelvesState = {
  /** For the source the Library is currently showing. */
  shelves: Shelf[];
  /** Which source `shelves` was loaded for, so a stale load is ignored. */
  loadedFor: string | null | undefined;
  /**
   * Arranging rather than browsing.
   *
   * Not a preference: it is a mode you are in for a minute, and coming back
   * to the app mid-drag-mode would be a surprise rather than a convenience.
   * It also decides what press-and-hold does, and a gesture that means
   * something different depending on state the app remembered from yesterday
   * is how a listener loses a book.
   */
  editing: boolean;

  setEditing: (value: boolean) => void;
  load: (sourceId: string | null) => Promise<void>;
  add: (sourceId: string | null, name: string) => Promise<void>;
  rename: (shelfId: string, name: string) => Promise<void>;
  remove: (shelfId: string) => Promise<void>;
  /** Puts a book on a shelf, at the end of it. */
  place: (bookId: string, shelfId: string) => Promise<void>;
  /** Takes a book off whatever shelf it was on. */
  unplace: (bookId: string) => Promise<void>;
};

export const useShelves = create<ShelvesState>((set, get) => ({
  shelves: [],
  loadedFor: undefined,
  editing: false,

  setEditing: (editing) => set({ editing }),

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
    await softDeleteShelf(shelfId);
    await get().load(get().loadedFor ?? null);
  },

  place: async (bookId, shelfId) => {
    const shelf = get().shelves.find((s) => s.id === shelfId);
    const last = shelf?.bookIds[shelf.bookIds.length - 1] ?? null;
    // Appended, so a drop lands at the end of the shelf it was dropped on.
    // Where within a shelf is not something a drop onto a row of three covers
    // can say, and guessing from an x coordinate would be guessing.
    await placeBookOnShelf(bookId, shelfId, last, null);
    await get().load(get().loadedFor ?? null);
  },

  unplace: async (bookId) => {
    await removeBookFromShelves(bookId);
    await get().load(get().loadedFor ?? null);
  },
}));
