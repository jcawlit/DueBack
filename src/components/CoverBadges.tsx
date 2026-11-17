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
          backgroundColor: color.coverScrim,
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
        backgroundColor: color.coverScrimSoft,
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

/**
 * The DRM stamp, struck across the cover of a book that cannot be played.
 *
 * On the cover rather than only on the Book screen, because the point is to
 * stop someone trying: a library with a dozen Audible downloads should show
 * from the shelf which twelve those are. Scaled from the cover's width so it
 * reads the same on a tray thumbnail as on a hero cover.
 */
export function DrmStamp({ coverWidth }: { coverWidth: number }) {
  const unit = coverWidth / 86;
  const fontSize = Math.max(7, Math.round(11 * unit));

  return (
    <View
      accessible={false}
      pointerEvents="none"
      style={{
        borderWidth: Math.max(1, 1.5 * unit),
        borderColor: color.warning,
        borderRadius: 2,
        paddingHorizontal: Math.round(5 * unit),
        paddingVertical: Math.round(2 * unit),
        transform: [{ rotate: '-11deg' }],
        // The stamp sits on the artwork, so it needs to survive a dark cover
        // and a light one alike: an ink-coloured wash behind it does that
        // without hiding what is underneath.
        backgroundColor: color.groundWashSoft,
        opacity: 0.92,
        zIndex: 11,
      }}
    >
      <Text
        style={{
          fontFamily: font.monoMedium,
          fontSize,
          letterSpacing: Math.max(0.5, 1.4 * unit),
          color: color.warning,
        }}
      >
        DRM
      </Text>
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
      /*
       * A book you have finished says so, rather than being offered back.
       *
       * The alternative was a prompt at the end of the last chapter, and the
       * user's call was that returning is their decision and their timing: the
       * tray marks what is done and leaves it there until they say otherwise.
       */
      if (book.finishedAt) {
        return { label: long ? 'FINISHED' : 'DONE', variant: 'solid' as const };
      }
      return { label: long ? 'CHECKED OUT' : 'OUT', variant: 'solid' as const };
    case 'on-hold':
      return { label: long ? 'ON HOLD' : 'HOLD', variant: 'outline' as const };
    default:
      return null;
  }
}
