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
   * Whether the hint that press-and-hold checks a book out has been seen.
   *
   * There used to be a "+" in the corner of every cover. It went, for good
   * reasons — it sat on the art and duplicated a tag — but it was also the
   * only visible sign that a book could be taken at all. A gesture nobody
   * is told about is a feature nobody has.
   *
   * Set when the hint is dismissed, and also the moment anything is
   * checked out: whoever has done it once does not need telling.
   */
  checkoutHintDone: boolean;
  markCheckoutHintDone: () => void;

  /**
   * Whether the checked-out tray is shut down to its header row.
   *
   * A preference rather than screen state, for the same reason the active
   * source is: the tray is most of the bottom third of the Library, and
   * someone who has pushed it shut to see their shelves did not mean "until
   * I next open the app". What stays visible when it is shut is the line that
   * matters — how many books and how much of the budget they use.
   */
  trayCollapsed: boolean;
  setTrayCollapsed: (value: boolean) => void;

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

  checkoutHintDone: false,
  markCheckoutHintDone: () => {
    if (useUi.getState().checkoutHintDone) return;
    set({ checkoutHintDone: true });
    void setSetting(SETTING_KEYS.checkoutHintDone, '1').catch(() => {});
  },

  trayCollapsed: false,
  setTrayCollapsed: (value) => {
    set({ trayCollapsed: value });
    void setSetting(SETTING_KEYS.trayCollapsed, value ? '1' : '0').catch(() => {});
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
      const hint = await getSetting(SETTING_KEYS.checkoutHintDone);
      if (hint === '1') set({ checkoutHintDone: true });
    } catch {
      // Showing the hint once more is a smaller cost than hiding it wrongly.
    }
    try {
      const tray = await getSetting(SETTING_KEYS.trayCollapsed);
      if (tray !== null) set({ trayCollapsed: tray === '1' });
    } catch {
      // Open is the default, and an open tray is never the wrong guess.
    }
  },
}));
