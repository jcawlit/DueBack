/**
 * A loose sheet of the same stock the cards are cut from.
 *
 * Used by the two things that are not *in* the stack but have to look as
 * though they came out of it: the note editor and a character's card when
 * you turn it over. Inside the stack the paper comes from `CardStack`, and
 * nothing should put a card on a card.
 */

import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, shadow } from '@/theme/tokens';

/** The same stock and squared corners as the library card. */
export const paperCardStyle = {
  backgroundColor: color.paperCardAlt,
  borderRadius: 2,
  borderWidth: 1,
  borderColor: color.paperRule,
  ...shadow(10, 0.45),
} satisfies ViewStyle;

export function PaperCard({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[paperCardStyle, style]}>{children}</View>;
}

/**
 * The distance between ruled lines, and the line height any text written on
 * them must use.
 *
 * Exported because the two have to agree exactly. Ruling that nearly lines up
 * with the writing looks worse than no ruling at all, and the only way to
 * keep them together is for the editor to take its line height from here
 * rather than both happening to be thirty.
 */
export const RULE_PITCH = 30;

/**
 * Ruled lines behind a writing surface.
 *
 * Only for a surface whose text sits on `RULE_PITCH`. Anything with cards,
 * chips or headings of its own will not line up, and should be plain paper —
 * which is why the notes and characters cards have no rules and the library
 * card, whose rows are a fixed height, does.
 *
 * Decorative: never takes a touch, and never takes accessibility focus.
 */
export function PaperRules({ offset = 31, lines = 12 }: { offset?: number; lines?: number }) {
  return (
    <View
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}
    >
      {Array.from({ length: lines }, (_, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: offset + i * RULE_PITCH,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: color.paperRule,
          }}
        />
      ))}
    </View>
  );
}
