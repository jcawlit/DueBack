/**
 * Something the listener wrote, in their own hand.
 *
 * The only place `font.hand` is allowed. Names, times, tags and controls keep
 * the app's own faces — the whole point of the handwriting is that it marks
 * what the app did not write, which stops being true the moment the app
 * writes in it too.
 *
 * Instrument Sans is the default; the handwriting is a setting. Caveat sits
 * small for its point size, so a handwritten line is set larger than the same
 * line in Sans. Both are passed one `size`, meaning "as big as body copy",
 * and this decides what that costs in each face — the compensation applies
 * to Caveat only, so Sans renders at exactly the size it was asked for.
 */

import { Text, type StyleProp, type TextStyle } from 'react-native';
import { color, font } from '@/theme/tokens';
import { useUi } from '@/store/ui';

/** Caveat's x-height is about three quarters of Instrument Sans's. */
const HAND_SCALE = 1.35;

export function NoteText({
  children,
  size = 15,
  tone = 'paper',
  numberOfLines,
  style,
}: {
  children: string;
  size?: number;
  tone?: 'paper' | 'muted';
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}) {
  const handwritten = useUi((s) => s.handwritten);
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: handwritten ? font.hand : font.sans,
          fontSize: handwritten ? Math.round(size * HAND_SCALE) : size,
          lineHeight: Math.round(size * (handwritten ? 1.6 : 1.45)),
          color: tone === 'muted' ? color.muted : color.paper,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** The same face, for a field being typed into. */
export function useNoteFont(size = 16) {
  const handwritten = useUi((s) => s.handwritten);
  return {
    fontFamily: handwritten ? font.hand : font.sans,
    fontSize: handwritten ? Math.round(size * HAND_SCALE) : size,
  };
}
