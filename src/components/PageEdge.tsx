/**
 * The striped block of page edges to the right of a cover. Its width encodes the
 * book's length — `round(3 + hours / 5)` px — so a doorstopper visibly is one.
 *
 * CSS got this from `repeating-linear-gradient`; React Native has no repeating
 * gradient, so the stripes are 1px Views.
 */

import { View } from 'react-native';
import { edge, shadow } from '@/theme/tokens';
import { pageEdgeWidth } from '@/lib/shelves';

type Props = {
  durationSec: number;
  height: number;
  /** Vertical inset, so the edges sit slightly inside the cover's height. */
  inset?: number;
  elevation?: number;
  /** Overrides the computed width, for the oversized hero covers. */
  width?: number;
};

export function PageEdge({ durationSec, height, inset = 3, elevation = 6, width }: Props) {
  const total = width ?? pageEdgeWidth(durationSec);
  const stripes = Array.from({ length: total }, (_, i) => i);

  return (
    <View
      style={[
        {
          width: total,
          height: Math.max(0, height - inset * 2),
          marginVertical: inset,
          borderTopRightRadius: 2,
          borderBottomRightRadius: 2,
          flexDirection: 'row',
          overflow: 'hidden',
          backgroundColor: edge.dark,
        },
        shadow(elevation, 0.4),
      ]}
    >
      {stripes.map((i) => (
        <View
          key={i}
          style={{ width: 1, height: '100%', backgroundColor: i % 2 === 0 ? edge.light : edge.dark }}
        />
      ))}
    </View>
  );
}
