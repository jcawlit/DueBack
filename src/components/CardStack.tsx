/**
 * The little stack of cards in the back of the book.
 *
 * Three cards, tabbed along the top the way an index box is: the library card
 * the book is stamped on, the notes written while listening, and the people
 * in it. One stock, one ink, one set of rules — because they are three faces
 * of the same thing, a record of *your* reading of this book, as distinct
 * from the book itself.
 *
 * The tabs are real tabs rather than an underlined bar: the active one is cut
 * from the same paper as the card below it and joins it, while the others sit
 * back in a darker stock. That one detail is what makes this read as a stack
 * rather than as a toolbar with a panel under it.
 *
 * Deliberately not rotated. A single card pasted into a cover can lean —
 * `LibraryCard` does — but a stack holding a scrolling list cannot: tilted
 * tabs are harder to hit, and rotated text resamples soft on Android.
 */

import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { color, shadow, font, space } from '@/theme/tokens';

/** Enough to read, short enough that three fit across a phone. */
const TAB_HEIGHT = 34;

/** The three faces of a book's record. */
export type BookTab = 'card' | 'notes' | 'characters';

export type StackTab<T extends string> = {
  key: T;
  label: string;
  /** Spoken instead of the label, where the label is too terse alone. */
  hint?: string;
};

export function CardStack<T extends string>({
  tabs,
  active,
  onChange,
  children,
}: {
  tabs: StackTab<T>[];
  active: T;
  onChange: (tab: T) => void;
  children: ReactNode;
}) {
  return (
    <View style={{ marginHorizontal: space.xl }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: space.sm }}>
        {tabs.map((tab) => {
          const selected = tab.key === active;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onChange(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityHint={tab.hint}
              style={{
                flex: 1,
                height: selected ? TAB_HEIGHT : TAB_HEIGHT - 4,
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: space.xs,
                borderTopLeftRadius: 3,
                borderTopRightRadius: 3,
                borderWidth: 1,
                borderBottomWidth: 0,
                borderColor: color.paperRule,
                // The card in front is the same stock as the body and sits a
                // hair over it, so the join disappears; the others are a
                // shade back and a little shorter, as though behind.
                backgroundColor: selected ? color.paperCardAlt : color.paperCard,
                opacity: selected ? 1 : 0.72,
                marginBottom: selected ? -1 : 0,
                marginRight: 2,
                zIndex: selected ? 2 : 1,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: selected ? font.monoMedium : font.mono,
                  fontSize: 10,
                  letterSpacing: 0.8,
                  color: selected ? color.inkOnPaper : color.stampFaded,
                }}
              >
                {tab.label.toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View
        style={[
          {
            backgroundColor: color.paperCardAlt,
            borderWidth: 1,
            borderColor: color.paperRule,
            borderRadius: 2,
            borderTopLeftRadius: 0,
            paddingHorizontal: 14,
            paddingTop: space.md,
            paddingBottom: space.lg,
            zIndex: 1,
          },
          shadow(10, 0.45),
        ]}
      >
        {children}
      </View>

      {/*
        The cards behind, as two edges showing below the one in front. Purely
        decorative, and kept away from screen readers: there is nothing here
        to read and nothing to do.
      */}
      <View pointerEvents="none" accessible={false} importantForAccessibility="no-hide-descendants">
        <View
          style={{
            height: 4,
            marginHorizontal: space.sm,
            backgroundColor: color.paperCard,
            borderWidth: 1,
            borderTopWidth: 0,
            borderColor: color.paperRule,
            borderBottomLeftRadius: 2,
            borderBottomRightRadius: 2,
          }}
        />
        <View
          style={{
            height: 3,
            marginHorizontal: space.lg,
            backgroundColor: color.paperRule,
            opacity: 0.6,
            borderBottomLeftRadius: 2,
            borderBottomRightRadius: 2,
          }}
        />
      </View>
    </View>
  );
}

/** A heading inside a card: the same stamped look as the library card's. */
export function CardHeading({ children }: { children: string }) {
  return (
    <Text
      style={{
        fontFamily: font.mono,
        fontSize: 10,
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
