/**
 * Chapters · Notes · Characters, across the top of the lower half.
 *
 * Three things you can want from a book you are already reading: where you
 * are in it, what you wrote, and who is in it. Each tab carries its own
 * count, so the bar answers "is there anything in there" without being
 * opened — an empty Characters tab should look empty from outside.
 *
 * An underline, not a card stack. The stack was right when these were loose
 * sheets in the back of the book; they are sections of one page now.
 */

import { Pressable, Text, View } from 'react-native';
import { color, font, space } from '@/theme/tokens';

export type BookTab = 'chapters' | 'notes' | 'characters';

export function BookTabs({
  active,
  counts,
  onChange,
}: {
  active: BookTab;
  counts: Record<BookTab, number>;
  onChange: (tab: BookTab) => void;
}) {
  const tabs: { key: BookTab; label: string }[] = [
    { key: 'chapters', label: 'Chapters' },
    { key: 'notes', label: 'Notes' },
    { key: 'characters', label: 'Characters' },
  ];

  return (
    <View
      style={{
        flexDirection: 'row',
        paddingHorizontal: space.md,
        borderBottomWidth: 1,
        borderBottomColor: color.line,
      }}
    >
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${tab.label}, ${counts[tab.key]}`}
            style={{
              flex: 1,
              minHeight: 48,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              borderBottomWidth: 2,
              borderBottomColor: on ? color.accent : 'transparent',
              // Sits over the bar's own hairline, so the two do not stack.
              marginBottom: -1,
            }}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 13, color: on ? color.paper : color.faint }}>
              {tab.label}
            </Text>
            <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
              {counts[tab.key]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
