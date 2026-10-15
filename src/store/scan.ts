/**
 * Scan state, kept out of the library store so a long scan's progress updates
 * never re-render the shelves.
 */

import { create } from 'zustand';
import { isReachable, pickLibraryRoot } from '@/lib/files/access';
import { scanLibrary, type ScanProgress, type ScanResult } from '@/lib/scan/scanner';
import { setScanning } from '@/lib/scanBusy';
import { useLibrary } from './library';
import { useBackup } from './backup';

type ScanState = {
  running: boolean;
  /**
   * True between the folder picker closing and the scan proper starting.
   *
   * Choosing a folder saves it, proves it is readable and only then begins —
   * and on a real drive those first two steps take seconds. Nothing reported
   * them, so the app sat still immediately after the one action in the product
   * that most needs an acknowledgement.
   */
  preparing: boolean;
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

/** The first thing shown, before the scanner has reported anything of its own. */
const OPENING_PROGRESS: ScanProgress = {
  phase: 'listing',
  message: 'Reading the drive…',
  booksTotal: 0,
  booksDone: 0,
  filesSeen: 0,
  skippedUnsupported: 0,
  errors: 0,
};

export const useScan = create<ScanState>((set, get) => ({
  running: false,
  preparing: false,
  progress: null,
  lastResult: null,
  error: null,
  cancelRequested: false,

  chooseFolderAndScan: async () => {
    set({ error: null });
    const root = await pickLibraryRoot();
    if (!root) return;
    // Say something the instant the picker closes. Saving the root checks that
    // it is readable, which on a large drive is a wait of its own.
    set({ preparing: true, progress: OPENING_PROGRESS });
    try {
      // Claimed before `setLibraryRoot`, which reports the drive as connected
      // and would otherwise kick off an incremental scan that blocks this
      // forced one.
      syncedRoot = root.uri;
      await useLibrary.getState().setLibraryRoot(root);
      await get().rescan({ force: true });
    } finally {
      set({ preparing: false });
    }
  },

  rescan: async (options = {}) => {
    const root = useLibrary.getState().libraryRoot;
    if (!root) {
      set({ error: 'No library folder chosen yet.' });
      return;
    }
    if (get().running) return;

    // Marked as running before anything is checked: proving a USB root can be
    // listed takes a moment of its own, and that moment used to pass with
    // nothing on screen at all.
    set({ running: true, error: null, cancelRequested: false, progress: OPENING_PROGRESS });
    // Announced outside the store so the library store can wait for it without
    // importing this one, which would be a cycle.
    setScanning(true);
    try {
      /*
       * Refuse outright when the folder cannot be read — the defence the user
       * sees. The scanner declines to reconcile either way, so nothing is
       * marked missing; refusing here is what makes the message honest rather
       * than "0 books found".
       */
      if (!(await isReachable(root.uri))) {
        set({ error: "The library folder couldn't be read. Is the drive connected?" });
        useLibrary.setState({ driveConnected: false });
        syncedRoot = null;
        return;
      }

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
      // Asked after the refresh, so the books named in the question are the
      // ones on screen behind it.
      if (result.reconnectQuestions.length > 0) {
        useLibrary.getState().askReconnect(result.reconnectQuestions);
      }

      /*
       * The drive is present and has just been proved readable, which is the
       * one moment a backup is certain to be worth attempting. Not awaited:
       * nothing about the scan's result depends on it, and a slow drive must
       * not hold the library screen.
       */
      if (result.completed && result.rootReadable) {
        setTimeout(() => void useBackup.getState().run(), 0);
      }
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
