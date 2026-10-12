/**
 * What fills the Library before a folder has ever been chosen, and the progress
 * shown while the first scan runs.
 */

import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import type { ScanProgress } from '@/lib/scan/scanner';
import { DrawerIcon } from './icons';

export function FirstRun({ onPick, busy }: { onPick: () => void; busy: boolean }) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 32,
        gap: space.xl,
      }}
    >
      <View
        style={[
          {
            width: 150,
            height: 96,
            borderRadius: 6,
            borderWidth: 2,
            borderStyle: 'dashed',
            borderColor: color.border,
            alignItems: 'center',
            justifyContent: 'center',
            gap: space.sm,
            transform: [{ rotate: '-1deg' }],
          },
          shadow(10, 0.4),
        ]}
      >
        <DrawerIcon size={36} stroke={color.muted} />
      </View>

      <View style={{ gap: 10, alignItems: 'center' }}>
        <Text
          accessibilityRole="header"
          style={{
            fontFamily: font.serif,
            fontSize: 24,
            color: color.paper,
            textAlign: 'center',
          }}
        >
          Plug in your USB
        </Text>
        <Text
          style={{
            fontFamily: font.sans,
            fontSize: 15,
            lineHeight: 15 * 1.45,
            color: '#cbbb9e',
            textAlign: 'center',
          }}
        >
          {'…and show me where your audiobooks live. I’ll read the titles and covers, and leave the audio where it is.'}
        </Text>
      </View>

      <Pressable
        onPress={onPick}
        disabled={busy}
        accessibilityRole="button"
        style={({ pressed }) => [
          {
            minHeight: TOUCH + 8,
            paddingHorizontal: space.xxl,
            borderRadius: radius.button,
            backgroundColor: busy ? color.panel : color.accent,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.85 : 1,
          },
          busy ? null : shadow(8, 0.3),
        ]}
      >
        <Text
          style={{
            fontFamily: font.serif,
            fontSize: 17,
            color: busy ? color.muted : color.ground,
          }}
        >
          {busy ? 'Reading…' : 'Choose the folder'}
        </Text>
      </Pressable>
    </View>
  );
}

/** The line shown while a scan runs, over the shelves or the first-run screen. */
export function ScanProgressBar({ progress }: { progress: ScanProgress }) {
  const fraction =
    progress.booksTotal > 0 ? Math.min(1, progress.booksDone / progress.booksTotal) : 0;

  return (
    <View
      style={{
        paddingHorizontal: space.xl,
        paddingVertical: space.md,
        gap: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: color.line,
        backgroundColor: color.panel,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <ActivityIndicator size="small" color={color.accent} />
        <Text
          numberOfLines={1}
          style={{ flex: 1, fontFamily: font.mono, fontSize: 12, color: color.paper }}
        >
          {progress.message}
        </Text>
      </View>
      {progress.booksTotal > 0 ? (
        <View
          style={{
            height: 3,
            borderRadius: 2,
            backgroundColor: color.troughDeep,
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
        </View>
      ) : null}
    </View>
  );
}
