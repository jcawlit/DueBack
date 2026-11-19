/**
 * What this phone is entitled to, and how that survives being offline.
 *
 * The rules about *which* features an entitlement unlocks are in
 * `src/lib/pro.ts` and are pure. This holds the entitlement itself: where it
 * is read from, where it is written, and the one rule that matters more than
 * any of them.
 *
 * ## Offline must never downgrade you
 *
 * An audiobook is listened to on a plane, on the underground, in a basement,
 * in a country where somebody turned data off to avoid roaming. If the app
 * cannot reach Google Play it does **not** know that a purchase is absent —
 * it knows nothing at all, and those are different. Treating silence as "not
 * paid" would take the app away from somebody who bought it, at the exact
 * moment they cannot do anything about it.
 *
 * So the last answer is cached on the device and kept. Only Play saying
 * *"this account does not own it"* revokes anything; an error, a timeout or
 * no network at all leaves the cache exactly where it was.
 *
 * ## Why it is read synchronously
 *
 * Every gate is asked during render, by a screen deciding what to draw. An
 * entitlement that arrives a frame later means a Pro user watching their own
 * features flicker on at launch. So the cached value is loaded once at
 * startup alongside the other preferences and read straight out of state
 * from then on.
 */

import { create } from 'zustand';
import { SETTING_KEYS, getSetting, setSetting } from '@/db/schema';
import { FREE, PRE_LAUNCH, type Entitlement } from '@/lib/pro';

type ProState = {
  entitlement: Entitlement;
  /**
   * False until the cache has been read. Screens do not generally wait for
   * it — the starting value is the honest "unknown", and unknown is treated
   * as free so nothing paid-for is shown to somebody who has not got it.
   */
  loaded: boolean;

  /** Reads the cached entitlement. Called once, at startup. */
  load: () => Promise<void>;
  /**
   * Records what the store has told us, and caches it.
   *
   * Only ever called with an answer. Not being able to ask is not an answer
   * and must not reach this — see `couldNotAsk`.
   */
  set: (next: Entitlement) => Promise<void>;
  /**
   * Called when Play could not be reached at all.
   *
   * Does nothing on purpose, and exists so that the doing-nothing is written
   * down and can be tested. A caller that swallowed the error silently would
   * look identical right up until somebody changed it.
   */
  couldNotAsk: (why: string) => void;

  /*
   * The upgrade sheet, opened from wherever somebody met a locked control.
   *
   * Mounted once at the root like the confirmation dialog, for the same
   * reason: a navigation stack keeps the screens below the current one
   * mounted, so a copy on each screen would put several identical sheets up
   * at once.
   */
  sheetOpen: boolean;
  /** What the listener was reaching for. For the log, and for deciding later
   * which locked control actually sells the upgrade. */
  sheetFrom: string | null;
  openSheet: (from: string) => void;
  closeSheet: () => void;

  /** True while a purchase is in flight. */
  buying: boolean;
  /**
   * Why Pro cannot be bought right now, or null when it can.
   *
   * Non-null until billing is wired, which is the honest state: there is no
   * store to ask, and a button that looks ready and then fails is worse than
   * one that says so.
   */
  unavailableReason: string | null;
  buy: () => Promise<void>;
  restore: () => Promise<void>;
};

/**
 * Shown on the button. A string rather than a number because Google Play
 * hands back a localised, currency-correct one, and this is what it replaces.
 */
export const PRO_PRICE_FALLBACK = '$6.99';

const NO_STORE_YET = 'Not on the Play Store yet — this build has everything unlocked.';

/**
 * Whether there is a store to buy from yet.
 *
 * Flip this to `true` in the same change that wires `expo-iap`, and three
 * things follow at once: the buy button stops explaining itself, the
 * pre-launch grant in `load()` becomes `FREE`, and the entitlement switch in
 * Settings disappears from every build including release ones.
 *
 * That last part is why this is a constant and not `__DEV__`. The switch has
 * to be visible in the release APKs this app is actually tested with — a
 * `__DEV__` gate would hide it from exactly the builds that go on the phone —
 * and it must become unreachable the moment it could matter. One flag does
 * both, and it is greppable.
 */
export const BILLING_WIRED = false;

export const usePro = create<ProState>((set) => ({
  /*
   * Free until proven otherwise. Not `PRE_LAUNCH`: a first frame that shows
   * Pro features and then takes them away is worse than one that shows the
   * free app and then adds them.
   */
  entitlement: FREE,
  loaded: false,

  load: async () => {
    try {
      const cached = await getSetting(SETTING_KEYS.entitlement);
      if (cached === 'pro') {
        set({ entitlement: { pro: true, source: 'purchased' }, loaded: true });
        return;
      }
      if (cached === 'granted') {
        set({ entitlement: { pro: true, source: 'granted' }, loaded: true });
        return;
      }
      if (cached === 'free') {
        set({ entitlement: FREE, loaded: true });
        return;
      }
      /*
       * Nothing cached, which is every install until there is a store to buy
       * from. Everybody gets everything, recorded as a grant rather than a
       * purchase so that a support question gets an honest answer.
       *
       * This is the one line that changes when billing is wired: it becomes
       * `FREE`, and `expo-iap` is what writes anything else.
       */
      set({ entitlement: PRE_LAUNCH, loaded: true });
    } catch {
      // A database that will not answer is not evidence of anything. Leave
      // the entitlement alone and let the next launch try again.
      set({ loaded: true });
    }
  },

  set: async (next) => {
    set({ entitlement: next });
    const stored = !next.pro ? 'free' : next.source === 'granted' ? 'granted' : 'pro';
    try {
      await setSetting(SETTING_KEYS.entitlement, stored);
    } catch {
      // It is in memory for this run, and the next launch will ask again.
      // Failing the purchase over a failed write would be the wrong trade.
    }
  },

  couldNotAsk: (why) => {
    console.warn(`[pro] could not reach the store, keeping the cached entitlement: ${why}`);
  },

  sheetOpen: false,
  sheetFrom: null,
  openSheet: (from) => set({ sheetOpen: true, sheetFrom: from }),
  closeSheet: () => set({ sheetOpen: false }),

  buying: false,
  unavailableReason: NO_STORE_YET,

  /*
   * Both of these are shaped for `expo-iap` and do nothing yet. They exist
   * now so that every screen is already calling the right thing, and wiring
   * the store is a change to two function bodies rather than to the app.
   *
   * A purchase must end in `set(...)`, which is the only way an entitlement
   * is ever written — see the offline rule at the top of this file.
   */
  buy: async () => {
    console.warn('[pro] buy() called before billing is wired');
  },

  restore: async () => {
    console.warn('[pro] restore() called before billing is wired');
  },
}));

/**
 * A gate, as a hook.
 *
 *     const canTag = useGate(canUseCharacters);
 *
 * Reads the rule against the current entitlement and re-renders when it
 * changes, which is what makes a purchase take effect without a restart.
 */
export function useGate<T>(gate: (entitlement: Entitlement) => T): T {
  return usePro((s) => gate(s.entitlement));
}

/**
 * The same, outside React — for the stores, which are not components and
 * cannot use a hook.
 */
export function gate<T>(rule: (entitlement: Entitlement) => T): T {
  return rule(usePro.getState().entitlement);
}
