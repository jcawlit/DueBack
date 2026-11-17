/**
 * A blocking question, used for the one move that can lose data: returning a
 * book whose source file is no longer on the drive. Everything else in the app
 * is reversible and gets a slip instead.
 */

import { Modal, Pressable, Text, View } from 'react-native';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';

type Props = {
  visible: boolean;
  stamp: string;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmSheet({
  visible,
  stamp,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Keep it',
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        accessibilityLabel="Dismiss"
        style={{
          flex: 1,
          backgroundColor: color.scrim,
          justifyContent: 'flex-end',
          padding: space.xl,
        }}
      >
        {/* Stop taps inside the card from dismissing it. */}
        <Pressable
          onPress={() => {}}
          style={[
            {
              backgroundColor: color.paper,
              borderRadius: 4,
              padding: space.xl,
              gap: space.md,
              transform: [{ rotate: '-0.4deg' }],
            },
            shadow(20, 0.6),
          ]}
        >
          <View style={{ flexDirection: 'row' }}>
            <View
              style={{
                borderWidth: 2,
                borderColor: color.warningInk,
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
                  color: color.warningInk,
                }}
              >
                {stamp}
              </Text>
            </View>
          </View>

          <Text
            accessibilityRole="header"
            style={{ fontFamily: font.serif, fontSize: 21, color: color.inkOnPaper }}
          >
            {title}
          </Text>
          <Text
            style={{
              fontFamily: font.sans,
              fontSize: 14,
              lineHeight: 14 * 1.45,
              color: color.inkOnPaperBody,
            }}
          >
            {body}
          </Text>

          <View style={{ gap: space.sm, marginTop: space.sm }}>
            <Pressable
              onPress={onConfirm}
              accessibilityRole="button"
              style={({ pressed }) => [
                {
                  minHeight: TOUCH + 4,
                  borderRadius: radius.button,
                  backgroundColor: pressed ? color.stampBack : color.warningInk,
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              ]}
            >
              <Text style={{ fontFamily: font.serif, fontSize: 17, color: color.paper }}>
                {confirmLabel}
              </Text>
            </Pressable>
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
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
                {cancelLabel}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
