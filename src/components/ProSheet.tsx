/**
 * What Pro adds, and the one place to buy it.
 *
 * Every locked control in the app opens this rather than explaining itself,
 * so there is one description of what is paid for and one price, written
 * once. A listener who taps a dimmed slider finds out what it does and what
 * it costs in the same breath.
 *
 * ## Why this exists at all
 *
 * There is no trial. Nobody is ever shown the paid features by default, so
 * **Pro features are drawn and disabled, never hidden** — a greyed Characters
 * tab with a line about what it does sells the upgrade, and a Characters tab
 * that is not there sells nothing and leaves somebody never knowing what they
 * did not buy. This sheet is the other half of that: the dimmed control is
 * the advertisement, and this is the detail.
 *
 * Styled as a slip of paper like `ConfirmSheet`, because that is what the app
 * does when it needs a moment of somebody's attention.
 */

import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import { FREE_BUDGET_CEILING_GB } from '@/lib/pro';

/** What the single purchase unlocks, in the order it is worth hearing. */
const INCLUDED: { title: string; body: string }[] = [
  {
    title: 'Characters',
    body: 'Keep an index of who is who, and tag them in your notes as you listen. Long books with long casts stop being a memory test.',
  },
  {
    title: 'Sound',
    body: 'An equaliser, clarity and warmth, and a boost for quietly recorded books. Rescue a thin narration rather than putting up with it.',
  },
  {
    title: 'Room for your whole shelf',
    body: `The free app keeps ${FREE_BUDGET_CEILING_GB} GB of books on the phone at once. Pro takes the ceiling off, so a whole series comes with you.`,
  },
  {
    title: 'Listening statistics',
    body: 'Hours, streaks, your busiest day, your longest sitting, and what you have listened to most.',
  },
  {
    title: 'Themes and covers',
    body: 'Three more colour schemes, and your own picture for a book whose cover is missing or wrong.',
  },
];

/**
 * Always free, said out loud.
 *
 * Here because the free column is a selling point rather than an omission,
 * and because somebody deciding whether to pay deserves to know what they
 * keep if they do not.
 */
const ALWAYS_FREE =
  'Your library, checking out and returning, the whole player, Audiobookshelf, ' +
  'notes and bookmarks, drive backup — and every export is complete whether you ' +
  'pay or not. Nothing you write is ever held back from you.';

type Props = {
  visible: boolean;
  price: string;
  /** Null until a store can be asked. Disables the button and says why. */
  unavailableReason: string | null;
  busy?: boolean;
  onBuy: () => void;
  onRestore: () => void;
  onClose: () => void;
};

export function ProSheet({
  visible,
  price,
  unavailableReason,
  busy = false,
  onBuy,
  onRestore,
  onClose,
}: Props) {
  const canBuy = !unavailableReason && !busy;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel="Dismiss"
        style={{
          flex: 1,
          backgroundColor: color.scrim,
          justifyContent: 'flex-end',
          padding: space.lg,
        }}
      >
        {/* Taps inside the slip must not dismiss it. */}
        <Pressable
          onPress={() => {}}
          style={[
            {
              backgroundColor: color.paper,
              borderRadius: 4,
              maxHeight: '88%',
              transform: [{ rotate: '-0.3deg' }],
            },
            shadow(20, 0.6),
          ]}
        >
          <ScrollView
            contentContainerStyle={{ padding: space.xl, gap: space.md }}
            showsVerticalScrollIndicator={false}
          >
            <View style={{ flexDirection: 'row' }}>
              <View
                style={{
                  borderWidth: 2,
                  borderColor: color.inkOnPaper,
                  paddingHorizontal: 7,
                  paddingVertical: 4,
                  transform: [{ rotate: '-5deg' }],
                }}
              >
                <Text
                  style={{
                    fontFamily: font.monoMedium,
                    fontSize: 11,
                    letterSpacing: 0.9,
                    color: color.inkOnPaper,
                  }}
                >
                  DUE BACK PRO
                </Text>
              </View>
            </View>

            <Text
              accessibilityRole="header"
              style={{ fontFamily: font.serif, fontSize: 21, color: color.inkOnPaper }}
            >
              One payment. Yours for good.
            </Text>

            <View style={{ gap: space.md }}>
              {INCLUDED.map((item) => (
                <View key={item.title} style={{ gap: 2 }}>
                  <Text
                    style={{
                      fontFamily: font.monoMedium,
                      fontSize: 11,
                      letterSpacing: 0.8,
                      color: color.cardInk,
                    }}
                  >
                    {item.title.toUpperCase()}
                  </Text>
                  <Text
                    style={{
                      fontFamily: font.sans,
                      fontSize: 13,
                      lineHeight: 13 * 1.45,
                      color: color.inkOnPaperBody,
                    }}
                  >
                    {item.body}
                  </Text>
                </View>
              ))}
            </View>

            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: color.cardRule,
                paddingTop: space.md,
                gap: 2,
              }}
            >
              <Text
                style={{
                  fontFamily: font.monoMedium,
                  fontSize: 11,
                  letterSpacing: 0.8,
                  color: color.inkOnPaperBody,
                }}
              >
                ALWAYS FREE
              </Text>
              <Text
                style={{
                  fontFamily: font.sans,
                  fontSize: 13,
                  lineHeight: 13 * 1.45,
                  color: color.inkOnPaperBody,
                }}
              >
                {ALWAYS_FREE}
              </Text>
            </View>

            <View style={{ gap: space.sm, marginTop: space.sm }}>
              <Pressable
                onPress={onBuy}
                disabled={!canBuy}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canBuy }}
                accessibilityLabel={`Buy Due Back Pro for ${price}`}
                style={({ pressed }) => ({
                  minHeight: TOUCH + 4,
                  borderRadius: radius.button,
                  // Green, the colour this app already uses for checking a book
                  // out. Buying Pro is the same kind of affirmative act.
                  backgroundColor: pressed ? color.inkOnPaper : color.checkoutInk,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: canBuy ? 1 : 0.45,
                })}
              >
                <Text style={{ fontFamily: font.serif, fontSize: 17, color: color.paper }}>
                  {busy ? 'One moment…' : `Get Pro · ${price}`}
                </Text>
              </Pressable>

              {unavailableReason ? (
                <Text
                  style={{
                    fontFamily: font.mono,
                    fontSize: 11,
                    color: color.inkOnPaperBody,
                    textAlign: 'center',
                  }}
                >
                  {unavailableReason}
                </Text>
              ) : null}

              <Pressable
                onPress={onRestore}
                accessibilityRole="button"
                accessibilityHint="If you have bought Pro before, this brings it back"
                style={{
                  minHeight: TOUCH,
                  borderRadius: radius.button,
                  borderWidth: 1,
                  borderColor: color.cardRule,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.inkOnPaperBody }}>
                  Already bought it
                </Text>
              </Pressable>

              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                style={{ minHeight: TOUCH, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.inkOnPaperBody }}>
                  Not now
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
