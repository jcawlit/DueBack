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
  loadPreferences: async () => {
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
