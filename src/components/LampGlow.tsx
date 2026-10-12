/**
 * The one gradient the design allows: a soft lamp glow behind the Player's cover.
 * CSS had a `radial-gradient`; this is the react-native-svg equivalent.
 */

import { View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { color } from '@/theme/tokens';

export function LampGlow({ size = 300, top = 40 }: { size?: number; top?: number }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top,
        left: 0,
        right: 0,
        height: size,
        alignItems: 'center',
      }}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id="lamp" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={color.accent} stopOpacity={0.22} />
            <Stop offset="70%" stopColor={color.accent} stopOpacity={0} />
            <Stop offset="100%" stopColor={color.accent} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={size} height={size} fill="url(#lamp)" />
      </Svg>
    </View>
  );
}
