/**
 * The paper slip, mounted once at the root so that a message raised from any
 * screen is actually drawn.
 *
 * Like `GlobalConfirm`, it belongs here rather than on each screen: a
 * navigation stack keeps the screens beneath the current one mounted, so a
 * copy on both Library and Settings would put two slips on screen at once.
 */

import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Slip } from './Slip';
import { MINI_PLAYER_COLLAPSED_HEIGHT, MINI_PLAYER_HEIGHT } from './MiniPlayer';
import { useLibrary } from '@/store/library';
import { usePlayer } from '@/store/player';
import { useUi } from '@/store/ui';
import { space } from '@/theme/tokens';

export function GlobalSlip() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const slip = useLibrary((s) => s.slip);
  const dismissSlip = useLibrary((s) => s.dismissSlip);
  const bottomObstruction = useUi((s) => s.bottomObstruction);
  const miniCollapsed = useUi((s) => s.miniPlayerCollapsed);
  const playerLoaded = usePlayer((s) => s.bookId !== null);

  if (!slip) return null;

  // Stack above whatever is already pinned to the bottom of this screen: the
  // Library's checked-out tray, and the mini player when one is floating.
  // Reading the route is the same trick the mini player uses, and saves every
  // other screen from having to reset the obstruction on its way out.
  const onLibrary = pathname === '/';
  const base = onLibrary ? bottomObstruction : insets.bottom;
  // The bar is two heights: the full strip, or the play button on its own
  // once it has been shut. Clearing the taller one either way would float the
  // slip well above a shut player for no reason.
  const barHeight = miniCollapsed ? MINI_PLAYER_COLLAPSED_HEIGHT : MINI_PLAYER_HEIGHT;
  const pill = playerLoaded && !pathname.startsWith('/player') ? barHeight : 0;

  return <Slip slip={slip} onDismiss={dismissSlip} bottom={base + pill + space.md} />;
}
