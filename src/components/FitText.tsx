/**
 * One line of text that shrinks rather than wraps or truncates.
 *
 * For the places where the string is not ours to shorten — a server's library
 * name, say. "My Audiobooks" at the Library title's 26pt broke across two
 * lines and pushed the whole header down; the subtitle, already held to one
 * line, lost its end to an ellipsis instead.
 *
 * Measures the room it has been given and sizes the text to it. The parent
 * therefore has to be the one with the width — `flex: 1`, not `flexShrink` —
 * or the measurement is of the text's own width and says nothing.
 */

import { useState } from 'react';
import { Text, View, type StyleProp, type TextStyle } from 'react-native';
import { fittedText, type GlyphWidth } from '@/lib/fitText';

export function FitText({
  children,
  size,
  minSize,
  face,
  lineHeightRatio = 1.1,
  style,
  accessibilityRole,
}: {
  children: string;
  /** The size it wears when there is room, which is almost always. */
  size: number;
  /** The smallest it will go. Below this, truncating beats squinting. */
  minSize: number;
  face: GlyphWidth;
  lineHeightRatio?: number;
  style?: StyleProp<TextStyle>;
  accessibilityRole?: 'header';
}) {
  const [available, setAvailable] = useState(0);
  /*
   * The size shrinks; the line height stays at the full size's, so the box
   * does not change height with the string in it. See `fittedText`.
   */
  const fitted = fittedText(children, available, size, minSize, face, lineHeightRatio);

  return (
    // The wrapper is what has the width; the Text inside is sized to it.
    <View onLayout={(e) => setAvailable(e.nativeEvent.layout.width)}>
      <Text
        accessibilityRole={accessibilityRole}
        numberOfLines={1}
        /*
         * Still capped at one line. The estimate can be a glyph or two out on
         * a proportional face, and wrapping is the failure being prevented —
         * so if it is wrong, it is wrong by an ellipsis rather than by a
         * second line reflowing the header.
         */
        style={[style, fitted]}
      >
        {children}
      </Text>
    </View>
  );
}
