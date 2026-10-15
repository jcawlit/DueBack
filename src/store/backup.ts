/**
 * Keeping the drive's copy of someone's reading data up to date.
 *
 * Runs after a scan, which is the moment the drive is both present and known
 * to be readable. Never in the way of anything: a backup that cannot be
 * written is a line on the Book screen, not a failure, and **returning a book
 * never waits on it** — the audio is on the drive already, and the writing is
 * safe on the phone whether or not the drive took a copy.
 */

import { create } from 'zustand';
import { SETTING_KEYS, getSetting, setSetting } from '@/db/schema';
import { applyPayload, collectPayload, isBackupPending, markSynced } from '@/db/sync';
import { ensureDeviceId } from '@/db/identity';
import { syncToDrive } from '@/lib/sync/driveSync';
import { isScanning } from '@/lib/scanBusy';
import { onReadingDataChanged } from '@/lib/sync/changes';
import { useNotes } from './notes';
import { useLibrary } from './library';

type BackupState = {
  /** The setting. On by default: the drive is where the books already are. */
  enabled: boolean;
  /** True while a round is in flight. */
  running: boolean;
  /** True when the phone holds writing the drive has not taken a copy of. */
  pending: boolean;
  lastAt: string | null;
  /** The last thing worth saying about it, for Settings. */
  status: string | null;
  /** Set when the drive holds a backup written by a newer version. */
  needsNewerApp: boolean;

  load: () => Promise<void>;
  setEnabled: (value: boolean) => void;
  refreshPending: () => Promise<void>;
  /** Reads the drive, merges, writes back. Safe to call when nothing applies. */
  run: (options?: { force?: boolean }) => Promise<void>;
};

let requestedDuringRun = false;

export const useBackup = create<BackupState>((set, get) => ({
  enabled: true,
  running: false,
  pending: true,
  lastAt: null,
  status: null,
  needsNewerApp: false,

  load: async () => {
    try {
      const [enabled, lastAt] = await Promise.all([
        getSetting(SETTING_KEYS.backupEnabled),
        getSetting(SETTING_KEYS.backupAt),
      ]);
      set({ enabled: enabled !== '0', lastAt });
      await get().refreshPending();
    } catch {
      // The defaults stand; nothing here is worth failing a launch over.
    }
  },

  setEnabled: (value) => {
    set({ enabled: value, pending: true });
    void setSetting(SETTING_KEYS.backupEnabled, value ? '1' : '0').then(() => { if (value) return get().run(); }).catch(() => {});
  },

  refreshPending: async () => {
    try {
      const libraryId = await getSetting(SETTING_KEYS.libraryId);
      const lastLibrary = await getSetting('backup.libraryId');
      set({ pending: libraryId !== lastLibrary || !get().lastAt || await isBackupPending(get().lastAt) });
    } catch {
      set({ pending: true });
    }
  },

  run: async (options) => {
    const { enabled, running } = get();
    if (running) { requestedDuringRun = true; return; }
    if (isScanning()) return;
    if (!enabled && !options?.force) return;

    const library = useLibrary.getState();
    const root = library.libraryRoot;
    /*
     * A library that lives on the phone has no drive to back up to — the
     * books and the writing are already in the same place, and the Android
     * backup rules carry both.
     */
    if (!root || library.libraryOnDevice || !library.driveConnected) return;

    set({ running: true });
    const startedAt = new Date().toISOString();
    try {
      await useNotes.getState().flush();
      const libraryId = await getSetting(SETTING_KEYS.libraryId);
      const [device, mine] = await Promise.all([ensureDeviceId(), collectPayload(libraryId ?? undefined)]);
      if (!libraryId) {
        set({ status: 'This library has no identity yet; scan it first.' });
        return;
      }

      const outcome = await syncToDrive(root.uri, libraryId, device, mine);

      /*
       * Whatever came back is applied even when the write failed. The read
       * happened and the merge is correct; refusing to keep it because the
       * drive would not take our half would throw away the other phone's
       * work for no reason.
       */
      if (outcome.merged) {
        const report = await applyPayload(outcome.merged);
        if (outcome.ok) await markSynced(outcome.merged);
        if (report.notes + report.characters + report.history + report.progress > 0) {
          await useLibrary.getState().refresh();
          const open = useNotes.getState().bookId;
          if (open) await useNotes.getState().load(open);
        }
      }

      if (outcome.ok) {
        const at = startedAt;
        await setSetting(SETTING_KEYS.backupAt, at);
        await setSetting('backup.libraryId', libraryId);
        set({ lastAt: at, status: outcome.message });
      } else {
        set({ status: outcome.message });
      }
      set({ needsNewerApp: !!outcome.needsNewerApp });
      if (outcome.needsNewerApp) {
        useLibrary.getState().showSlip({
          kind: 'note',
          stamp: 'NEWER BACKUP',
          text:
            'This drive holds reading data written by a newer version of Due Back. ' +
            'It has been left untouched — update the app to read it.',
        });
      }
      await get().refreshPending();
    } catch (err) {
      set({ status: `The drive backup failed: ${(err as Error)?.message ?? 'unknown error'}` });
    } finally {
      set({ running: false });
      if (requestedDuringRun) {
        requestedDuringRun = false;
        setTimeout(() => void get().run(), 0);
      }
    }
  },
}));

/**
 * When a change reaches the drive.
 *
 * Writing a note is rare and precious, so it goes almost at once — long
 * enough only to collect a burst of keystrokes and a Return into one write.
 *
 * Progress is neither. It moves every five seconds for as long as a book
 * plays, and each backup is a full read-merge-write-validate cycle in
 * synchronous file calls on a USB stick. Backing up per tick wrote a new
 * generation every few seconds of listening — the pruning kept the drive
 * tidy, which is how it went unnoticed, but the drive never stopped working.
 *
 * Ten minutes is the judgement: the phone already holds the position safely,
 * so the drive's copy is insurance against losing the phone rather than a
 * live mirror, and being a few minutes stale costs nothing. A note, a scan,
 * or a book going out or coming back all carry the latest position with them
 * anyway, because the whole set is written every time.
 */
const AUTHORED_DEBOUNCE_MS = 1_500;
const PROGRESS_INTERVAL_MS = 10 * 60 * 1_000;

let authoredTimer: ReturnType<typeof setTimeout> | undefined;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
let lastRunAt = 0;

/**
 * Drops any backup waiting to happen.
 *
 * For the drive going away — there is nothing to write to, and the change is
 * still marked pending, so the next scan picks it up. Also what lets a test
 * finish: a ten-minute timer keeps Node's event loop alive on its own.
 */
export function cancelScheduledBackup() {
  clearTimeout(authoredTimer);
  clearTimeout(progressTimer);
  authoredTimer = undefined;
  progressTimer = undefined;
}

async function runBackupNow() {
  lastRunAt = Date.now();
  await useBackup.getState().run();
}

onReadingDataChanged((kind) => {
  // Said straight away either way: the Book screen should read "pending" the
  // moment something is written, not when the drive gets around to it.
  useBackup.setState({ pending: true });

  if (kind === 'progress') {
    // One already waiting covers this one too.
    if (progressTimer) return;
    const wait = Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - lastRunAt));
    progressTimer = setTimeout(() => {
      progressTimer = undefined;
      void runBackupNow();
    }, wait);
    return;
  }

  clearTimeout(authoredTimer);
  authoredTimer = setTimeout(() => {
    authoredTimer = undefined;
    // A progress tick waiting its turn has just been covered.
    clearTimeout(progressTimer);
    progressTimer = undefined;
    void runBackupNow();
  }, AUTHORED_DEBOUNCE_MS);
});
