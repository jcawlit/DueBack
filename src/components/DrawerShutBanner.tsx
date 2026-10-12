/**
 * The slim notice that sits above the shelves while the drive is unreachable.
 *
 * The shelves stay browsable when the drawer is shut — the covers are cached
 * thumbnails, so there is no reason to hide the library just because the files
 * are out of reach. Tapping a cover's check-out tab places a hold instead of
 * failing, and this banner is what says so.
 */

import { Text, View } from 'react-native';
import { color, font, radius, space } from '@/theme/tokens';
import { DrawerIcon } from './icons';

export function DrawerShutBanner({
  lastSeenLabel,
  heldCount,
}: {
  lastSeenLabel: string;
  heldCount: number;
}) {
  return (
    <View
      style={{
        marginHorizontal: space.lg,
        marginTop: space.lg,
        padding: space.md,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: space.md,
        borderRadius: radius.button,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: color.border,
        backgroundColor: 'rgba(42,30,21,0.5)',
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <DrawerIcon size={20} stroke={color.muted} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ fontFamily: font.serif, fontSize: 16, color: color.paper }}>
          {`The drawer's shut.`}
        </Text>
        <Text
          style={{
            fontFamily: font.sans,
            fontSize: 13,
            lineHeight: 13 * 1.4,
            color: '#cbbb9e',
          }}
        >
          {heldCount > 0
            ? `${heldCount} ${heldCount === 1 ? 'book' : 'books'} on hold, waiting for the drive. Tap + to add more — they check out as soon as you plug in.`
            : 'These are cached covers, last seen ' +
              `${lastSeenLabel}. Tap + to put a book on hold and it'll check out the moment you plug in.`}
        </Text>
      </View>
    </View>
  );
}
