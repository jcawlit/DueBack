/**
 * The Library header: title, the drive ("drawer") status button, sort chips and
 * the entry point to select mode.
 */

import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SORT_LABELS, type SortMode } from '@/data/types';
import { color, font, radius, space, TOUCH } from '@/theme/tokens';
import { DrawerIcon } from './icons';

const SORTS: SortMode[] = ['length', 'author', 'color', 'dust'];

export function DrawerButton({
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
            ? 'Drawer open, drive connected. Tap to check again.'
            : `Drawer shut, drive not reachable${lastSeenLabel ? `, last seen ${lastSeenLabel}` : ''}. Tap to look again.`
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
      <DrawerIcon size={20} stroke={connected ? color.paper : color.muted} />
      <Text
        style={{
          fontFamily: font.mono,
          fontSize: 11,
          color: connected ? color.paper : color.muted,
        }}
      >
        DRAWER
      </Text>
      {/* The lamp: filled and glowing when the drive is there, hollow when not. */}
      {checking ? (
        <ActivityIndicator size="small" color={color.accent} style={{ width: 7, height: 7 }} />
      ) : (
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: connected ? color.accent : 'transparent',
            borderWidth: connected ? 0 : 1.5,
            borderColor: '#8a7658',
            shadowColor: color.accent,
            shadowOpacity: connected ? 0.9 : 0,
            shadowRadius: 5,
            shadowOffset: { width: 0, height: 0 },
          }}
        />
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
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
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
              minHeight: 32,
              justifyContent: 'center',
              paddingHorizontal: 10,
              borderRadius: radius.chip,
              borderWidth: 1,
              borderColor: active ? color.accent : color.borderSoft,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: font.mono,
                fontSize: 12,
                color: active ? color.accent : color.muted,
              }}
            >
              {SORT_LABELS[mode]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function LibraryHeader({
  title,
  subtitle,
  connected,
  lastSeenLabel,
  onToggleDrawer,
  sort,
  onSort,
  selecting,
  onToggleSelect,
  checking,
  onOpenSettings,
}: {
  title: string;
  subtitle: string;
  connected: boolean;
  lastSeenLabel?: string;
  onToggleDrawer: () => void;
  checking?: boolean;
  onOpenSettings?: () => void;
  sort?: SortMode;
  onSort?: (next: SortMode) => void;
  selecting?: boolean;
  onToggleSelect?: () => void;
}) {
  return (
    <View
      style={{
        paddingTop: 22,
        paddingHorizontal: space.xl,
        paddingBottom: 14,
        gap: 14,
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
            style={{ fontFamily: font.serif, fontSize: 32, lineHeight: 34, color: color.paper }}
          >
            {title}
          </Text>
          <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
            {subtitle}
          </Text>
        </View>
        <DrawerButton
          connected={connected}
          onPress={onToggleDrawer}
          lastSeenLabel={lastSeenLabel}
          checking={checking}
        />
      </View>

      {sort && onSort ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: space.sm,
          }}
        >
          <View style={{ flex: 1 }}>
            <SortChips sort={sort} onChange={onSort} />
          </View>
          {onOpenSettings ? (
            <Pressable
              onPress={onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              style={({ pressed }) => ({
                minHeight: 32,
                flexShrink: 0,
                justifyContent: 'center',
                paddingHorizontal: 10,
                borderRadius: radius.chip,
                borderWidth: 1,
                borderColor: color.borderSoft,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.muted }}>
                settings
              </Text>
            </Pressable>
          ) : null}
          {onToggleSelect ? (
            <Pressable
              onPress={onToggleSelect}
              accessibilityRole="button"
              accessibilityState={{ selected: !!selecting }}
              accessibilityLabel={
                selecting ? 'Leave select mode' : 'Select several books to check out'
              }
              style={({ pressed }) => ({
                minHeight: 32,
                flexShrink: 0,
                justifyContent: 'center',
                paddingHorizontal: 10,
                borderRadius: radius.chip,
                borderWidth: 1,
                borderColor: selecting ? color.accent : color.borderSoft,
                backgroundColor: selecting ? color.accent : 'transparent',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text
                style={{
                  fontFamily: font.mono,
                  fontSize: 12,
                  color: selecting ? color.ground : color.muted,
                }}
              >
                {selecting ? 'done' : 'select'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
