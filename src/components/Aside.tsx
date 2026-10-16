/**
 * What a section says when there is nothing in it yet.
 *
 * On the screen's own ground rather than on paper. It replaced `CardEmpty`,
 * which was the same idea in on-paper ink, when the notes came off the card
 * and the last thing using it went with them.
 */

import { Text } from 'react-native';
import { color, font, space } from '@/theme/tokens';

export function Aside({ children }: { children: string }) {
  return (
    <Text
      style={{
        fontFamily: font.sans,
        fontSize: 14,
        lineHeight: 21,
        color: color.faint,
        paddingVertical: space.md,
      }}
    >
      {children}
    </Text>
  );
}
