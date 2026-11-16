/**
 * The storage budget stepper.
 *
 * The sheet around it is a modal and a press, none of which runs off a phone;
 * the stepping rules are arithmetic and belong here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToGB,
  clampBudgetGB,
  gbToBytes,
  MAX_BUDGET_GB,
  MIN_BUDGET_GB,
  nextBudgetGB,
  previousBudgetGB,
  stepGB,
} from '../src/lib/library/budget.ts';

const GB = 1024 * 1024 * 1024;

describe('the budget stepper', () => {
  it('steps by a gigabyte while the numbers are small', () => {
    assert.equal(stepGB(1), 1);
    assert.equal(stepGB(7), 1);
    assert.equal(nextBudgetGB(4), 5);
    assert.equal(previousBudgetGB(4), 3);
  });

  it('widens the step as the budget grows', () => {
    assert.equal(stepGB(8), 2);
    assert.equal(stepGB(32), 4);
    assert.equal(nextBudgetGB(8), 10);
    assert.equal(nextBudgetGB(32), 36);
  });

  it('undoes a press that crossed a step boundary', () => {
    // 7 → 8 steps by one, so 8 → 7 has to come back the same way rather than
    // taking the wider step that applies above the boundary.
    assert.equal(nextBudgetGB(7), 8);
    assert.equal(previousBudgetGB(8), 7);
    assert.equal(nextBudgetGB(30), 32);
    assert.equal(previousBudgetGB(32), 30);
  });

  it('is reversible across the range', () => {
    for (let gb = MIN_BUDGET_GB + 1; gb < 200; gb += 1) {
      const up = nextBudgetGB(gb);
      assert.ok(up > gb, `${gb} should go up, got ${up}`);
      const down = previousBudgetGB(gb);
      assert.ok(down < gb, `${gb} should come down, got ${down}`);
    }
  });

  it('snaps an off-grid value onto the grid rather than carrying it forward', () => {
    // A budget restored from an odd stored figure, or left behind by a change
    // to the steps, tidies up on the first press.
    assert.equal(nextBudgetGB(9), 10);
    assert.equal(nextBudgetGB(33), 36);
    assert.equal(previousBudgetGB(33), 32);
  });

  it('holds the floor and the ceiling', () => {
    assert.equal(previousBudgetGB(MIN_BUDGET_GB), MIN_BUDGET_GB);
    assert.equal(previousBudgetGB(0), MIN_BUDGET_GB);
    assert.equal(nextBudgetGB(MAX_BUDGET_GB), MAX_BUDGET_GB);
    assert.equal(clampBudgetGB(9999), MAX_BUDGET_GB);
    assert.equal(clampBudgetGB(-5), MIN_BUDGET_GB);
  });

  it('survives a value that is not a number', () => {
    assert.equal(clampBudgetGB(Number.NaN), MIN_BUDGET_GB);
    assert.equal(clampBudgetGB(Number.POSITIVE_INFINITY), MAX_BUDGET_GB);
  });

  it('round-trips through bytes, which is what the store holds', () => {
    assert.equal(gbToBytes(4), 4 * GB);
    assert.equal(bytesToGB(4 * GB), 4);
    // The stored default, and the shape of anything a ruler has to draw.
    assert.equal(bytesToGB(gbToBytes(16)), 16);
    // A stored figure that is not a whole gigabyte still reads as one.
    assert.equal(bytesToGB(4.4 * GB), 4);
  });
});
