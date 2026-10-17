/**
 * Small bits of cross-screen chrome and preference.
 *
 * How much of the bottom of the screen is already occupied, so the floating
 * mini player can sit above it — the Library has a tall checked-out tray,
 * every other screen has nothing — and whether notes are shown in the
 * handwriting face.
 */

import { create } from 'zustand';
import { SETTING_KEYS, getSetting, setSetting } from '@/db/schema';
import { USB_SOURCE_ID } from '@/db/sources';

type UiState = {
  /** Height of whatever is pinned to the bottom of the current screen. */
  bottomObstruction: number;
  setBottomObstruction: (height: number) => void;

  /**
   * Whether the listener's own writing is shown in a handwriting face.
   *
   * **Off by default.** The idea was that a note in the margin should not
   * look like the app talking, and that still holds — but Caveat at note
   * length is tiring to read, and notes are re-read far more often than they
   * are written. Instrument Sans is the default; the handwriting is a choice
   * in Settings for anyone who wants it.
   */
  handwritten: boolean;
  setHandwritten: (value: boolean) => void;

  /**
   * Which source the Library is showing.
   *
   * `USB_SOURCE_ID` is the default and what every existing install starts
   * on. It is a preference rather than a navigation state because the
   * answer to "which library am I in" should survive closing the app.
   */
  activeSourceId: string;
  setActiveSourceId: (id: string) => void;

  /** Reads the stored preferences. Called once, at startup. */
  loadPreferences: () => Promise<void>;
};

export const useUi = create<UiState>((set) => ({
  bottomObstruction: 0,
  setBottomObstruction: (height) =>
    set((s) => (s.bottomObstruction === height ? s : { bottomObstruction: height })),

  handwritten: false,
  setHandwritten: (value) => {
    set({ handwritten: value });
    void setSetting(SETTING_KEYS.handwrittenNotes, value ? '1' : '0').catch(() => {});
  },
  activeSourceId: USB_SOURCE_ID,
  setActiveSourceId: (id) => {
    set({ activeSourceId: id });
    void setSetting(SETTING_KEYS.activeSourceId, id).catch(() => {});
  },

  loadPreferences: async () => {
    try {
      const source = await getSetting(SETTING_KEYS.activeSourceId);
      if (source) set({ activeSourceId: source });
    } catch {
      // The drive is the default, and the default is fine.
    }
    try {
      const stored = await getSetting(SETTING_KEYS.handwrittenNotes);
      /*
       * Absent means never chosen, so the default stands. Anyone who turned
       * the handwriting on before it stopped being the default has a stored
       * '1' and keeps it: the default changed, their choice did not.
       */
      if (stored !== null) set({ handwritten: stored !== '0' });
    } catch {
      // The default stands.
    }
  },
}));
