/**
 * A paper slip that drops over the Library to report the result of a move: the
 * mockup's "WON'T FIT" refusal, and the quieter notes for holds and returns.
 * Rubber-stamped and slightly askew, like something handed over a desk.
 */

import { useEffect, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { color, font, shadow } from '@/theme/tokens';
import type { Slip as SlipModel } from '@/store/library';

type Props = {
  slip: SlipModel;
  onDismiss: () => void;
  /** Distance from the bottom of the screen, above the checked-out tray. */
  bottom: number;
};

export function Slip({ slip, onDismiss, bottom }: Props) {
  // Held in state rather than a ref: the value is read during render to build
  // the animated style, which is exactly what a ref must not be used for.
  const [enter] = useState(() => new Animated.Value(0));
  const refusal = slip.kind === 'wont-fit';
  const stamp = slip.stamp ?? (refusal ? "WON'T FIT" : null);
  const ink = refusal ? color.warningInk : color.stampOut;

  useEffect(() => {
    enter.setValue(0);
    Animated.spring(enter, {
      toValue: 1,
      useNativeDriver: true,
      friction: 9,
      tension: 70,
    }).start();
  }, [enter, slip]);

  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: 18,
        right: 18,
        bottom,
        zIndex: 20,
        opacity: enter,
        transform: [
          { rotate: '-0.6deg' },
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
        ],
      }}
    >
      <Pressable
        accessibilityRole="alert"
        accessibilityLabel={`${stamp ? `${stamp}. ` : ''}${slip.text}`}
        onPress={onDismiss}
        style={[
          {
            backgroundColor: color.paper,
            borderRadius: 3,
            paddingHorizontal: 16,
            paddingVertical: 14,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
          },
          shadow(16, 0.6),
        ]}
      >
        {stamp ? (
          <View
            style={{
              borderWidth: 2,
              borderColor: ink,
              paddingHorizontal: 6,
              paddingVertical: 4,
              transform: [{ rotate: '-6deg' }],
            }}
          >
            <Text
              style={{
                fontFamily: font.monoMedium,
                fontSize: 11,
                letterSpacing: 0.9,
                color: ink,
              }}
            >
              {stamp}
            </Text>
          </View>
        ) : null}
        <Text
          style={{
            flex: 1,
            fontFamily: font.sans,
            fontSize: 13,
            lineHeight: 13 * 1.35,
            color: color.inkOnPaper,
          }}
        >
          {slip.text}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
