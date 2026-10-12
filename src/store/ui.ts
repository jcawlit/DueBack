/**
 * Small bits of cross-screen chrome state.
 *
 * The only thing here is how much of the bottom of the screen is already
 * occupied, so the floating mini player can sit above it. The Library has a
 * tall checked-out tray; every other screen has nothing.
 */

import { create } from 'zustand';

type UiState = {
  /** Height of whatever is pinned to the bottom of the current screen. */
  bottomObstruction: number;
  setBottomObstruction: (height: number) => void;
};

export const useUi = create<UiState>((set) => ({
  bottomObstruction: 0,
  setBottomObstruction: (height) =>
    set((s) => (s.bottomObstruction === height ? s : { bottomObstruction: height })),
}));
