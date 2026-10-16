/**
 * The Library header: title, subtitle, the drive status button, the search
 * field and the sort chips.
 */

import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SORT_LABELS, type SortMode } from '@/data/types';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { DriveIcon, RefreshIcon, SearchIcon } from './icons';

const SORTS: SortMode[] = ['length', 'author'];

/**
 * The chip row's height. Deliberately under the 44pt touch minimum: these are
 * repeat, low-stakes controls in a row of their own with generous gaps, and the
 * header is the thing standing between the user and their shelves.
 */
const CHIP_HEIGHT = 28;

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
        The lamp when the drive is there, a circular arrow when it is not.
        An unlit lamp was honest and inert — it read as a verdict rather than
        as a button, so nobody knew the thing could be pressed to look again.
      */}
      {connected && !checking ? (
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: color.accent,
            shadowColor: color.accent,
            shadowOpacity: 0.9,
            shadowRadius: 5,
            shadowOffset: { width: 0, height: 0 },
          }}
        />
      ) : (
        <SpinningRefresh spinning={!!checking} stroke={checking ? color.accent : '#a8906c'} />
      )}
    </Pressable>
  );
}

export function SortChips({
  sort,
  onChange,
}: {
  sort: SortMode;
  onChange: (next: SortMode) => void;
}) {
  return (
    /*
     * One row that scrolls, rather than a block that wraps.
     *
     * Four chips plus the two beside them do not fit a phone, so the row
     * wrapped to two lines and the header ate a third of the screen before a
     * single cover was visible. Scrolling sideways keeps every sort reachable
     * and the row one line tall.
     */
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ flexDirection: 'row', gap: space.sm, paddingRight: space.sm }}
    >
      {SORTS.map((mode) => {
        const active = mode === sort;
        return (
          <Pressable
            key={mode}
            onPress={() => onChange(mode)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Sort ${SORT_LABELS[mode]}`}
            style={({ pressed }) => ({
              minHeight: CHIP_HEIGHT,
              justifyContent: 'center',
              paddingHorizontal: 9,
              borderRadius: radius.chip,
              borderWidth: 1,
              borderColor: active ? color.accent : color.borderSoft,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 11,
                color: active ? color.accent : color.muted,
              }}
            >
              {SORT_LABELS[mode]}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
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
}) {
  return (
    <View
      style={{
        paddingTop: 14,
        paddingHorizontal: space.xl,
        paddingBottom: 10,
        gap: 10,
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
        <View style={{ gap: space.xs, flexShrink: 1 }}>
          <Text
            accessibilityRole="header"
            style={{ fontFamily: font.serif, fontSize: 26, lineHeight: 28, color: color.paper }}
          >
            {title}
          </Text>
          <Text
            numberOfLines={1}
            style={{ fontFamily: font.mono, fontSize: 11, color: color.muted }}
          >
            {subtitle}
          </Text>
        </View>
        <DriveStatusButton
          connected={connected}
          onPress={onCheckDrive}
          lastSeenLabel={lastSeenLabel}
          checking={checking}
        />
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
            <SortChips sort={sort} onChange={onSort} />
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
