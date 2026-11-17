/**
 * A stamped note on the Book screen: a rubber-stamp heading over a sentence or
 * two of plain English.
 *
 * Three of these had accumulated as copies of the same block of styles, so the
 * shape lives here. `warning` is for something that will stop the book
 * playing; `quiet` is for something merely worth knowing.
 */

import { type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { color, font, radius, space } from '@/theme/tokens';

export function NoteCard({
  stamp,
  tone = 'warning',
  children,
}: {
  stamp: string;
  tone?: 'warning' | 'quiet';
  children: ReactNode;
}) {
  const warn = tone === 'warning';
  return (
    <View
      style={{
        marginTop: space.lg,
        marginHorizontal: space.xxl,
        borderWidth: 1,
        borderColor: warn ? color.warningInk : color.line,
        borderRadius: radius.button,
        padding: space.md,
        gap: space.xs,
      }}
    >
      <Text
        style={{
          fontFamily: font.monoMedium,
          fontSize: 11,
          letterSpacing: 0.9,
          color: warn ? color.warning : color.muted,
        }}
      >
        {stamp}
      </Text>
      {children}
    </View>
  );
}

/** Body copy inside a `NoteCard`. */
export function NoteText({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        fontFamily: font.sans,
        fontSize: 13,
        lineHeight: 13 * 1.4,
        color: color.paperSoft,
      }}
    >
      {children}
    </Text>
  );
}
