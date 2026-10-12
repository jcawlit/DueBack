/**
 * Scan state, kept out of the library store so a long scan's progress updates
 * never re-render the shelves.
 */

import { create } from 'zustand';
import { isReachable, pickLibraryRoot } from '@/lib/files/access';
import { scanLibrary, type ScanProgress, type ScanResult } from '@/lib/scan/scanner';
import { setScanning } from '@/lib/scanBusy';
import { useLibrary } from './library';

type ScanState = {
  running: boolean;
  progress: ScanProgress | null;
  lastResult: ScanResult | null;
  error: string | null;
  cancelRequested: boolean;

  /** Opens the folder picker, saves the root, and scans it. */
  chooseFolderAndScan: () => Promise<void>;
  /** Rescans the saved root. `force` re-reads even unchanged books. */
  rescan: (options?: { force?: boolean }) => Promise<void>;
  /**
   * Re-syncs the index because the drive has just appeared. Does nothing if
   * this root has already been synced since it was last away.
   */
  syncOnConnect: (rootUri: string) => Promise<void>;
  /** The drive has gone; the next time it appears, sync again. */
  forgetSync: () => void;
  cancel: () => void;
  /** Dismisses the last scan error, so a retry starts from a clean slate. */
  clearError: () => void;
};

/**
 * The root last re-synced since the drive appeared.
 *
 * Module-level rather than store state because nothing renders it, and because
 * `chooseFolderAndScan` has to claim it before its own forced scan — otherwise
 * the connect-triggered incremental scan wins the race and the forced one is
 * dropped, leaving a freshly picked folder only half re-read.
 */
let syncedRoot: string | null = null;

export const useScan = create<ScanState>((set, get) => ({
  running: false,
  progress: null,
  lastResult: null,
  error: null,
  cancelRequested: false,

  chooseFolderAndScan: async () => {
    set({ error: null });
    const root = await pickLibraryRoot();
    if (!root) return;
    // Claimed before `setLibraryRoot`, which reports the drive as connected and
    // would otherwise kick off an incremental scan that blocks this forced one.
    syncedRoot = root.uri;
    await useLibrary.getState().setLibraryRoot(root);
    await get().rescan({ force: true });
  },

  rescan: async (options = {}) => {
    const root = useLibrary.getState().libraryRoot;
    if (!root) {
      set({ error: 'No library folder chosen yet.' });
      return;
    }
    if (get().running) return;

    /*
     * Refuse outright when the folder cannot be read.
     *
     * This is the first of two defences, and the one the user sees. Without
     * it, pressing Rescan with the drive unplugged walked an empty tree and
     * reported "0 books found", which is a lie about a library that is merely
     * out of reach. The scanner declines to reconcile in that case as well, so
     * nothing is marked missing either way — but refusing here means the
     * message says what is actually wrong.
     */
    if (!(await isReachable(root.uri))) {
      set({ error: "The library folder couldn't be read. Is the drive connected?" });
      useLibrary.setState({ driveConnected: false });
      syncedRoot = null;
      return;
    }

    set({ running: true, error: null, cancelRequested: false, progress: null });
    // Announced outside the store so the library store can wait for it without
    // importing this one, which would be a cycle.
    setScanning(true);
    try {
      const result = await scanLibrary({
        rootUri: root.uri,
        force: options.force,
        onProgress: (progress) => set({ progress }),
        shouldCancel: () => get().cancelRequested,
      });
      set({ lastResult: result });

      // An unreadable root is not an empty library.
      //
      // `listTree` does not throw when the root has gone — it records an
      // unreadable folder and returns nothing — so a rescan with the drive
      // unplugged used to look exactly like a scan of a library with no books
      // in it. The scanner no longer reconciles on that, and here the user is
      // told what actually happened instead of being shown "0 books found".
      if (!result.rootReadable) {
        set({ error: "The library folder couldn't be read. Is the drive connected?" });
        useLibrary.setState({ driveConnected: false });
        // Not in step with anything, so the next connection re-syncs.
        syncedRoot = null;
        return;
      }

      // A scan of any kind counts as being in step with the drive — but only a
      // scan that ran to the end. A cancelled one leaves the index half read.
      if (result.completed) syncedRoot = root.uri;
      else syncedRoot = null;

      await useLibrary.getState().refresh();
    } catch (err) {
      set({ error: (err as Error)?.message ?? 'The scan failed.' });
    } finally {
      setScanning(false);
      set({ running: false, cancelRequested: false });
    }
  },

  syncOnConnect: async (rootUri) => {
    if (syncedRoot === rootUri || get().running) return;
    syncedRoot = rootUri;
    await get().rescan();
  },

  forgetSync: () => {
    syncedRoot = null;
  },

  cancel: () => set({ cancelRequested: true }),

  clearError: () => set({ error: null }),
}));
