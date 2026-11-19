/**
 * What is paid for, what never is, and the rules that decide.
 *
 * Everything here is pure: it takes an entitlement and answers a question
 * about one feature. Nothing in this file knows how an entitlement is
 * obtained, cached or verified — that is `src/store/pro.ts` — which is what
 * lets every rule below be tested in Node against a made-up entitlement.
 *
 * ## The three promises
 *
 * These hold whatever anyone has or has not paid for, and the tests exist to
 * keep them true:
 *
 * 1. **Whatever you wrote, you can read.** Not being Pro never hides a note,
 *    a bookmark or a character you already made.
 * 2. **Whatever you wrote, you can export.** An export is always complete.
 *    Holding someone's own words out of their own file is not a business
 *    model this app will have.
 * 3. **Your library leaves with you.** Backup and restore are never gated,
 *    and nor is anything needed to listen to a book you own.
 *
 * Pro gates **making new things**, never seeing or keeping old ones. That
 * distinction is the whole design, and it was not always honoured: three
 * gates here used to strip characters out of exports and hide them from the
 * notes view, which nobody noticed because `isPro()` returned `true` for
 * everyone from the day it was written.
 *
 * ## Why gates are named after features
 *
 * Call sites ask `canUseCharacters(e)`, never `e.pro`. Today every gate
 * answers from the same boolean, so the indirection looks like nothing — but
 * it is what makes the split changeable. Moving a feature between tiers, or
 * splitting Pro in two, is an edit to one function here rather than a hunt
 * through the screens.
 *
 * ## Why it imports nothing
 *
 * Not tidiness: it is what lets `node --test` load this file directly. A
 * value imported through the `@/` alias cannot be resolved outside the
 * bundler, so a single runtime import here would mean every rule below could
 * only be tested through a harness. The two constants it would have wanted —
 * the largest budget and the name of the default theme — are passed in or
 * duplicated with a test pinning the agreement.
 */

/**
 * What this phone is entitled to, and on what grounds.
 *
 * One flag, not one per feature. The alternative — a field per feature — was
 * considered and rejected: with a single purchase that unlocks everything,
 * every such field is permanently equal to every other, which is eight ways
 * for them to disagree in exchange for flexibility nothing uses. The gates
 * below provide that flexibility instead, in one place.
 *
 * `source` is what makes grants possible without a second flag:
 *
 * - `purchased` — Google Play says this account owns it.
 * - `granted` — given without payment. A beta tester, a promotion, or the
 *   pre-launch state where everybody has everything.
 * - `none` — the free app, which is most of the app.
 */
export type Entitlement = {
  pro: boolean;
  source: 'purchased' | 'granted' | 'none';
};

export const FREE: Entitlement = { pro: false, source: 'none' };

/**
 * What everybody has until there is a store to buy from.
 *
 * Deliberately `granted` rather than `purchased`: nothing has been bought,
 * and a log or a support question should say so honestly.
 */
export const PRE_LAUNCH: Entitlement = { pro: true, source: 'granted' };

/* ------------------------------------------------------------------ *
 * Free, and staying that way. Written as functions rather than left
 * implicit so that the promises above are greppable, and so that a future
 * change of heart has to delete a stated rule rather than quietly add a
 * condition somewhere.
 * ------------------------------------------------------------------ */

/** Notes and bookmarks. Jotting a thought while listening is not a luxury. */
export function canWriteNotes(_e: Entitlement): boolean {
  return true;
}

/** An export is always everything, including characters. Promise 2. */
export function exportIsComplete(_e: Entitlement): boolean {
  return true;
}

/** Seeing what you already made. Promise 1. */
export function canSeeCharacters(_e: Entitlement): boolean {
  return true;
}

/** Correcting a wrongly tagged book is repair, not decoration. */
export function canEditBookDetails(_e: Entitlement): boolean {
  return true;
}

/* ------------------------------------------------------------------ *
 * Paid.
 * ------------------------------------------------------------------ */

/**
 * Creating characters, and `@`-tagging them in notes.
 *
 * The line between free and paid in the notes system, and it is a real seam
 * rather than an invented one: a note is a thought, and the character index
 * is a reference work about a book's cast. Seeing and exporting characters
 * stays free — see `canSeeCharacters`.
 */
export function canUseCharacters(e: Entitlement): boolean {
  return e.pro;
}

/** Choosing a cover from your photos. Decoration, not repair. */
export function canPickCover(e: Entitlement): boolean {
  return e.pro;
}

/**
 * The equaliser, the sliders and the loudness boost.
 *
 * `off` is not covered by this and never asks: the free app sounds like the
 * recording, which is normal rather than broken. Pro tunes it.
 */
export function canCustomiseSound(e: Entitlement): boolean {
  return e.pro;
}

/** The listening statistics. Pure delight; nothing is blocked by its absence. */
export function canSeeStats(e: Entitlement): boolean {
  return e.pro;
}

/**
 * The one theme that costs nothing.
 *
 * Written here rather than imported from `@/theme/palettes` so this module
 * stays loadable on its own — and pinned to `DEFAULT_THEME` by a test, so the
 * two cannot drift apart without something failing.
 */
export const FREE_THEME_ID = 'lamplight';

/** Every theme but that one. */
export function canUseTheme(e: Entitlement, themeId: string): boolean {
  return e.pro || themeId === FREE_THEME_ID;
}

/** How big the storage budget may be set, in gigabytes. */
export const FREE_BUDGET_CEILING_GB = 2;

/**
 * `maxGB` is the dial's own top, which belongs to `lib/library/budget.ts`
 * rather than here: this module decides *whether* there is a cap, not what
 * the instrument's range is.
 */
export function budgetCeilingGB(e: Entitlement, maxGB: number): number {
  return e.pro ? maxGB : FREE_BUDGET_CEILING_GB;
}

/**
 * The budget actually in force, which is not always the one that was set.
 *
 * A stored budget can exceed what this phone is allowed: a drive backup
 * carries the setting between phones, so a 32 GB budget written on a Pro
 * phone will arrive on a free one. Clamping here rather than only on the
 * dial means restoring a backup cannot quietly hand out unlimited storage.
 *
 * It clamps rather than resets, so the number comes straight back when the
 * app is paid for. Nothing is lost, it is only not in force.
 */
export function effectiveBudgetGB(e: Entitlement, storedGB: number): number {
  return e.pro ? storedGB : Math.min(storedGB, FREE_BUDGET_CEILING_GB);
}

/**
 * Still here, and deliberately not used by any screen.
 *
 * Screens ask a question about a feature. This answers a question about a
 * wallet, which is only the store's business — keeping it unexported from
 * the UI is what stops `isPro()` creeping back into a component the next
 * time someone is in a hurry.
 */
export function isPro(e: Entitlement): boolean {
  return e.pro;
}
