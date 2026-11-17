/**
 * Writing in about a bug or an idea.
 *
 * It composes a message and hands it to whatever mail app is on the phone,
 * pre-addressed and pre-filled. It does **not** send anything itself: there
 * is no server here, and a form that posted somewhere would mean one — plus
 * a listener's words leaving the phone on a button press they did not read.
 * The mail app's own Send is the last word, which is where it belongs.
 *
 * A bug report carries the app version and the Android version, because the
 * first two questions about any bug are "which build?" and "which phone?",
 * and nobody should have to go and look.
 */

import { useState } from 'react';
import { Linking, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView, KeyboardProvider } from 'react-native-keyboard-controller';
import Constants from 'expo-constants';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';

const TO = 'duebackapp@gmail.com';

type Kind = 'bug' | 'idea';

const KINDS: { key: Kind; label: string; subject: string; placeholder: string }[] = [
  {
    key: 'bug',
    label: 'something is wrong',
    subject: 'Due Back — bug',
    placeholder: 'What happened, and what you were doing when it did.',
  },
  {
    key: 'idea',
    label: 'an idea',
    subject: 'Due Back — request',
    placeholder: 'What you would like it to do.',
  },
];

/** The build and the phone, for a bug report to be answerable. */
function footer(): string {
  const version = Constants.expoConfig?.version ?? 'unknown';
  return `\n\n---\nDue Back ${version}\nAndroid ${String(Platform.Version)}`;
}

export function ContactSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>('bug');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  const chosen = KINDS.find((k) => k.key === kind)!;

  const close = () => {
    setMessage('');
    setFailed(false);
    onClose();
  };

  const send = () => {
    const body = message.trim() + (kind === 'bug' ? footer() : '');
    const url =
      `mailto:${TO}` +
      `?subject=${encodeURIComponent(chosen.subject)}` +
      `&body=${encodeURIComponent(body)}`;
    Linking.openURL(url).then(
      () => close(),
      () => {
        /*
         * No mail app, or none that will take a `mailto:`. Said plainly with
         * the address on screen, rather than a dead button — somebody can
         * still write it down.
         */
        setFailed(true);
      },
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
        <Pressable
          onPress={close}
          accessibilityLabel="Dismiss"
          style={{
            flex: 1,
            backgroundColor: color.scrim,
            justifyContent: 'flex-end',
            padding: space.xl,
          }}
        >
          <KeyboardAvoidingView behavior="padding">
            <Pressable
              onPress={() => {}}
              style={[
                {
                  backgroundColor: color.paper,
                  borderRadius: 4,
                  padding: space.xl,
                  gap: space.md,
                },
                shadow(20, 0.6),
              ]}
            >
              <Text
                accessibilityRole="header"
                style={{ fontFamily: font.serif, fontSize: 21, color: color.inkOnPaper }}
              >
                Get in touch
              </Text>

              <View style={{ flexDirection: 'row', gap: space.sm }}>
                {KINDS.map((option) => {
                  const active = option.key === kind;
                  return (
                    <Pressable
                      key={option.key}
                      onPress={() => setKind(option.key)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={({ pressed }) => ({
                        minHeight: 34,
                        paddingHorizontal: space.md,
                        justifyContent: 'center',
                        borderRadius: radius.button,
                        borderWidth: 1,
                        borderColor: active ? color.inkOnPaper : color.border,
                        backgroundColor: active
                          ? color.inkOnPaper
                          : pressed
                            ? color.pressWash
                            : 'transparent',
                      })}
                    >
                      <Text
                        style={{
                          fontFamily: font.mono,
                          fontSize: 12,
                          color: active ? color.paper : color.inkOnPaper,
                        }}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <TextInput
                value={message}
                onChangeText={setMessage}
                multiline
                placeholder={chosen.placeholder}
                placeholderTextColor="#9a876a"
                accessibilityLabel="Your message"
                style={{
                  fontFamily: font.sans,
                  fontSize: 15,
                  lineHeight: 15 * 1.45,
                  color: color.inkOnPaper,
                  minHeight: 110,
                  textAlignVertical: 'top',
                  borderWidth: 1,
                  borderColor: color.border,
                  borderRadius: 4,
                  padding: space.sm,
                }}
              />

              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.inkOnPaperSoft }}>
                {failed
                  ? `No mail app would open. Write to ${TO}`
                  : kind === 'bug'
                    ? `Opens your mail app, to ${TO}, with the app and Android version added. You send it.`
                    : `Opens your mail app, to ${TO}. You send it.`}
              </Text>

              <View style={{ gap: space.sm, marginTop: space.sm }}>
                <Pressable
                  onPress={send}
                  disabled={message.trim().length === 0}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: message.trim().length === 0 }}
                  style={({ pressed }) => ({
                    minHeight: TOUCH + 4,
                    borderRadius: radius.button,
                    backgroundColor: pressed ? color.checkoutInk : color.checkout,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: message.trim().length === 0 ? 0.35 : 1,
                  })}
                >
                  <Text
                    style={{ fontFamily: font.monoMedium, fontSize: 14, color: color.paper }}
                  >
                    Write the email
                  </Text>
                </Pressable>
                <Pressable
                  onPress={close}
                  accessibilityRole="button"
                  style={{
                    minHeight: TOUCH,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontFamily: font.mono, fontSize: 13, color: color.inkOnPaperSoft }}>
                    Cancel
                  </Text>
                </Pressable>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </KeyboardProvider>
    </Modal>
  );
}
