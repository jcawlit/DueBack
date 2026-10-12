/**
 * The bar that replaces the checked-out tray in select mode. It keeps a running
 * total of the selection and refuses, in advance, a trip that will not fit —
 * rather than letting the user pick five books and discover the problem one slip
 * at a time.
 */

import { Pressable, Text, View } from 'react-native';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import { bytes, gigabytes } from '@/lib/format';
import { DashedEdge } from './DashedEdge';

type Props = {
  count: number;
  selectionBytes: number;
  freeBytes: number;
  onConfirm: () => void;
  onCancel: () => void;
};

export function SelectBar({ count, selectionBytes, freeBytes, onConfirm, onCancel }: Props) {
  const over = selectionBytes - freeBytes;
  const fits = over <= 0;
  const ready = count > 0 && fits;

  return (
    <View style={[{ backgroundColor: color.panel }, shadow(14, 0.45)]}>
      <DashedEdge color="#6a5038" />
      <View
        style={{
          paddingHorizontal: space.xl,
          paddingTop: space.lg,
          paddingBottom: 18,
          gap: space.md,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'baseline',
          }}
        >
          <Text style={{ fontFamily: font.serif, fontSize: 20, color: color.paper }}>
            {count === 0
              ? 'Pick your books'
              : `${count} ${count === 1 ? 'book' : 'books'} · ${gigabytes(selectionBytes)}`}
          </Text>
          <Text
            style={{
              fontFamily: font.mono,
              fontSize: 12,
              color: fits ? color.muted : color.warning,
            }}
          >
            {fits ? `${gigabytes(Math.max(0, freeBytes - selectionBytes))} left` : `${bytes(over)} over`}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel selection"
            style={({ pressed }) => ({
              minHeight: TOUCH + 4,
              paddingHorizontal: space.lg,
              borderRadius: radius.button,
              borderWidth: 1,
              borderColor: color.border,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.paper }}>
              cancel
            </Text>
          </Pressable>

          <Pressable
            onPress={onConfirm}
            disabled={!ready}
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready }}
            accessibilityLabel={
              count === 0
                ? 'Choose books to check out'
                : fits
                  ? `Check out ${count} books, ${gigabytes(selectionBytes)}`
                  : `Selection is ${bytes(over)} over the budget`
            }
            style={({ pressed }) => [
              {
                flex: 1,
                minHeight: TOUCH + 4,
                borderRadius: radius.button,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: ready
                  ? color.accent
                  : fits
                    ? color.troughDeep
                    : color.warning,
                opacity: pressed && ready ? 0.85 : 1,
              },
              ready ? shadow(8, 0.3) : null,
            ]}
          >
            <Text
              style={{
                fontFamily: font.serif,
                fontSize: 16,
                color: ready ? color.ground : fits ? color.faint : color.paper,
              }}
            >
              {count === 0
                ? 'Tap covers to choose'
                : fits
                  ? `Check out ${count} ${count === 1 ? 'book' : 'books'} · ${gigabytes(selectionBytes)}`
                  : `${bytes(over)} too much`}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
