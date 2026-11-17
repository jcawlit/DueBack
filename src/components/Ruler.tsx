/**
 * The storage ruler under the checked-out tray: a trough with quarter-gigabyte
 * ticks, an amber fill for what is on the phone and a dimmer segment for what is
 * still on hold. Past 85% of the budget the fill turns to the warning colour.
 */

import { Text, View } from 'react-native';
import { color, font } from '@/theme/tokens';
import { GB } from '@/lib/format';

type Props = {
  usedBytes: number;
  holdBytes: number;
  budgetBytes: number;
};

export function Ruler({ usedBytes, holdBytes, budgetBytes }: Props) {
  const budgetGB = budgetBytes / GB;
  const usedFraction = Math.min(1, usedBytes / budgetBytes);
  const holdFraction = Math.min(1 - usedFraction, holdBytes / budgetBytes);
  const crowded = usedFraction + holdFraction > 0.85;

  // A tick every quarter gigabyte, matching the mockup's `gb * 4` divisions.
  const tickCount = Math.max(1, Math.round(budgetGB * 4));
  const step = budgetGB <= 8 ? 1 : 2;
  const labels: string[] = [];
  for (let g = 0; g <= budgetGB; g += step) {
    labels.push(g === budgetGB ? `${g} GB` : String(g));
  }

  return (
    <View style={{ gap: 5 }}>
      <View
        style={{
          height: 18,
          backgroundColor: color.troughDeep,
          borderWidth: 1,
          borderColor: color.border,
          borderRadius: 2,
          overflow: 'hidden',
          flexDirection: 'row',
        }}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`Storage: ${Math.round(usedFraction * 100)} percent of the budget used`}
      >
        <View
          style={{
            width: `${usedFraction * 100}%`,
            height: '100%',
            backgroundColor: crowded ? color.warning : color.accent,
          }}
        />
        {holdFraction > 0 ? (
          <View
            style={{
              width: `${holdFraction * 100}%`,
              height: '100%',
              backgroundColor: crowded ? color.warning : color.accent,
              opacity: 0.35,
            }}
          />
        ) : null}

        {/* Ticks sit above the fill, so the ruler reads as a measuring edge. */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            flexDirection: 'row',
          }}
          pointerEvents="none"
        >
          {Array.from({ length: tickCount }, (_, i) => (
            <View key={i} style={{ flex: 1, borderLeftWidth: i === 0 ? 0 : 1, borderLeftColor: color.shadeStrong }} />
          ))}
        </View>
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {labels.map((l) => (
          <Text key={l} style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
            {l}
          </Text>
        ))}
      </View>
    </View>
  );
}
