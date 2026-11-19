/**
 * The player docked to the foot of every screen but its own.
 *
 * Playback belongs to the app, not to the Player screen, so once something is
 * playing it should be pausable from anywhere and reachable in one tap —
 * rather than Library → Book → Player every time.
 *
 * It hides itself on the Player screen, where it would be redundant.
 */

import { useRef } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLibrary, selectBook } from '@/store/library';
import { usePlayer } from '@/store/player';
import { useUi } from '@/store/ui';
import { chapterAt } from '@/data/types';
import { hoursClock } from '@/lib/format';
import { markLabel } from '@/lib/library/marks';
import { color, font, radius, shadow, space } from '@/theme/tokens';
import { CoverFace } from './CoverFace';
import { ChevronLeft, PauseIcon, PlayIcon } from './icons';

/**
 * The bar's own height, above the home inset. Exported so anything that
 * has to clear it — every scrolling screen, and `GlobalSlip` — does not
 * have to measure it.
 */
export const MINI_PLAYER_HEIGHT = 72;

/** The play button, which is the same size shut as it is open. */
const BUTTON_SIZE = 48;

/**
 * How much room the shut form occupies, for anything that has to float above
 * it. It reserves none of the screen — see `useMiniPlayerInset` — but it is
 * still drawn there, and a slip that came up underneath it would be covered.
 */
export const MINI_PLAYER_COLLAPSED_HEIGHT = BUTTON_SIZE + space.sm;

/**
 * The tab that says the shut player can be opened again.
 *
 * Narrow on purpose: shut, this whole thing has to sit in the gap at the end
 * of a shelf of three books without looking like a fourth.
 */
const TAB_WIDTH = 18;

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
  const collapsed = useUi((s) => s.miniPlayerCollapsed);
  if (!bookId || pathname.startsWith('/player')) return 0;
  /*
   * Shut, it reserves nothing. That is the whole point of shutting it: the
   * button floats in the gap at the end of a shelf rather than owning a strip
   * across the screen, and a list can run underneath it.
   */
  if (collapsed) return 0;
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
  const collapsed = useUi((s) => s.miniPlayerCollapsed);
  const setCollapsed = useUi((s) => s.setMiniPlayerCollapsed);
  /*
   * Set when the long press fires, applied when the finger comes up.
   *
   * Shutting the bar the instant the press is recognised swaps the tree out
   * from under a finger that is still down, and the release then lands on
   * whatever has appeared in that spot — which is the play button, because
   * the whole point is that it stays where it was. So the gesture is decided
   * at `onLongPress` and carried out at `onPressOut`, by which time there is
   * no touch left to misdeliver.
   */
  const shutOnRelease = useRef(false);

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
  const place = [chapter ? markLabel(book, chapter.index) : null, hoursClock(positionSec)]
    .filter(Boolean)
    .join(' · ');

  /*
   * The same button in both shapes, in the same place.
   *
   * Shutting the bar must not move the thing you were about to press. The bar
   * puts this at its right-hand end with `space.md` of padding, so the shut
   * form sits at the same offset from the same edge and the button does not
   * budge by a pixel.
   */
  const playPause = (
    <Pressable
      onPress={togglePlay}
      accessibilityRole="button"
      accessibilityLabel={playing ? 'Pause' : 'Play'}
      /*
       * No slop on the left. It used to be `8` on every side, which reached
       * back across the gap and over the tab beside it — and being the later
       * sibling, it won. Tapping the tab to open the bar toggled playback
       * instead.
       */
      hitSlop={{ top: 8, bottom: 8, right: 8 }}
      style={({ pressed }) => ({
        width: BUTTON_SIZE,
        height: BUTTON_SIZE,
        borderRadius: 12,
        backgroundColor: color.accent,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
    </Pressable>
  );

  if (collapsed) {
    /*
     * Shut: the button, and a tab saying there is more.
     *
     * Nothing is reserved for it — `useMiniPlayerInset` returns zero — so the
     * shelves run underneath and the button sits in the gap that is always
     * left at the end of a row of three books. The title and the place are
     * gone, which is the trade: the Player screen is one tap away and the
     * lock screen says what is playing anyway.
     */
    return (
      <View
        style={{
          position: 'absolute',
          right: space.md,
          bottom: bottom + (onLibrary ? 0 : insets.bottom) + space.sm,
          zIndex: 40,
          flexDirection: 'row',
          alignItems: 'center',
          ...shadow(10, 0.4),
        }}
      >
        <Pressable
          onPress={() => setCollapsed(false)}
          // Still the way to stop altogether, which the whole bar used to be.
          // Moved onto the smallest target on screen on purpose: it releases
          // the audio engine, and it was far too easy to do by accident on a
          // bar that filled the width of the phone.
          onLongPress={() => void closePlayer()}
          delayLongPress={600}
          accessibilityRole="button"
          accessibilityLabel={`Now playing ${book.title}. Open the player bar.`}
          accessibilityHint="Long press to stop playing"
          // Generous everywhere except towards the play button.
          hitSlop={{ top: 12, bottom: 12, left: 12 }}
          style={({ pressed }) => ({
            width: TAB_WIDTH,
            height: BUTTON_SIZE - 12,
            borderRadius: radius.button,
            // A real gap, not an overlap. These are two separate controls and
            // their touch areas must not meet.
            marginRight: space.xs,
            backgroundColor: color.panel,
            borderWidth: 1,
            borderRightWidth: 0,
            borderColor: color.borderSoft,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <ChevronLeft size={12} stroke={color.muted} />
        </Pressable>
        {playPause}
      </View>
    );
  }

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
        /*
         * Shuts the bar down to its play button. It used to **close**
         * playback outright — release the engine, forget the book — which is
         * a great deal of destruction to hang on the only gesture a
         * full-width bar has, and easy to do by accident.
         *
         * Stopping moved to a long press on the tab of the shut form: a
         * deliberate small target, reached by first putting the bar away.
         */
        onLongPress={() => {
          shutOnRelease.current = true;
        }}
        onPressOut={() => {
          if (!shutOnRelease.current) return;
          shutOnRelease.current = false;
          setCollapsed(true);
        }}
        delayLongPress={450}
        accessibilityRole="button"
        accessibilityLabel={`Now playing ${book.title}. Open the player.`}
        accessibilityHint="Long press to shut this bar down to its play button"
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

        {playPause}
      </Pressable>
    </View>
  );
}
