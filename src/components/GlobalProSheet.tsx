/**
 * The upgrade sheet, mounted once at the root.
 *
 * Same reasoning as `GlobalConfirm`: a navigation stack keeps the screens
 * beneath the current one mounted, so a copy on the Book screen and another
 * on the Library would put two identical sheets on screen together. Every
 * locked control in the app opens this one.
 */

import { ProSheet } from './ProSheet';
import { PRO_PRICE_FALLBACK, usePro } from '@/store/pro';

export function GlobalProSheet() {
  const open = usePro((s) => s.sheetOpen);
  const buying = usePro((s) => s.buying);
  const unavailableReason = usePro((s) => s.unavailableReason);
  const closeSheet = usePro((s) => s.closeSheet);
  const buy = usePro((s) => s.buy);
  const restore = usePro((s) => s.restore);

  return (
    <ProSheet
      visible={open}
      // Replaced by the localised, currency-correct string Google Play hands
      // back, once there is a Play to ask.
      price={PRO_PRICE_FALLBACK}
      unavailableReason={unavailableReason}
      busy={buying}
      onBuy={() => void buy()}
      onRestore={() => void restore()}
      onClose={closeSheet}
    />
  );
}
