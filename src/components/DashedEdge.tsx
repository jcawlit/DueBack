/**
 * The dashed top edge of the checked-out tray. React Native's `borderStyle:
 * 'dashed'` cannot be applied to a single side reliably across platforms, so the
 * dashes are an SVG line.
 */

import { View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

type Props = {
  color: string;
  thickness?: number;
  dash?: [number, number];
};

export function DashedEdge({ color, thickness = 2, dash = [7, 6] }: Props) {
  return (
    <View style={{ height: thickness, width: '100%' }} pointerEvents="none">
      <Svg width="100%" height={thickness}>
        <Line
          x1={0}
          y1={thickness / 2}
          x2="100%"
          y2={thickness / 2}
          stroke={color}
          strokeWidth={thickness}
          strokeDasharray={dash.join(' ')}
        />
      </Svg>
    </View>
  );
}
