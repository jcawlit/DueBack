/**
 * The marks that sit on top of a cover: the status tag, the visible check-out
 * tab, the copy-in-progress overlay and the select-mode tick.
 *
 * The tab exists because long-press alone is not a discoverable affordance — a
 * cover always shows, in one glance and one tap, whether the book is on the
 * phone and how to change that.
 */

import { Pressable, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import { color, font, radius, shadow } from '@/theme/tokens';
import { CheckIcon, HoldIcon, PlusIcon } from './icons';

/** Amber tag for a book on the phone, outlined tag for one still queued. */
export function StatusTag({
  label,
  variant = 'solid',
  rotate = 3,
}: {
  label: string;
  variant?: 'solid' | 'outline';
  rotate?: number;
}) {
  const solid = variant === 'solid';
  return (
    <View
      style={[
        {
          backgroundColor: solid ? color.accent : color.ground,
          borderWidth: solid ? 0 : 1,
          borderColor: color.accent,
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: radius.tag,
          transform: [{ rotate: `${rotate}deg` }],
          // Above the neighbouring cover, which carries elevation 6.
          zIndex: 12,
        },
        shadow(12, 0.4),
      ]}
    >
      <Text
        style={{
          fontFamily: font.monoMedium,
          fontSize: 10,
          letterSpacing: 0.6,
          color: solid ? color.ground : color.accent,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export type TabState = 'on-shelf' | 'on-hold' | 'checked-out';

/**
 * The corner tab: "+" to check a book out, a tick once it is on the phone, an
 * hourglass while it waits for the drive. The visual is 26px so it does not
 * swallow the cover, with hitSlop bringing the touch target up to 44px.
 */
export function CornerTab({
  state,
  onPress,
  accessibilityLabel,
  size = 26,
}: {
  state: TabState;
  onPress: () => void;
  accessibilityLabel: string;
  size?: number;
}) {
  const slop = Math.max(0, Math.round((44 - size) / 2));
  const look =
    state === 'checked-out'
      ? { bg: color.accent, border: color.accent, ink: color.ground }
      : state === 'on-hold'
        ? { bg: color.ground, border: color.accent, ink: color.accent }
        : { bg: 'rgba(27,20,16,0.86)', border: color.border, ink: color.paper };

  return (
    <Pressable
      onPress={onPress}
      hitSlop={slop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: 3,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: look.bg,
          borderWidth: 1,
          borderColor: look.border,
          transform: [{ rotate: '-2deg' }, { scale: pressed ? 0.92 : 1 }],
          // Above the cover it sits on, which carries elevation 6.
          zIndex: 12,
        },
        shadow(12, 0.45),
      ]}
    >
      {state === 'checked-out' ? (
        <CheckIcon size={size * 0.54} stroke={look.ink} />
      ) : state === 'on-hold' ? (
        <HoldIcon size={size * 0.54} stroke={look.ink} />
      ) : (
        <PlusIcon size={size * 0.54} stroke={look.ink} />
      )}
    </Pressable>
  );
}

/**
 * Scrim plus a filling bar, shown on the cover while the copy runs. On a tray
 * thumbnail there is only room for the number, so the bar and caption drop away.
 */
export function CopyOverlay({
  progress,
  width,
  onCancel,
}: {
  progress: number;
  width: number;
  /** Shows a Cancel control; omitted on thumbnails, which have no room. */
  onCancel?: () => void;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  const compact = width < 70;

  if (compact) {
    return (
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(18,13,10,0.74)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={{ fontFamily: font.monoMedium, fontSize: 12, color: color.accent }}>
          {pct}%
        </Text>
      </View>
    );
  }

  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(18,13,10,0.62)',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <Text style={{ fontFamily: font.monoMedium, fontSize: 12, color: color.accent }}>
        {pct}%
      </Text>
      <View
        style={{
          width: width * 0.62,
          height: 4,
          borderRadius: 2,
          backgroundColor: color.troughDeep,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${pct}%`,
            height: '100%',
            backgroundColor: color.accent,
          }}
        />
      </View>
      <Text style={{ fontFamily: font.mono, fontSize: 9, letterSpacing: 0.8, color: color.muted }}>
        CHECKING OUT
      </Text>
      {onCancel ? (
        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Stop copying"
          hitSlop={10}
          style={({ pressed }) => ({
            marginTop: 2,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 3,
            borderWidth: 1,
            borderColor: color.border,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontFamily: font.mono, fontSize: 9, color: color.paper }}>
            cancel
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Select mode: an amber tick in the corner of chosen covers. */
export function SelectBadge({ selected }: { selected: boolean }) {
  return (
    <View
      style={[
        {
          width: 24,
          height: 24,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: selected ? color.accent : 'rgba(18,13,10,0.78)',
          borderWidth: 1.5,
          borderColor: selected ? color.accent : color.border,
          zIndex: 12,
        },
        shadow(12, 0.4),
      ]}
    >
      {selected ? <CheckIcon size={13} stroke={color.ground} /> : null}
    </View>
  );
}

/**
 * The tag a cover should show, if any. Returns null for a book that is simply
 * on the shelf, which is the quiet default.
 */
export function tagForBook(book: Book, long = false) {
  switch (book.local.status) {
    case 'checked-out':
      return { label: long ? 'CHECKED OUT' : 'OUT', variant: 'solid' as const };
    case 'on-hold':
      return { label: long ? 'ON HOLD' : 'HOLD', variant: 'outline' as const };
    default:
      return null;
  }
}

export function tabStateForBook(book: Book): TabState {
  if (book.local.status === 'checked-out') return 'checked-out';
  if (book.local.status === 'on-hold') return 'on-hold';
  return 'on-shelf';
}
