/**
 * The mark on a control somebody has not paid for.
 *
 * Small, quiet, and always next to the thing it describes rather than
 * replacing it. With no trial, a dimmed control is the only advertisement
 * Pro gets — so the control stays on screen, dimmed, wearing this, and
 * pressing it opens `ProSheet` instead of doing nothing.
 *
 * A control that is simply missing teaches nobody anything.
 */

import { Pressable, Text, View } from 'react-native';
import { color, font, radius, space } from '@/theme/tokens';

/**
 * On the app's dark surfaces. `onPress` makes the tag itself a way into the
 * sheet, for the cases where the control it marks is disabled and cannot be
 * pressed at all.
 */
export function ProTag({
  onPress,
  label = 'PRO',
}: {
  onPress?: () => void;
  label?: string;
}) {
  const body = (
    <View
      style={{
        borderWidth: 1,
        borderColor: color.accent,
        borderRadius: radius.tag,
        paddingHorizontal: 5,
        paddingVertical: 1,
      }}
    >
      <Text
        style={{
          fontFamily: font.monoMedium,
          fontSize: 9,
          letterSpacing: 0.8,
          color: color.accent,
        }}
      >
        {label}
      </Text>
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. See what Due Back Pro adds.`}
      hitSlop={10}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      {body}
    </Pressable>
  );
}

/**
 * A whole feature, locked: one line saying what it is for, and a way in.
 *
 * For the places where there is no control to dim because the feature *is*
 * the screen — the statistics, and the characters tab before anyone has
 * bought it. Those would otherwise be blank, and a blank screen sells
 * nothing and explains less.
 */
export function ProLocked({
  title,
  body,
  onPress,
}: {
  title: string;
  body: string;
  onPress: () => void;
}) {
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.xxl,
        gap: space.sm,
      }}
    >
      <ProTag />
      <Text
        accessibilityRole="header"
        style={{
          fontFamily: font.serif,
          fontSize: 20,
          color: color.paper,
          textAlign: 'center',
          marginTop: space.xs,
        }}
      >
        {title}
      </Text>
      <Text
        style={{
          fontFamily: font.sans,
          fontSize: 13,
          lineHeight: 13 * 1.5,
          color: color.muted,
          textAlign: 'center',
        }}
      >
        {body}
      </Text>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => ({
          marginTop: space.sm,
          minHeight: 44,
          paddingHorizontal: space.xl,
          borderRadius: radius.button,
          borderWidth: 1,
          borderColor: color.accent,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
          What Pro adds
        </Text>
      </Pressable>
    </View>
  );
}
