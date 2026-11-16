/**
 * The one line that says a book can be taken.
 *
 * There was a "+" in the corner of every cover once. It went for good
 * reasons — it sat on the artwork, it needed its own touch target on a
 * thumbnail, and every state it showed was already a tag on the cover. But
 * it was also the only visible sign that a book could be checked out at all,
 * and a gesture nobody is told about is a feature nobody has.
 *
 * So: one quiet line above the first shelf, dismissed by its own × and gone
 * for good the moment anything is checked out. It is a sentence, not a
 * tutorial — the gesture is simple and only needs saying once.
 */

import { Pressable, Text, View } from 'react-native';
import { color, font, space, TOUCH } from '@/theme/tokens';

export function CheckoutHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        marginTop: space.lg,
        marginHorizontal: space.xl,
        paddingLeft: space.md,
        paddingRight: space.xs,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: color.borderSoft,
        // Dashed, like the shelf labels you can change: this is a note to
        // the reader rather than a part of the furniture.
        borderStyle: 'dashed',
      }}
    >
      <Text
        style={{
          flex: 1,
          fontFamily: font.mono,
          fontSize: 11,
          lineHeight: 11 * 1.5,
          color: color.muted,
          paddingVertical: space.sm,
        }}
      >
        Hold a book to check it out. Hold it again to return it.
      </Text>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Got it"
        hitSlop={8}
        style={({ pressed }) => ({
          width: TOUCH - 10,
          height: TOUCH - 10,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 15, color: color.faint }}>×</Text>
      </Pressable>
    </View>
  );
}
