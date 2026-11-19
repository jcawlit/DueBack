/**
 * The Library header: title, subtitle, the drive status button, the search
 * field and the sort chips.
 */

import { useEffect, useState } from 'react';
import type { SwitchableSource } from '@/store/sources';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SORT_LABELS, type SortMode } from '@/data/types';
import { FitText } from './FitText';
import { color, font, radius, shadow, space, TOUCH } from '@/theme/tokens';
import { ChevronDown, DriveIcon, RefreshIcon, SearchIcon } from './icons';

/*
 * The order the chips sit in: the two that arrange the whole library, the
 * three that answer a question about it, then the one you arrange yourself.
 */
const SORTS: SortMode[] = [
  'length',
  'author',
  'series',
  'narrator',
  'dust',
  'unfinished',
  'custom',
];

/**
 * The chip row's height. Deliberately under the 44pt touch minimum: these are
 * repeat, low-stakes controls in a row of their own with generous gaps, and the
 * header is the thing standing between the user and their shelves.
 */
const CHIP_HEIGHT = 26;

/**
 * The circular arrow, turning while the drive is being looked for.
 *
 * Driven by `Animated` rather than an `ActivityIndicator` because the spinner
 * said "busy" without saying what it had replaced: this is the same glyph that
 * invites the tap, now moving, so the button plainly reports that the tap
 * landed and something is happening. Looking for the drive is usually over in
 * a few milliseconds — fast enough that the caller holds this on screen for a
 * moment, or the answer appears to arrive before the question.
 */
function SpinningRefresh({ spinning, stroke }: { spinning: boolean; stroke: string }) {
  // Held in state rather than a ref, as Slip does: a ref read during render
  // is what the rules of hooks are there to stop.
  const [turn] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!spinning) {
      turn.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spinning, turn]);

  return (
    <Animated.View
      style={{
        transform: [
          { rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
        ],
      }}
    >
      <RefreshIcon size={13} stroke={stroke} />
    </Animated.View>
  );
}

/**
 * The source switcher, which only exists once there is something to switch to.
 *
 * With no server configured this is never rendered and the drive button is
 * exactly what it has always been — one tap, "look for the drive". That is
 * deliberate: the USB library is the app, and it should not grow a chooser
 * with one item in it to serve a feature nobody has turned on.
 *
 * Once a server is there, the pill becomes the current source's name and
 * tapping it cycles. Cycling rather than opening a menu because there are
 * two or three of these, and a sheet for that is more furniture than choice.
 */
/** What the light means, in words, for whoever cannot see it. */
function readyLabel(source: SwitchableSource): string {
  if (source.ready === null) return 'not checked yet';
  if (source.kind === 'usb') return source.ready ? 'drive connected' : 'drive not connected';
  return source.ready ? 'signed in' : 'needs signing in again';
}

/**
 * Whether the thing beside it is good to use: green yes, red no.
 *
 * One definition for every source, because two of them disagreeing is how a
 * listener learns to distrust both. The drive used to show an **amber lamp
 * when connected and nothing at all when not** — a circular arrow took its
 * place, on the reasoning that an unlit lamp "read as a verdict rather than
 * as a button, so nobody knew the thing could be pressed to look again". The
 * reasoning was sound and the result was not: nothing on screen distinguished
 * "no drive" from "not checked", and the server beside it had no light at
 * all.
 *
 * A red dot answers the original worry differently. An unlit lamp is absence;
 * a red one is a state, and a state invites doing something about it. The
 * dashed border and the label still say the button can be pressed.
 *
 * `null` is "not knowable without asking" and shows nothing, which is honest
 * about the one case it covers: a drive whose state has not been polled yet.
 *
 * The palette's own olive and red, not signal colours — beside this paper and
 * lamp amber a pure #0f0 would look like a different app.
 */
export function StatusDot({
  ready,
  checking = false,
}: {
  ready: boolean | null;
  /** A look is in flight: hollow, so pressing is visibly doing something. */
  checking?: boolean;
}) {
  if (ready === null && !checking) return null;
  return (
    <View
      style={{
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: checking ? 'transparent' : ready ? color.checkout : color.warning,
        borderWidth: checking ? 1 : 0,
        borderColor: color.muted,
        ...(ready && !checking
          ? {
              // The lamp glow the drive button always had, kept for the
              // connected case because it is what "live" looks like here.
              shadowColor: color.checkout,
              shadowOpacity: 0.9,
              shadowRadius: 5,
              shadowOffset: { width: 0, height: 0 },
            }
          : null),
      }}
    />
  );
}

export function SourceSwitcher({
  sources,
  activeId,
  onSelect,
  checking,
  onCheck,
}: {
  sources: SwitchableSource[];
  activeId: string;
  onSelect: (id: string) => void;
  /** A look at the active source is in flight. */
  checking: boolean;
  /**
   * Look at the active source again: the drive for the drive, a catalogue
   * refresh for a server. Both prove the same thing — that the source can
   * actually be reached — and both hang off the same long-press, so the
   * gesture means one thing wherever you are.
   */
  onCheck: (source: SwitchableSource) => void;
}) {
  const index = Math.max(0, sources.findIndex((s) => s.id === activeId));
  const active = sources[index] ?? sources[0];
  const next = sources[(index + 1) % sources.length];

  return (
    <Pressable
      onPress={() => onSelect(next.id)}
      /*
       * Long-press looks for the drive.
       *
       * Once a server is configured this button's tap is spent on switching
       * sources, which left no way to ask "is the drive there?" from the one
       * place showing whether it is — the only route was Settings. Long-press
       * is the app's existing idiom for a second action on a thing.
       */
      onLongPress={() => onCheck(active)}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${active.label}: ${readyLabel(active)}. Tap to switch to ${
        next.label
      }. Press and hold to look again.`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: TOUCH,
        paddingHorizontal: space.md,
        borderRadius: radius.button,
        backgroundColor: color.panel,
        borderWidth: 1,
        borderColor: color.border,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <DriveIcon size={20} stroke={color.paper} />
      <Text numberOfLines={1} style={{ fontFamily: font.mono, fontSize: 11, color: color.paper }}>
        {active.label.toUpperCase()}
      </Text>
      <StatusDot ready={active.ready} checking={checking} />
      <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}>
        {sources.length > 1 ? '⇄' : ''}
      </Text>
    </Pressable>
  );
}

export function DriveStatusButton({
  connected,
  onPress,
  lastSeenLabel,
  checking,
}: {
  connected: boolean;
  onPress: () => void;
  lastSeenLabel?: string;
  /** True while the drive is being re-checked, after a tap. */
  checking?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        checking
          ? 'Looking for the drive'
          : connected
            ? 'Drive connected. Tap to check again.'
            : `Drive not connected${lastSeenLabel ? `, last seen ${lastSeenLabel}` : ''}. Tap to look again.`
      }
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: TOUCH,
        paddingHorizontal: space.md,
        borderRadius: radius.button,
        backgroundColor: connected ? color.panel : 'transparent',
        borderWidth: 1,
        borderStyle: connected ? 'solid' : 'dashed',
        borderColor: color.border,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <DriveIcon size={20} stroke={connected ? color.paper : color.muted} />
      <Text
        style={{
          fontFamily: font.mono,
          fontSize: 11,
          color: connected ? color.paper : color.muted,
        }}
      >
        DRIVE
      </Text>
      {/*
        The same light the source pill shows, so the drive does not describe
        itself one way with a server configured and another way without. See
        `StatusDot` for what replaced the amber lamp, and why.

        The circular arrow stays while a look is in flight: that is the part
        of the old design that was doing real work, saying the press landed.
      */}
      {checking ? (
        <SpinningRefresh spinning stroke={color.accent} />
      ) : (
        <StatusDot ready={connected} />
      )}
    </Pressable>
  );
}

/**
 * The sort, as one control that opens a list.
 *
 * It was a row of chips that scrolled sideways. Two sorts fitted, four
 * were a scroll, and seven meant the one you wanted was always off the
 * edge — a control you have to drag before you can read it is not a
 * control. A closed dropdown says what is in force, which is the thing
 * you most often want to know, and the list says what else there is.
 */
export function SortPicker({
  sort,
  onChange,
}: {
  sort: SortMode;
  onChange: (next: SortMode) => void;
}) {
  const [open, setOpen] = useState(false);

  const pick = (next: SortMode) => {
    setOpen(false);
    if (next !== sort) onChange(next);
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Sorted ${SORT_LABELS[sort]}. Change.`}
        style={({ pressed }) => ({
          minHeight: CHIP_HEIGHT,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          alignSelf: 'flex-start',
          paddingLeft: 10,
          paddingRight: 7,
          borderRadius: radius.chip,
          borderWidth: 1,
          borderColor: color.accent,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
          {SORT_LABELS[sort]}
        </Text>
        <ChevronDown size={13} stroke={color.accent} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          onPress={() => setOpen(false)}
          accessibilityLabel="Dismiss"
          style={{
            flex: 1,
            backgroundColor: color.scrim,
            justifyContent: 'flex-end',
            padding: space.xl,
          }}
        >
          <Pressable
            onPress={() => {}}
            style={[
              { backgroundColor: color.panel, borderRadius: 6, paddingVertical: space.sm },
              shadow(20, 0.6),
            ]}
          >
            <Text
              accessibilityRole="header"
              style={{
                fontFamily: font.mono,
                fontSize: 10,
                letterSpacing: 1,
                color: color.faint,
                paddingHorizontal: space.xl,
                paddingTop: space.sm,
                paddingBottom: space.md,
              }}
            >
              ARRANGE THE SHELVES
            </Text>
            {SORTS.map((mode) => {
              const active = mode === sort;
              return (
                <Pressable
                  key={mode}
                  onPress={() => pick(mode)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={SORT_LABELS[mode]}
                  style={({ pressed }) => ({
                    minHeight: TOUCH,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: space.md,
                    paddingHorizontal: space.xl,
                    backgroundColor: pressed ? color.line : 'transparent',
                  })}
                >
                  <Text
                    style={{
                      fontFamily: font.serif,
                      fontSize: 17,
                      color: active ? color.accent : color.paper,
                    }}
                  >
                    {SORT_LABELS[mode]}
                  </Text>
                  {active ? (
                    <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                      on
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function LibraryHeader({
  title,
  subtitle,
  connected,
  lastSeenLabel,
  onCheckDrive,
  sort,
  onSort,
  checking,
  onOpenSettings,
  search,
  onSearch,
  sources,
  activeSourceId,
  onSelectSource,
  onCheckSource,
}: {
  title: string;
  subtitle: string;
  connected: boolean;
  lastSeenLabel?: string;
  onCheckDrive: () => void;
  checking?: boolean;
  onOpenSettings?: () => void;
  sort?: SortMode;
  onSort?: (next: SortMode) => void;
  search?: string;
  onSearch?: (next: string) => void;
  /**
   * Every place a library can come from. One entry means the drive alone,
   * which is the normal state and renders the drive button unchanged.
   */
  sources?: SwitchableSource[];
  activeSourceId?: string;
  onSelectSource?: (id: string) => void;
  /**
   * Look at the active source again, from a long-press on the pill. The drive
   * for the drive, a catalogue refresh for a server.
   */
  onCheckSource?: (source: SwitchableSource) => void;
}) {
  return (
    <View
      style={{
        /*
         * About a tenth off every vertical measurement in here — the title,
         * the padding, the gaps, the chips. The header is the thing standing
         * between somebody and their shelves, and at full size it was taking
         * more of a phone than it earns.
         */
        paddingTop: 12,
        paddingHorizontal: space.xl,
        paddingBottom: 9,
        gap: 9,
        borderBottomWidth: 1,
        borderBottomColor: color.line,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: space.md,
        }}
      >
        {/*
          `flex: 1` rather than `flexShrink: 1`, so this column is handed the
          row minus the switcher and `FitText` has a width to measure. Shrink
          alone sizes the column to its text, which tells the text nothing.
        */}
        <View style={{ gap: space.xs, flex: 1, minWidth: 0 }}>
          {/*
            Both of these reserve the full size's line height however far the
            text shrinks, which is what keeps this column — and so the divider
            and the chips below it — at one height whichever source is showing.
            See `fittedText`.
          */}
          <FitText
            accessibilityRole="header"
            size={23}
            // Below about 16 a title at this size stops reading as the title.
            minSize={16}
            face="serif"
            lineHeightRatio={1.08}
            style={{ fontFamily: font.serif, color: color.paper }}
          >
            {title}
          </FitText>
          <FitText
            size={10}
            // Mono at 9 is still legible; past that the ellipsis is kinder.
            minSize={9}
            face="mono"
            lineHeightRatio={1.3}
            style={{ fontFamily: font.mono, color: color.muted }}
          >
            {subtitle}
          </FitText>
        </View>
        {sources && sources.length > 1 && activeSourceId && onSelectSource ? (
          <SourceSwitcher
            sources={sources}
            activeId={activeSourceId}
            onSelect={onSelectSource}
            checking={checking ?? false}
            onCheck={(source) => onCheckSource?.(source)}
          />
        ) : (
          <DriveStatusButton
            connected={connected}
            onPress={onCheckDrive}
            lastSeenLabel={lastSeenLabel}
            checking={checking}
          />
        )}
      </View>

      {onSearch ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingHorizontal: space.md,
            borderRadius: radius.button,
            borderWidth: 1,
            borderColor: color.line,
            backgroundColor: color.panel,
          }}
        >
          <SearchIcon size={16} stroke={color.muted} />
          <TextInput
            value={search ?? ''}
            onChangeText={onSearch}
            placeholder="Search titles, authors, narrators"
            placeholderTextColor={color.faint}
            accessibilityLabel="Search the library"
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            style={{
              flex: 1,
              minHeight: 40,
              fontFamily: font.sans,
              fontSize: 15,
              color: color.paper,
              // Android pads text inputs generously by default, which makes
              // the field taller than the row it sits in.
              paddingVertical: 0,
            }}
          />
          {search ? (
            <Pressable
              onPress={() => onSearch('')}
              accessibilityRole="button"
              accessibilityLabel="Clear the search"
              hitSlop={10}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, padding: 4 })}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 15, color: color.muted }}>×</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {sort && onSort ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
          }}
        >
          {/* minWidth 0 so the scroller gives way to the two fixed chips
              instead of pushing them off the edge. */}
          <View style={{ flex: 1, minWidth: 0 }}>
            <SortPicker sort={sort} onChange={onSort} />
          </View>
          {onOpenSettings ? (
            <Pressable
              onPress={onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              style={({ pressed }) => ({
                minHeight: CHIP_HEIGHT,
                flexShrink: 0,
                justifyContent: 'center',
                paddingHorizontal: 9,
                borderRadius: radius.chip,
                borderWidth: 1,
                // The lamp, not the furniture. It sits in a row of filters
                // and is not one: everything else there changes what you
                // are looking at, this leaves the library altogether.
                borderColor: color.accent,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.accent }}>
                settings
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
