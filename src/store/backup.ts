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

let backupTimer: ReturnType<typeof setTimeout> | undefined;
let burstStarted = 0;
onReadingDataChanged(() => {
  useBackup.setState({ pending: true });
  const now = Date.now();
  if (!burstStarted) burstStarted = now;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    burstStarted = 0;
    void useBackup.getState().run();
  }, Math.min(1500, Math.max(0, 30000 - (now - burstStarted))));
});
