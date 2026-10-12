/**
 * Scan state, kept out of the library store so a long scan's progress updates
 * never re-render the shelves.
 */

import { create } from 'zustand';
import { pickLibraryRoot } from '@/lib/files/access';
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
      // A scan of any kind counts as being in step with the drive.
      syncedRoot = root.uri;
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
}));
