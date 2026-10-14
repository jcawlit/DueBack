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

export const useBackup = create<BackupState>((set, get) => ({
  enabled: true,
  running: false,
  pending: false,
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
    set({ enabled: value });
    void setSetting(SETTING_KEYS.backupEnabled, value ? '1' : '0').catch(() => {});
  },

  refreshPending: async () => {
    try {
      set({ pending: await isBackupPending(get().lastAt) });
    } catch {
      // Unknown is shown as "not pending": claiming work is outstanding when
      // we cannot tell would put a worried line on every Book screen.
    }
  },

  run: async (options) => {
    const { enabled, running } = get();
    if (running) return;
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
    try {
      const [device, mine] = await Promise.all([ensureDeviceId(), collectPayload()]);
      const libraryId = await getSetting(SETTING_KEYS.libraryId);
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
        await markSynced(outcome.merged);
        if (report.notes + report.characters + report.history > 0) {
          await useLibrary.getState().refresh();
        }
      }

      if (outcome.ok) {
        const at = new Date().toISOString();
        await setSetting(SETTING_KEYS.backupAt, at);
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
    }
  },
}));
