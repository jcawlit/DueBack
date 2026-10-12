/**
 * The floating player that follows you around the app.
 *
 * Playback belongs to the app, not to the Player screen, so once something is
 * playing it should be pausable from anywhere and reachable in one tap —
 * rather than Library → Book → Player every time.
 *
 * It hides itself on the Player screen, where it would be redundant.
 */

import { Pressable, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLibrary, selectBook } from '@/store/library';
import { usePlayer } from '@/store/player';
import { useUi } from '@/store/ui';
import { color, font, radius, shadow, space } from '@/theme/tokens';
import { CoverFace } from './CoverFace';
import { PauseIcon, PlayIcon } from './icons';

/**
 * The pill's drawn height: 6px of padding top and bottom around a 38px play
 * button. Exported so anything that has to stack above it does not have to
 * measure it — see `GlobalSlip`.
 */
export const MINI_PLAYER_HEIGHT = 52;

export function MiniPlayer() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();

  const bookId = usePlayer((s) => s.bookId);
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const positionSec = usePlayer((s) => s.positionSec);
  const togglePlay = usePlayer((s) => s.togglePlay);
  const closePlayer = usePlayer((s) => s.close);

  const book = useLibrary(selectBook(bookId ?? undefined));
  const bottomObstruction = useUi((s) => s.bottomObstruction);

  // Nothing loaded, or we are already looking at the full player.
  if (!bookId || !book || pathname.startsWith('/player')) return null;

  // Only the Library pins anything tall to the bottom; everywhere else the
  // pill just clears the home indicator. Reading the route avoids every other
  // screen having to remember to reset the obstruction.
  const onLibrary = pathname === '/';
  const bottom = (onLibrary ? bottomObstruction : insets.bottom) + space.md;

  const fraction =
    book.durationSec > 0 ? Math.min(1, Math.max(0, positionSec / book.durationSec)) : 0;

  return (
    <View
      // Sits above whatever the current screen pins to the bottom.
      style={{
        position: 'absolute',
        right: space.lg,
        bottom,
        zIndex: 40,
        elevation: 24,
      }}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={() => router.push(`/player/${book.id}`)}
        // The only way to stop entirely and release the audio engine.
        onLongPress={() => void closePlayer()}
        delayLongPress={450}
        accessibilityRole="button"
        accessibilityLabel={`Now playing ${book.title}. Open the player.`}
        accessibilityHint="Long press to stop playing"
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingLeft: 6,
            paddingRight: 6,
            paddingVertical: 6,
            borderRadius: radius.button + 4,
            backgroundColor: color.panel,
            borderWidth: 1,
            borderColor: color.border,
            maxWidth: 260,
            opacity: pressed ? 0.85 : 1,
          },
          shadow(16, 0.55),
        ]}
      >
        <View style={{ borderRadius: 3, overflow: 'hidden' }}>
          <CoverFace book={book} size="tray" scale={0.52} />
        </View>

        <View style={{ flexShrink: 1, gap: 2, minWidth: 90 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: font.sans, fontSize: 12, color: color.paper }}
          >
            {book.title}
          </Text>
          {/* A hairline of progress, so the pill says where you are. */}
          <View
            style={{
              height: 2,
              borderRadius: 1,
              backgroundColor: color.troughDeep,
              overflow: 'hidden',
            }}
          >
            <View
              style={{ width: `${fraction * 100}%`, height: '100%', backgroundColor: color.accent }}
            />
          </View>
        </View>

        <Pressable
          onPress={togglePlay}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          hitSlop={10}
          style={({ pressed }) => ({
            width: 38,
            height: 38,
            borderRadius: 10,
            backgroundColor: color.accent,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.8 : 1,
          })}
        >
          {playing ? (
            <PauseIcon size={17} />
          ) : (
            <PlayIcon size={17} />
          )}
        </Pressable>
      </Pressable>

      {buffering ? (
        <Text
          style={{
            fontFamily: font.mono,
            fontSize: 9,
            color: color.faint,
            textAlign: 'right',
            paddingTop: 2,
          }}
        >
          loading…
        </Text>
      ) : null}
    </View>
  );
}
