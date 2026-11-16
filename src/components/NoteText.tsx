/**
 * Something the listener wrote.
 *
 * One face, Instrument Sans, at the size it was asked for. There was a
 * setting that set notes in a handwriting face instead, on the idea that a
 * note should not look like the app talking. It was removed: notes are
 * re-read far more often than they are written, and Caveat at note length is
 * tiring to read. Nothing distinguishes the listener's words by typeface now
 * — the margin they sit in does that.
 */

import type { ReactNode } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { color, font } from '@/theme/tokens';

export function NoteText({
  children,
  size = 15,
  tone = 'paper',
  numberOfLines,
  style,
}: {
  /**
   * Usually a string. The notes list passes spans too, so a character's
   * name can be coloured and pressed inside the sentence it was written in.
   */
  children: ReactNode;
  size?: number;
  tone?: 'paper' | 'muted';
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          fontFamily: font.sans,
          fontSize: size,
          lineHeight: Math.round(size * 1.45),
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
  return { fontFamily: font.sans, fontSize: size };
}
