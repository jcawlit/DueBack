/**
 * The library card pasted inside the front cover: one ruled line per checkout,
 * date stamped on the left when the book went out and on the right when it came
 * back. An open checkout leaves the return column blank.
 *
 * The ruled lines are Views rather than a repeating gradient, and each stamp gets
 * a small fixed rotation so the card looks hand-stamped over years.
 */

import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Checkout } from '@/data/types';
import { color, font, shadow, space, TOUCH } from '@/theme/tokens';
import { stampDate } from '@/lib/format';
import { PaperCard } from './PaperCard';

const ROW_HEIGHT = 26;
const HEADER_OFFSET = 38;
/** The last three stamps are what the compact card can show and still be read. */
const COMPACT_ROWS = 3;
/*
 * The compact card is tighter in every direction. Its rows are shorter, its
 * header sits closer to them, and its stamps are set a point smaller on one
 * line — a two-line stamp inside a 20px row loses its year off the bottom,
 * which is what the first version of this did.
 */
const COMPACT_ROW_HEIGHT = 20;
const COMPACT_HEADER_OFFSET = 32;

/**
 * "OCT 15 2026" → "OCT 15 '26".
 *
 * The compact column is about 85px wide, and the full stamp needs more than
 * that at this size, so it wrapped and the year fell out of the row. Done
 * here rather than in `stampDate`, because the full card has the width and
 * should keep writing the year out.
 */
function shortStamp(iso: string): string {
  return stampDate(iso).replace(/ \d{2}(\d{2})$/, " '$1");
}
/**
 * What the compact card is expected to measure, for the first frame only.
 *
 * The hero has to reserve vertical space for a card that is absolutely
 * positioned over the cover, and it cannot know the real height until the
 * card has laid out. This is top padding, the headings, three rows, the
 * status line and the bottom padding; `onLayout` corrects it, which is what
 * keeps the composition right when the system font scale is turned up.
 */
export const COMPACT_CARD_ESTIMATE = 122;
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
  /**
   * The short form: headings, the last three stamps, and a line saying where
   * the book is. For the hero on the Book screen, where the card is a lid
   * over the cover rather than the page itself — it has to be readable at a
   * glance and small enough not to bury the artwork.
   */
  compact?: boolean;
  /** The line under the stamps, e.g. "ON YOUR PHONE · tap for full card". */
  statusLine?: string;
};

export function LibraryCard({ checkouts, minRows, bare = false, compact = false, statusLine }: Props) {
  const floor = minRows ?? (compact ? COMPACT_ROWS : 4);
  // Newest at the bottom, the way a real card fills downwards — so the
  // compact card keeps the *last* three, not the first.
  const sorted = [...checkouts].sort((a, b) => a.out.localeCompare(b.out));
  const ordered = compact ? sorted.slice(-COMPACT_ROWS) : sorted;
  const rows = Math.max(floor, ordered.length);
  const rowHeight = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
  const headerOffset = compact ? COMPACT_HEADER_OFFSET : HEADER_OFFSET;
  const stampSize = compact ? 11 : 12;

  return (
    <View
      style={
        bare
          ? { paddingBottom: compact ? 8 : 10, overflow: 'hidden' }
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
              top: headerOffset + (i + 1) * rowHeight,
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
          paddingBottom: compact ? 6 : 8,
          borderBottomWidth: 1.5,
          borderBottomColor: '#7a6446',
        }}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 1, color: '#5a4a32' }}>
          CHECKED OUT
        </Text>
        <Text style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 1, color: '#5a4a32' }}>
          RETURNED
        </Text>
      </View>

      {rows === 0 ? null : (
        <View>
          {Array.from({ length: rows }, (_, i) => {
            const entry = ordered[i];
            return (
              <View key={i} style={{ flexDirection: 'row', height: rowHeight }}>
                <View style={{ flex: 1, justifyContent: 'center' }}>
                  {entry ? (
                    <Text
                      numberOfLines={1}
                      style={{
                        fontFamily: font.monoMedium,
                        fontSize: stampSize,
                        letterSpacing: 0.5,
                        color: color.stampOut,
                        transform: [{ rotate: `${OUT_LEANS[i % OUT_LEANS.length]}deg` }],
                        paddingLeft: i % 2 === 0 ? 0 : 6,
                      }}
                    >
                      {compact ? shortStamp(entry.out) : stampDate(entry.out)}
                    </Text>
                  ) : null}
                </View>
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'flex-end' }}>
                  {entry ? (
                    entry.back ? (
                      <Text
                        numberOfLines={1}
                        style={{
                          fontFamily: font.monoMedium,
                          fontSize: stampSize,
                          letterSpacing: 0.5,
                          color: color.stampBack,
                          transform: [{ rotate: `${BACK_LEANS[i % BACK_LEANS.length]}deg` }],
                        }}
                      >
                        {compact ? shortStamp(entry.back) : stampDate(entry.back)}
                      </Text>
                    ) : (
                      <Text
                        accessibilityLabel="Still out"
                        style={{
                          fontFamily: font.monoMedium,
                          fontSize: stampSize,
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

      {statusLine ? (
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={{
            fontFamily: font.mono,
            fontSize: 11,
            letterSpacing: 0.5,
            color: '#5a4a32',
            paddingTop: 6,
          }}
        >
          {statusLine}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The whole card, lifted off the cover.
 *
 * The compact card on the Book screen shows the last three stamps; a book
 * read over years has more, and this is where they are. Bare inside the
 * sheet's own paper, because a card drawn on a card is one sheet too many.
 */
export function LibraryCardSheet({
  visible,
  checkouts,
  title,
  onClose,
}: {
  visible: boolean;
  checkouts: Checkout[];
  title: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(10,7,5,0.6)',
          justifyContent: 'flex-end',
          paddingTop: insets.top + space.md,
          paddingBottom: Math.max(insets.bottom, space.md),
          paddingHorizontal: space.lg,
        }}
      >
        <Pressable
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
          onPress={onClose}
          accessibilityLabel="Close the library card"
        />
        <PaperCard style={{ maxHeight: '85%', flexShrink: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingHorizontal: space.lg,
              paddingTop: space.md,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                flexShrink: 1,
                fontFamily: font.monoMedium,
                fontSize: 11,
                letterSpacing: 1,
                color: color.stampOut,
              }}
            >
              {title.toUpperCase()}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              hitSlop={10}
              style={({ pressed }) => ({
                minHeight: TOUCH,
                justifyContent: 'center',
                paddingLeft: space.md,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.stampBack }}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}
          >
            <LibraryCard bare checkouts={checkouts} />
          </ScrollView>
        </PaperCard>
      </View>
    </Modal>
  );
}
