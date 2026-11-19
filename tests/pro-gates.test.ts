/**
 * What is paid for, and the three things that never are.
 *
 * Every gate in the app answers from `src/lib/pro.ts`, and every one of them
 * had been returning the same answer since the day it was written, because
 * `isPro()` returned `true` for everyone. That is why two of them were wrong
 * and nobody knew: a gate that has never been shut has never been tested.
 *
 * Both bugs are below, named, as the first two tests of the free column. They
 * were not hypothetical — they stripped a listener's own characters out of a
 * listener's own export, and hid characters they had already written from
 * their own notes view.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetCeilingGB,
  canCustomiseSound,
  canEditBookDetails,
  canPickCover,
  canSeeCharacters,
  canSeeStats,
  canUseCharacters,
  canUseTheme,
  allowedSort,
  canUseSort,
  canWriteNotes,
  FREE_SORT,
  exportIsComplete,
  effectiveBudgetGB,
  FREE,
  FREE_BUDGET_CEILING_GB,
  FREE_THEME_ID,
  isPro,
  PRE_LAUNCH,
  type Entitlement,
} from '../src/lib/pro.ts';
import { MAX_BUDGET_GB } from '../src/lib/library/budget.ts';
import { DEFAULT_THEME, THEMES } from '../src/theme/palettes.ts';

const PAID: Entitlement = { pro: true, source: 'purchased' };
/** Every state an entitlement can be in, for the rules that ignore it. */
const EVERY: Entitlement[] = [FREE, PAID, PRE_LAUNCH];

describe('what is free, whatever happens', () => {
  it('puts every character in the export, paid or not', () => {
    /*
     * The bug. `includeCharacters: isPro()` meant a listener who was not Pro
     * got an export with their own characters taken out of it — their
     * writing, withheld from their own file.
     */
    for (const e of EVERY) {
      assert.equal(exportIsComplete(e), true, `export gated for ${e.source}`);
    }
  });

  it('shows characters that are already written, paid or not', () => {
    // The other half of the same bug: `characters={isPro() ? characters : []}`
    // emptied the list in the notes view rather than disabling anything.
    for (const e of EVERY) assert.equal(canSeeCharacters(e), true);
  });

  it('lets anyone write a note or set a bookmark', () => {
    // A thought jotted while listening is not a luxury, and a bookmark is a
    // position rather than writing. Both stay free.
    for (const e of EVERY) assert.equal(canWriteNotes(e), true);
  });

  it('lets anyone correct a wrongly tagged book', () => {
    // Repair, not decoration. Charging to fix what looks like a bug is how an
    // app earns a one-star review instead of a sale.
    for (const e of EVERY) assert.equal(canEditBookDetails(e), true);
  });

  it('gives everyone the default theme', () => {
    for (const e of EVERY) assert.equal(canUseTheme(e, DEFAULT_THEME), true);
  });

  it('agrees with the theme module about which one that is', () => {
    /*
     * `lib/pro.ts` imports nothing, so it names the free theme itself rather
     * than reading `DEFAULT_THEME`. This is what stops the two drifting: move
     * the default and the free theme stays put, and this fails rather than
     * the app quietly charging for the theme everyone starts on.
     */
    assert.equal(FREE_THEME_ID, DEFAULT_THEME);
  });
});

describe('what is paid for', () => {
  it('gates making a character, not having one', () => {
    // The distinction the whole design rests on.
    assert.equal(canUseCharacters(FREE), false);
    assert.equal(canSeeCharacters(FREE), true);

    assert.equal(canUseCharacters(PAID), true);
  });

  it('gates the cover picker, the sound panel and the statistics', () => {
    for (const rule of [canPickCover, canCustomiseSound, canSeeStats]) {
      assert.equal(rule(FREE), false);
      assert.equal(rule(PAID), true);
    }
  });

  it('gates every theme but the default', () => {
    const others = THEMES.map((t) => t.id).filter((id) => id !== DEFAULT_THEME);
    assert.ok(others.length > 0, 'expected more than one theme to exist');
    for (const id of others) {
      assert.equal(canUseTheme(FREE, id), false, `${id} should be paid for`);
      assert.equal(canUseTheme(PAID, id), true);
    }
  });
});

describe('the storage budget', () => {
  it('stops the free dial at 2 GB and lets Pro go to the top', () => {
    assert.equal(budgetCeilingGB(FREE, MAX_BUDGET_GB), FREE_BUDGET_CEILING_GB);
    assert.equal(budgetCeilingGB(PAID, MAX_BUDGET_GB), MAX_BUDGET_GB);
  });

  it('clamps a budget restored from a Pro phone onto a free one', () => {
    /*
     * The case this exists for. A drive backup carries the budget setting
     * between phones, so a 32 GB budget written on a paid phone arrives on a
     * free one — and without this, restoring a backup would hand out
     * unlimited storage for nothing.
     */
    assert.equal(effectiveBudgetGB(FREE, 32), FREE_BUDGET_CEILING_GB);
    assert.equal(effectiveBudgetGB(PAID, 32), 32);
  });

  it('clamps rather than resets, so paying brings the number back', () => {
    // Nothing is rewritten on the way down: the stored 32 is still 32, it is
    // only not in force. Buying restores it with no re-entry.
    const stored = 32;
    assert.equal(effectiveBudgetGB(FREE, stored), 2);
    assert.equal(effectiveBudgetGB(PAID, stored), stored);
  });

  it('leaves a budget already under the ceiling alone', () => {
    assert.equal(effectiveBudgetGB(FREE, 1), 1);
    assert.equal(effectiveBudgetGB(FREE, 2), 2);
  });
});

describe('the entitlement itself', () => {
  it('treats a grant as fully Pro', () => {
    // A beta tester, a promotion, and the state before there is a store to
    // buy from. Every gate opens; only the reason differs.
    assert.equal(isPro(PRE_LAUNCH), true);
    assert.equal(PRE_LAUNCH.source, 'granted');
    assert.equal(canUseCharacters(PRE_LAUNCH), true);
    assert.equal(canSeeStats(PRE_LAUNCH), true);
  });

  it('keeps the reason separate from the answer', () => {
    /*
     * Why there is a `source` at all. "Is it unlocked" and "why" are
     * different questions, and a support reply that can say *granted* rather
     * than *purchased* is worth the one extra field — which is also the whole
     * reason this is one flag and not eight.
     */
    const granted: Entitlement = { pro: true, source: 'granted' };
    const bought: Entitlement = { pro: true, source: 'purchased' };
    assert.equal(isPro(granted), isPro(bought));
    assert.notEqual(granted.source, bought.source);
  });

  it('is free when nothing is known', () => {
    // Unknown is not "probably paid". Showing Pro features and taking them
    // away is worse than showing the free app and adding them.
    assert.equal(FREE.pro, false);
    assert.equal(canUseCharacters(FREE), false);
  });
});

describe('the sorts', () => {
  it('gives everyone the one that answers "what can I finish"', () => {
    for (const e of EVERY) assert.equal(canUseSort(e, FREE_SORT), true);
    assert.equal(FREE_SORT, 'length');
  });

  it('gates the six that arrange a library rather than read it', () => {
    for (const mode of ['author', 'series', 'narrator', 'dust', 'unfinished', 'custom']) {
      assert.equal(canUseSort(FREE, mode), false, `${mode} should be paid for`);
      assert.equal(canUseSort(PAID, mode), true);
    }
  });

  it('falls back rather than going on arranging for somebody without Pro', () => {
    /*
     * A sort chosen while Pro was granted is still stored afterwards — which
     * is every listener today, since they are all on the pre-launch grant.
     * Without this the shelves would keep obeying a setting the app no longer
     * offers.
     */
    assert.equal(allowedSort(FREE, 'series'), 'length');
    assert.equal(allowedSort(PAID, 'series'), 'series');
  });

  it('clamps rather than rewrites, so the choice comes back', () => {
    const stored = 'dust';
    assert.equal(allowedSort(FREE, stored), 'length');
    assert.equal(allowedSort(PAID, stored), stored);
  });
});
