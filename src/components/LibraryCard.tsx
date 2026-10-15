/**
 * The library card pasted inside the front cover: one ruled line per checkout,
 * date stamped on the left when the book went out and on the right when it came
 * back. An open checkout leaves the return column blank.
 *
 * The ruled lines are Views rather than a repeating gradient, and each stamp gets
 * a small fixed rotation so the card looks hand-stamped over years.
 */

import { Text, View } from 'react-native';
import type { Checkout } from '@/data/types';
import { color, font, shadow, space } from '@/theme/tokens';
import { stampDate } from '@/lib/format';

const ROW_HEIGHT = 26;
const HEADER_OFFSET = 38;
/** Deliberate wobble, so no two stamps line up perfectly. */
const OUT_LEANS = [-2, 1, -1.5, 2.5, -1, 1.8];
const BACK_LEANS = [1.5, -1.2, 2, -2, 1, -1.5];

type Props = {
  checkouts: Checkout[];
  /** Minimum ruled lines, so a fresh card still looks like a card. */
  minRows?: number;
  /**
   * Draw only the ruling and the stamps, with no paper of its own.
   *
   * Inside the card stack the surrounding card *is* the library card, so a
   * second sheet with its own shadow and lean would be a card on a card. The
   * lean is worth keeping where this stands alone: one card pasted into a
   * cover can sit crooked, a stack holding a scrolling list cannot.
   */
  bare?: boolean;
};

export function LibraryCard({ checkouts, minRows = 4, bare = false }: Props) {
  const rows = Math.max(minRows, checkouts.length);
  // Newest at the bottom, the way a real card fills downwards.
  const ordered = [...checkouts].sort((a, b) => a.out.localeCompare(b.out));

  return (
    <View
      style={
        bare
          ? { paddingBottom: 10, overflow: 'hidden' }
          : [
              {
                backgroundColor: color.paperCardAlt,
                borderRadius: 2,
                paddingTop: space.md,
                paddingHorizontal: 14,
                paddingBottom: 10,
                transform: [{ rotate: '0.8deg' }],
                overflow: 'hidden',
              },
              shadow(10, 0.5),
            ]
      }
    >
      {/* Ruled lines, starting below the column headings. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        {Array.from({ length: rows }, (_, i) => (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: HEADER_OFFSET + (i + 1) * ROW_HEIGHT,
              height: 1,
              backgroundColor: color.paperRule,
            }}
          />
        ))}
      </View>

      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingBottom: 8,
          borderBottomWidth: 1.5,
          borderBottomColor: '#7a6446',
        }}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: '#5a4a32' }}>
          CHECKED OUT
        </Text>
        <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: '#5a4a32' }}>
          RETURNED
        </Text>
      </View>

      {rows === 0 ? null : (
        <View>
          {Array.from({ length: rows }, (_, i) => {
            const entry = ordered[i];
            return (
              <View key={i} style={{ flexDirection: 'row', height: ROW_HEIGHT }}>
                <View style={{ flex: 1, justifyContent: 'center' }}>
                  {entry ? (
                    <Text
                      style={{
                        fontFamily: font.monoMedium,
                        fontSize: 12,
                        letterSpacing: 0.5,
                        color: color.stampOut,
                        transform: [{ rotate: `${OUT_LEANS[i % OUT_LEANS.length]}deg` }],
                        paddingLeft: i % 2 === 0 ? 0 : 6,
                      }}
                    >
                      {stampDate(entry.out)}
                    </Text>
                  ) : null}
                </View>
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'flex-end' }}>
                  {entry ? (
                    entry.back ? (
                      <Text
                        style={{
                          fontFamily: font.monoMedium,
                          fontSize: 12,
                          letterSpacing: 0.5,
                          color: color.stampBack,
                          transform: [{ rotate: `${BACK_LEANS[i % BACK_LEANS.length]}deg` }],
                        }}
                      >
                        {stampDate(entry.back)}
                      </Text>
                    ) : (
                      <Text
                        accessibilityLabel="Still out"
                        style={{
                          fontFamily: font.monoMedium,
                          fontSize: 12,
                          color: color.stampFaded,
                        }}
                      >
                        —
                      </Text>
                    )
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
