/**
 * What the Library shows when a search matches nothing.
 *
 * A blank screen reads as a broken app, and the one question someone has at
 * this moment is "did I spell it wrong, or is it not here?" — so the query is
 * quoted back, and clearing it is one tap rather than a trip to the keyboard.
 */

import { Pressable, Text, View } from 'react-native';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';

export function NoSearchResults({
  query,
  total,
  onClear,
}: {
  query: string;
  /** How many books the shelves hold, so the count is a reassurance. */
  total: number;
  onClear: () => void;
}) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.lg,
        paddingHorizontal: 32,
        // Pulled up a little: the checked-out tray eats the bottom of the
        // screen, and centring against the full height sits too low.
        paddingBottom: 48,
      }}
    >
      {/* An empty catalogue drawer card. */}
      <View
        accessible={false}
        style={{
          width: 180,
          height: 104,
          backgroundColor: color.paperCard,
          borderWidth: 1,
          borderColor: color.paperRule,
          borderRadius: 2,
          transform: [{ rotate: '-1.5deg' }],
          padding: space.md,
          gap: 9,
          justifyContent: 'center',
        }}
      >
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={{
              height: 1,
              backgroundColor: color.paperRule,
              opacity: 0.7,
              width: i === 2 ? '55%' : '100%',
            }}
          />
        ))}
      </View>

      <View style={{ gap: space.sm, alignItems: 'center' }}>
        <Text
          accessibilityRole="header"
          style={{ fontFamily: font.serif, fontSize: 22, color: color.paper, textAlign: 'center' }}
        >
          Nothing matches that.
        </Text>
        <Text
          style={{
            fontFamily: font.sans,
            fontSize: 14,
            lineHeight: 14 * 1.45,
            color: '#cbbb9e',
            textAlign: 'center',
          }}
        >
          {`No book on the shelves answers to “${query.trim()}”. Searching looks at titles, authors and narrators.`}
        </Text>
        <Text
          style={{
            fontFamily: font.mono,
            fontSize: 11,
            color: color.faint,
            textAlign: 'center',
            marginTop: space.xs,
          }}
        >
          {total} {total === 1 ? 'book' : 'books'} on the shelves
        </Text>
      </View>

      <Pressable
        onPress={onClear}
        accessibilityRole="button"
        accessibilityLabel="Clear the search and show every book"
        style={({ pressed }) => ({
          minHeight: TOUCH,
          justifyContent: 'center',
          paddingHorizontal: space.xl,
          borderRadius: radius.button,
          borderWidth: 1,
          borderColor: color.border,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.paper }}>
          show every book
        </Text>
      </Pressable>
    </View>
  );
}
