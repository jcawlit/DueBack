/**
 * The player docked to the foot of every screen but its own.
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
import { chapterAt } from '@/data/types';
import { hoursClock } from '@/lib/format';
import { color, font, shadow, space } from '@/theme/tokens';
import { CoverFace } from './CoverFace';
import { PauseIcon, PlayIcon } from './icons';

/**
 * The bar's own height, above the home inset. Exported so anything that
 * has to clear it — every scrolling screen, and `GlobalSlip` — does not
 * have to measure it.
 */
export const MINI_PLAYER_HEIGHT = 72;

/**
 * How much room a scrolling screen must leave at its foot.
 *
 * Zero when nothing is playing, or on the Player itself, where the bar is
 * not drawn. Every screen that scrolls adds this to its bottom padding, so
 * the last line of a list is readable rather than parked behind the bar.
 */
export function useMiniPlayerInset(): number {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const bookId = usePlayer((s) => s.bookId);
  if (!bookId || pathname.startsWith('/player')) return 0;
  return MINI_PLAYER_HEIGHT + (pathname === '/' ? 0 : insets.bottom);
}

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

  /*
   * Docked, not floating.
   *
   * It was a pill hovering over the bottom-right corner, which meant it
   * covered whatever happened to be under it and had to be small enough
   * not to cover much. A bar across the foot of the screen owns its space
   * instead: screens pad themselves by MINI_PLAYER_HEIGHT and nothing is
   * ever hidden behind it.
   *
   * The Library still pins its checked-out tray to the bottom, so there
   * the bar sits on top of that rather than on the screen's edge.
   */
  const onLibrary = pathname === '/';
  const bottom = onLibrary ? bottomObstruction : 0;

  const fraction =
    book.durationSec > 0 ? Math.min(1, Math.max(0, positionSec / book.durationSec)) : 0;

  const chapter = book.chapters.length > 0 ? chapterAt(book, positionSec) : null;
  const place = [chapter ? `Ch. ${chapter.index + 1}` : null, hoursClock(positionSec)]
    .filter(Boolean)
    .join(' · ');

  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom,
        zIndex: 40,
        backgroundColor: color.panel,
        borderTopWidth: 1,
        borderTopColor: color.borderSoft,
        // The home inset is only ours to clear when we are sitting on the
        // screen's edge; on the Library the tray below us has already done it.
        paddingBottom: onLibrary ? 0 : insets.bottom,
        ...shadow(14, 0.45),
      }}
    >
      {/* How far through the book, drawn on the bar's own top edge. */}
      <View style={{ height: 2, backgroundColor: color.troughDeep }}>
        <View style={{ width: `${fraction * 100}%`, height: 2, backgroundColor: color.accent }} />
      </View>

      <Pressable
        onPress={() => router.push(`/player/${book.id}`)}
        // The only way to stop entirely and release the audio engine.
        onLongPress={() => void closePlayer()}
        delayLongPress={450}
        accessibilityRole="button"
        accessibilityLabel={`Now playing ${book.title}. Open the player.`}
        accessibilityHint="Long press to stop playing"
        style={({ pressed }) => ({
          height: MINI_PLAYER_HEIGHT - 2,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          paddingLeft: space.lg,
          paddingRight: space.md,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <View style={{ borderRadius: 2, overflow: 'hidden' }}>
          <CoverFace book={book} size="tray" scale={0.52} />
        </View>

        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: font.sans, fontSize: 15, color: color.paper }}
          >
            {book.title}
          </Text>
          <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
            {buffering ? 'loading…' : place}
          </Text>
        </View>

        <Pressable
          onPress={togglePlay}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          hitSlop={8}
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            borderRadius: 12,
            backgroundColor: color.accent,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.8 : 1,
          })}
        >
          {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </Pressable>
      </Pressable>
    </View>
  );
}
