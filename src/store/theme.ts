/**
 * Which colour scheme is in force.
 *
 * Two things have to happen when it changes, and they are different jobs:
 *
 * 1. The colours themselves swap, by replacing the values inside the `color`
 *    object every module already imported. That costs nothing and touches no
 *    call site — see `src/theme/tokens.ts`.
 * 2. Something has to re-render, or the app keeps the colours it last painted
 *    with. That is what this store is for: a screen subscribing to `themeId`
 *    runs again when it changes, and everything it renders runs with it.
 *
 * Which is why the id is held here rather than only inside `tokens.ts`. A
 * plain module variable would swap the colours silently and leave the screen
 * showing the old ones.
 */

import { create } from 'zustand';
import { SETTING_KEYS, getSetting, setSetting } from '@/db/schema';
import { applyPalette } from '@/theme/tokens';
import { DEFAULT_THEME, themeById, type ThemeId } from '@/theme/palettes';

type ThemeState = {
  themeId: ThemeId;
  /**
   * Bumped on every change.
   *
   * `Shelf` is memoised — deliberately, because redrawing every mounted shelf
   * as the list scrolls is what made scrolling stutter — so it does not re-run
   * just because its parent did. Passing this to it gives `memo` something
   * that actually differs when the colours have, and it is the only reason
   * this number exists.
   */
  version: number;
  setTheme: (id: ThemeId) => void;
  /** Reads the stored choice. Called once, at startup. */
  load: () => Promise<void>;
};

export const useTheme = create<ThemeState>((set, get) => ({
  themeId: DEFAULT_THEME,
  version: 0,

  setTheme: (id) => {
    if (get().themeId === id) return;
    applyPalette(themeById(id).palette);
    set((s) => ({ themeId: id, version: s.version + 1 }));
    void setSetting(SETTING_KEYS.themeId, id).catch(() => {});
  },

  load: async () => {
    try {
      const stored = await getSetting(SETTING_KEYS.themeId);
      if (!stored || stored === get().themeId) return;
      const theme = themeById(stored);
      /*
       * Matched against the real list rather than trusted. A stored id from a
       * build that had a scheme this one does not falls back to the first,
       * which is a scheme that exists — where trusting the string would hand
       * every component `undefined` for every colour.
       */
      applyPalette(theme.palette);
      set((s) => ({ themeId: theme.id, version: s.version + 1 }));
    } catch {
      // The default is a complete palette, so there is nothing to recover.
    }
  },
}));
