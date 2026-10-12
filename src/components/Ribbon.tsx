/**
 * The red bookmark ribbon. It hangs below a cover when a book is in progress,
 * and the same shape is the playhead on the Player's chapter scrubber.
 */

import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { color, shadow } from '@/theme/tokens';

type Props = {
  width?: number;
  height?: number;
  /** Depth of the V-notch cut into the bottom, as a fraction of the height. */
  notch?: number;
};

export function Ribbon({ width = 7, height = 22, notch = 0.22 }: Props) {
  const notchTop = height * (1 - notch);
  return (
    <View style={shadow(2, 0.4)}>
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <Path
          d={`M0 0 H${width} V${height} L${width / 2} ${notchTop} L0 ${height} Z`}
          fill={color.ribbon}
        />
      </Svg>
    </View>
  );
}
