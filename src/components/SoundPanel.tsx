/**
 * The Sound panel: three knobs on an amp, and the presets that set them.
 *
 * Built around what the device will admit to. Android equalizers differ in
 * how many bands they have, where those bands sit and how far they go, and
 * plenty of devices will not give an app an equalizer at all — so a control
 * whose effect is unavailable is not greyed out, it is gone, replaced by a
 * line saying so. Playback is never affected either way.
 */

import { useState } from 'react';
import { Modal, PanResponder, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PRESETS, type PresetName, type SoundSettings } from '@/lib/audio/sound';
import type { SoundCapabilities } from '../../modules/dueback-audio';
import { isPro } from '@/lib/pro';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';

const TRACK_HEIGHT = 8;
/** One step of the accessibility increment, and of a tap on the ends. */
const STEP = 10;

type Props = {
  visible: boolean;
  settings: SoundSettings;
  capabilities: SoundCapabilities;
  /** False on iOS, and in any build without the native module. */
  possible: boolean;
  /** True when this book has settings of its own rather than the default. */
  hasOwn: boolean;
  saveError: string | null;
  onPreset: (preset: PresetName) => void;
  onSlider: (which: 'boost' | 'clarity' | 'warmth', value: number) => void;
  onUseDefault: () => void;
  onMakeDefault: () => void;
  onClose: () => void;
};

export function SoundPanel({
  visible,
  settings,
  capabilities,
  possible,
  hasOwn,
  saveError,
  onPreset,
  onSlider,
  onUseDefault,
  onMakeDefault,
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const pro = isPro();

  const loudness = possible && capabilities.loudness.available;
  const equalizer = possible && capabilities.equalizer.available;
  const nothing = !loudness && !equalizer;

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: color.scrimSoft }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close sound" />

        <View
          style={{
            backgroundColor: color.panel,
            borderTopLeftRadius: 14,
            borderTopRightRadius: 14,
            borderTopWidth: 1,
            borderColor: color.border,
            paddingBottom: Math.max(space.lg, insets.bottom + space.sm),
            maxHeight: '86%',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: space.xl,
              paddingTop: space.lg,
              paddingBottom: space.md,
              borderBottomWidth: 1,
              borderBottomColor: color.line,
            }}
          >
            <Text
              accessibilityRole="header"
              style={{ fontFamily: font.mono, fontSize: 11, letterSpacing: 1, color: color.accent }}
            >
              SOUND
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" hitSlop={12}>
              <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>done</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.lg }}>
            {saveError ? <Text accessibilityRole="alert" style={{ color: color.accent }}>{saveError}</Text> : null}
            {nothing ? (
              <Text style={{ fontFamily: font.sans, fontSize: 14, color: color.muted }}>
                Not supported on this device. Due Back could not get hold of an equalizer or a
                volume boost here, so the book plays exactly as it was recorded.
              </Text>
            ) : null}

            <View style={{ gap: space.sm }}>
              <Label>PRESET</Label>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                {PRESETS.map((preset) => {
                  // Off is always available: it is the absence of an effect,
                  // and nobody should be asked to pay to turn something off.
                  const locked = !pro && preset.name !== 'off';
                  const active = settings.preset === preset.name;
                  const disabled = locked || (nothing && preset.name !== 'off');
                  return (
                    <Pressable
                      key={preset.name}
                      onPress={() => onPreset(preset.name)}
                      disabled={disabled}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active, disabled }}
                      accessibilityHint={preset.hint}
                      style={({ pressed }) => ({
                        minHeight: TOUCH,
                        justifyContent: 'center',
                        paddingHorizontal: space.md,
                        borderRadius: radius.button,
                        borderWidth: 1,
                        borderColor: active ? color.accent : color.border,
                        backgroundColor: active ? color.accentGlow : 'transparent',
                        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
                      })}
                    >
                      <Text
                        style={{
                          fontFamily: font.mono,
                          fontSize: 12,
                          color: active ? color.accent : color.paper,
                        }}
                      >
                        {preset.label}
                      </Text>
                    </Pressable>
                  );
                })}
                {settings.preset === 'custom' ? (
                  <View
                    style={{
                      minHeight: TOUCH,
                      justifyContent: 'center',
                      paddingHorizontal: space.md,
                      borderRadius: radius.button,
                      borderWidth: 1,
                      borderColor: color.accent,
                      backgroundColor: color.accentGlow,
                    }}
                  >
                    <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
                      Custom
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>

            {loudness ? (
              <Knob
                label="Boost"
                hint="How much louder than the recording"
                value={settings.boost}
                min={0}
                locked={!pro}
                onChange={(v) => onSlider('boost', v)}
              />
            ) : possible ? (
              <Unavailable label="Boost" reason={capabilities.loudness.reason} />
            ) : null}

            {equalizer ? (
              <>
                <Knob
                  label="Clarity"
                  hint="Lifts or softens the range speech sits in"
                  value={settings.clarity}
                  min={-100}
                  locked={!pro}
                  onChange={(v) => onSlider('clarity', v)}
                />
                <Knob
                  label="Warmth"
                  hint="Adds or removes body at the low end"
                  value={settings.warmth}
                  min={-100}
                  locked={!pro}
                  onChange={(v) => onSlider('warmth', v)}
                />
                <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.faint }}>
                  {capabilities.equalizer.bandCount}-band equalizer ·{' '}
                  {(capabilities.equalizer.minMillibels / 100).toFixed(0)} to{' '}
                  {(capabilities.equalizer.maxMillibels / 100).toFixed(0)} dB
                </Text>
              </>
            ) : possible ? (
              <Unavailable label="Clarity and Warmth" reason={capabilities.equalizer.reason} />
            ) : (
              <Unavailable label="Clarity and Warmth" reason="Android only" />
            )}

            <View style={{ gap: space.sm, paddingTop: space.md }}>
              <Label>THIS BOOK</Label>
              <Text style={{ fontFamily: font.sans, fontSize: 13, color: color.muted }}>
                {hasOwn
                  ? 'These settings are this book’s own.'
                  : 'This book is using your all-books default.'}
              </Text>
              <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
                <SmallButton
                  label="Use all-books default"
                  onPress={onUseDefault}
                  disabled={!hasOwn}
                />
                <SmallButton label="Make this the default" onPress={onMakeDefault} />
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Text style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 1, color: color.faint }}>
      {children}
    </Text>
  );
}

function Unavailable({ label, reason }: { label: string; reason?: string | null }) {
  return (
    <View style={{ gap: 2 }}>
      <Label>{label.toUpperCase()}</Label>
      <Text style={{ fontFamily: font.sans, fontSize: 13, color: color.faint }}>
        Not supported on this device{reason ? ` — ${reason}` : ''}
      </Text>
    </View>
  );
}

function SmallButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        minHeight: TOUCH,
        justifyContent: 'center',
        paddingHorizontal: space.md,
        borderRadius: radius.button,
        borderWidth: 1,
        borderColor: color.border,
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.paper }}>{label}</Text>
    </Pressable>
  );
}

/**
 * One control on the amp.
 *
 * `accessibilityRole="adjustable"` with increment and decrement is what makes
 * this usable without sight or fine motor control: the same ten-point step
 * the ends of the track give, reachable by swipe or by switch. The value is
 * spoken as a number rather than a position, because "forty" is actionable
 * and "forty per cent of the way along" is not.
 */
function Knob({
  label,
  hint,
  value,
  min,
  locked,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  locked: boolean;
  onChange: (value: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const max = 100;
  const span = max - min;
  const fraction = span > 0 ? (value - min) / span : 0;

  const valueAt = (x: number) => {
    if (width <= 0) return value;
    const ratio = Math.min(1, Math.max(0, x / width));
    return Math.round((min + ratio * span) / 5) * 5;
  };

  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => !locked,
    onMoveShouldSetPanResponder: () => !locked,
    onPanResponderGrant: (e) => onChange(valueAt(e.nativeEvent.locationX)),
    onPanResponderMove: (e) => onChange(valueAt(e.nativeEvent.locationX)),
  });

  return (
    <View style={{ gap: space.xs, opacity: locked ? 0.4 : 1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Label>{label.toUpperCase()}</Label>
        <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
          {value > 0 ? `+${value}` : value}
        </Text>
      </View>
      <View
        {...(locked ? {} : responder.panHandlers)}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        hitSlop={{ top: 12, bottom: 12, left: 0, right: 0 }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: locked }}
        accessibilityValue={{ min, max, now: value, text: `${value}` }}
        accessibilityActions={[
          { name: 'increment', label: `More ${label.toLowerCase()}` },
          { name: 'decrement', label: `Less ${label.toLowerCase()}` },
        ]}
        onAccessibilityAction={(e) => {
          if (locked) return;
          if (e.nativeEvent.actionName === 'increment') {
            onChange(Math.min(max, value + STEP));
          } else if (e.nativeEvent.actionName === 'decrement') {
            onChange(Math.max(min, value - STEP));
          }
        }}
        style={{ height: 26, justifyContent: 'center' }}
      >
        <View
          pointerEvents="none"
          style={{
            height: TRACK_HEIGHT,
            borderRadius: 1,
            backgroundColor: color.trough,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${fraction * 100}%`,
              height: '100%',
              backgroundColor: color.accent,
            }}
          />
          {/* The centre line, so a cut reads as a cut rather than a low setting. */}
          {min < 0 ? (
            <View
              style={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: 1,
                backgroundColor: color.groundDeep,
              }}
            />
          ) : null}
        </View>
        {width > 0 ? (
          <View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                left: Math.max(0, Math.min(width - 14, fraction * width - 7)),
                width: 14,
                height: 22,
                borderRadius: 3,
                backgroundColor: color.paperCard,
                borderWidth: 1,
                borderColor: color.woodDeep,
              },
              shadow(3, 0.4),
            ]}
          />
        ) : null}
      </View>
    </View>
  );
}
