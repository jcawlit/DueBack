/**
 * A loose sheet of the same stock the cards are cut from.
 *
 * Every card surface in the app comes from here: the margins section on the
 * Book screen, the note editor, the library card's sheet, and a character's
 * card when you turn it over. Nothing should put a card on a card — anything
 * drawn *inside* one of these takes the paper it is already on.
 *
 * The heading and empty-state below used to live in `CardStack`, which was
 * the tabbed stack the Book screen had before the margins became one
 * section. The stack is gone; these two outlived it.
 */

import type { ReactNode } from 'react';
import { Text, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, font, shadow, space } from '@/theme/tokens';

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

/** A heading inside a card: the same stamped look as the library card's. */
export function CardHeading({ children }: { children: string }) {
  return (
    <Text
      style={{
        fontFamily: font.mono,
        fontSize: 11,
        letterSpacing: 1,
        color: color.stampFaded,
        paddingBottom: space.xs,
      }}
    >
      {children.toUpperCase()}
    </Text>
  );
}

/** What a card says when there is nothing on it yet. */
export function CardEmpty({ children }: { children: string }) {
  return (
    <Text
      style={{
        fontFamily: font.sans,
        fontSize: 13,
        lineHeight: 19,
        color: color.stampFaded,
        paddingVertical: space.md,
      }}
    >
      {children}
    </Text>
  );
}
