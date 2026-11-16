/**
 * The storage budget, as a number the Settings stepper can move.
 *
 * Kept pure and out of the screen so the stepping rules can be tested: every
 * other part of this feature is a modal and a press, and none of that can run
 * off a phone.
 *
 * The budget is a **preference**, not a measurement. It says how much of the
 * phone checked-out books may fill. It is deliberately allowed to sit below
 * what is already checked out — that is how someone says "no more until I
 * return something" — and deliberately allowed above the phone's free space,
 * because `FREE_SPACE_MARGIN_BYTES` in `src/lib/files/copy.ts` refuses a copy
 * on the facts whatever this says. Neither case is an error to be prevented
 * here; both are things the sheet tells the user about.
 */

const GB = 1024 * 1024 * 1024;

/** The one-tap sizes, in gigabytes. */
export const BUDGET_PRESETS_GB = [2, 4, 8, 16, 32] as const;

/** Floor. A budget of nothing is indistinguishable from the feature being off. */
export const MIN_BUDGET_GB = 1;

/**
 * Ceiling, well past any phone's storage.
 *
 * Not a claim about what will fit — the copy path decides that — just a stop
 * so the stepper cannot be held down into absurdity.
 */
export const MAX_BUDGET_GB = 512;

/**
 * How big one press of − or + is.
 *
 * A gigabyte while the numbers are small enough for that to be a meaningful
 * share of the budget, and four once it is not: going 64 → 65 is fourteen
 * presses of no consequence, and nobody budgeting in tens of gigabytes cares
 * about the odd one.
 */
export function stepGB(currentGB: number): number {
  if (currentGB < 8) return 1;
  if (currentGB < 32) return 2;
  return 4;
}

export function clampBudgetGB(gb: number): number {
  /*
   * Only NaN falls back to the floor, because only NaN says nothing about
   * which way it was going. An infinity does, and the clamp below carries it
   * to the right end on its own.
   */
  if (Number.isNaN(gb)) return MIN_BUDGET_GB;
  return Math.min(MAX_BUDGET_GB, Math.max(MIN_BUDGET_GB, Math.round(gb)));
}

/**
 * The next size up.
 *
 * Snapped onto the step grid rather than added to blindly, so a budget
 * restored from an odd stored value — or left behind by a change to the steps
 * — tidies itself up on the first press instead of carrying the oddness
 * forward for ever.
 */
export function nextBudgetGB(currentGB: number): number {
  const current = clampBudgetGB(currentGB);
  const step = stepGB(current);
  return clampBudgetGB(Math.floor(current / step) * step + step);
}

/** The next size down, on the same grid, never below the floor. */
export function previousBudgetGB(currentGB: number): number {
  const current = clampBudgetGB(currentGB);
  // The step for the size being left, so 8 → 7 rather than 8 → 6: coming down
  // off a boundary should undo the press that went up through it.
  const step = stepGB(current - 1);
  const snapped = Math.ceil(current / step) * step - step;
  return clampBudgetGB(snapped);
}

export const gbToBytes = (gb: number) => clampBudgetGB(gb) * GB;

/** Rounded, because a stored byte count need not land on a whole gigabyte. */
export const bytesToGB = (value: number) => clampBudgetGB(value / GB);
