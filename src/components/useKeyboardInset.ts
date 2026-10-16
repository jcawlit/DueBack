/**
 * How much of the screen the keyboard is covering, on Android.
 *
 * At this target SDK Android runs edge-to-edge, and an edge-to-edge window is
 * **not resized** when the IME opens — the keyboard's height arrives as an
 * inset instead. Anything anchored to the bottom of a modal therefore stays
 * exactly where it was and the keyboard opens straight over the top of it.
 * A `KeyboardAvoidingView` cannot help: there is no resize for it to follow.
 *
 * So the sheets read the height themselves and pad their own bottom by it.
 *
 * Two details matter for it to feel like one motion rather than two:
 *
 * - **The last height is remembered.** Android only reports `keyboardDidShow`,
 *   which lands *after* the keyboard has finished rising. A sheet that waits
 *   for it sits under the keyboard for the length of that animation and then
 *   jumps. Seeding from the last measurement means the sheet is already in
 *   the right place as the keyboard arrives. It is a remembered measurement,
 *   not a guess, and the first open on a new device corrects itself.
 * - **The change is handed to `LayoutAnimation`** with the keyboard's own
 *   duration and easing, so where a move is still needed it matches the
 *   keyboard rather than snapping against it.
 *
 * iOS resizes properly and keeps its `KeyboardAvoidingView`, so this reports
 * zero there and nothing doubles up.
 */

import { useEffect, useState } from 'react';
import { Keyboard, LayoutAnimation, Platform } from 'react-native';

/**
 * The last height the keyboard reported, for the next sheet that opens.
 *
 * Module scope on purpose: it outlives any one sheet, and every sheet in the
 * app shares a keyboard.
 */
let lastHeight = 0;

/** What a sheet should assume before the keyboard has said anything. */
export function rememberedKeyboardHeight(): number {
  return Platform.OS === 'android' ? lastHeight : 0;
}

export function useKeyboardInset(active: boolean): number {
  /*
   * Seeded from the last measurement, and only ever written from a keyboard
   * event afterwards. Both sheets are keyed on what they are showing, so
   * each one mounts fresh as it opens and takes the seed with it — which is
   * why this needs no resetting when `active` turns over.
   */
  const [height, setHeight] = useState(rememberedKeyboardHeight);

  useEffect(() => {
    if (Platform.OS !== 'android' || !active) return;

    const follow = (next: number, duration?: number) => {
      // The keyboard's own curve, so a correction looks like part of it.
      if (duration) {
        LayoutAnimation.configureNext({
          duration,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setHeight(next);
    };

    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      lastHeight = event.endCoordinates.height;
      follow(lastHeight, event.duration);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', (event) => {
      follow(0, event?.duration);
    });

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [active]);

  if (Platform.OS !== 'android' || !active) return 0;
  return height;
}
