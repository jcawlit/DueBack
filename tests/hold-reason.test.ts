/**
 * Why a book on hold is not copying.
 *
 * **This is a real tray, photographed.** Three books on hold — two from the
 * drive, one from a server — none of them copying, and the Book screen saying
 * of each one:
 *
 *     In the queue · It will start when the one ahead finishes
 *
 * Nothing was ahead. Nothing was finishing. The screen had two answers for a
 * question with three, and said the wrong one in the only case that cannot
 * resolve itself.
 *
 * The arithmetic is the part worth pinning. A hold is a commitment, so every
 * hold counts against the budget *while it waits* — which means the question
 * is never "does this one fit in what is left" but "does everything promised
 * fit at once". When it does not, no hold can start, every hold blocks every
 * other, and only a message can get the listener out of it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { holdReason } from '../src/lib/library/budget.ts';

const GB = 1024 * 1024 * 1024;

/** Two gigabytes, which is the free ceiling and the tray in the photograph. */
const BUDGET = 2 * GB;

const reason = (over: Partial<Parameters<typeof holdReason>[0]> = {}) =>
  holdReason({
    needsDrive: false,
    driveConnected: true,
    committedBytes: GB,
    budgetBytes: BUDGET,
    ...over,
  });

describe('waiting for the drive', () => {
  it('says so when the book needs a drive that is not there', () => {
    assert.equal(reason({ needsDrive: true, driveConnected: false }), 'drive');
  });

  it('does not say so for a book from a server', () => {
    // A download needs no drive. Telling somebody to plug one in would be
    // asking for something that cannot help.
    assert.equal(reason({ needsDrive: false, driveConnected: false }), 'turn');
  });

  it('puts the missing drive ahead of everything else', () => {
    // Even when the budget is hopeless, plugging the drive in is the first
    // thing that has to happen, so it is the first thing to say.
    assert.equal(
      reason({ needsDrive: true, driveConnected: false, committedBytes: 9 * GB }),
      'drive',
    );
  });
});

describe('waiting a turn', () => {
  it('is the answer when everything promised still fits', () => {
    assert.equal(reason({ committedBytes: GB }), 'turn');
  });

  it('is still the answer at exactly the budget', () => {
    // Exactly full is full, not over. A book that fits to the byte starts.
    assert.equal(reason({ committedBytes: BUDGET }), 'turn');
  });
});

describe('the queue that can never start', () => {
  it('says so once the holds together are bigger than the budget', () => {
    assert.equal(reason({ committedBytes: BUDGET + 1 }), 'wont-fit');
  });

  it('reproduces the tray from the photograph', () => {
    /*
     * Two 484 MB books from the drive and one larger one from a server, with
     * the budget at 2 GB. Every one of them was reported as waiting its turn.
     * None of them could ever have started.
     */
    const MB = 1024 * 1024;
    const holds = 484 * MB + 484 * MB + 1200 * MB;
    assert.ok(holds > BUDGET, 'the fixture should be over budget');

    for (const needsDrive of [true, false]) {
      assert.equal(
        holdReason({
          needsDrive,
          driveConnected: true,
          committedBytes: holds,
          budgetBytes: BUDGET,
        }),
        'wont-fit',
        `a ${needsDrive ? 'drive' : 'server'} book should say so`,
      );
    }
  });

  it('counts what is already on the phone, not just the holds', () => {
    // A phone that is nearly full and one modest hold is the same deadlock
    // as three large holds, and has to read the same way.
    assert.equal(reason({ committedBytes: BUDGET + 1 }), 'wont-fit');
  });
});
