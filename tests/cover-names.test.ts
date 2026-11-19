/**
 * Which cached covers a rescan is allowed to delete.
 *
 * This is the kind of rule that breaks silently. Storing new artwork clears a
 * book's old thumbnails by prefix, and a cover the listener picked sits under
 * the same prefix — so the sweep is one line away from deleting a correction's
 * only picture and leaving the book blank with nothing on screen to explain
 * it, days after the edit and with no error anywhere.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  coverName,
  isUserCover,
  shouldSweep,
  USER_COVER_MARK,
} from '../src/lib/files/coverNames.ts';

const book = 'b1';

describe('naming a thumbnail', () => {
  it('names a scanned cover for the book and its artwork', () => {
    assert.equal(coverName(book, 'deadbeef', false), 'b1.deadbeef.jpg');
  });

  it('marks a cover the listener picked', () => {
    assert.equal(coverName(book, 'deadbeef', true), 'b1.user.deadbeef.jpg');
    assert.ok(isUserCover(coverName(book, 'deadbeef', true), book));
  });

  it('changes the name when the artwork changes', () => {
    /*
     * Android's image pipeline caches by URI without consulting the file's
     * timestamp, so a corrected cover at the same path goes on rendering from
     * the old bitmap. A name that moves with the artwork is the fix.
     */
    assert.notEqual(coverName(book, 'aaaa', true), coverName(book, 'bbbb', true));
  });
});

describe('sweeping a book’s old covers', () => {
  it('deletes the scanned covers it is there to replace', () => {
    assert.equal(shouldSweep('b1.old.jpg', book), true);
  });

  it('keeps the one just written', () => {
    assert.equal(shouldSweep('b1.new.jpg', book, 'b1.new.jpg'), false);
  });

  it('keeps a cover the listener picked', () => {
    /*
     * The one that matters. A scan finds the drive's artwork, stores it, and
     * sweeps — and this is the line that stops it taking the picked cover
     * with it while the book's correction still names that file.
     */
    assert.equal(shouldSweep('b1.user.abc.jpg', book), false);
  });

  it('deletes a picked cover when the book is being forgotten', () => {
    // The book is leaving the library, so its picture should go too.
    assert.equal(shouldSweep('b1.user.abc.jpg', book, undefined, true), true);
  });

  it('never touches another book’s covers', () => {
    assert.equal(shouldSweep('b2.old.jpg', book), false);
  });

  it('does not delete the covers of a book whose id merely starts the same', () => {
    // The separator is the whole test: a bare `startsWith` would have "b1"
    // sweeping everything belonging to "b1a".
    assert.equal(shouldSweep('b1a.old.jpg', book), false);
    assert.equal(shouldSweep('b1a.user.x.jpg', book, undefined, true), false);
  });

  it('leaves the scratch file alone', () => {
    // `storeCover` writes `scratch-<id>.<ext>` deliberately *not* starting
    // with the id, so that sweeping cannot delete the file being worked on.
    assert.equal(shouldSweep(`scratch-${book}.jpg`, book, undefined, true), false);
  });

  it('agrees with the mark it is built on', () => {
    assert.equal(USER_COVER_MARK, '.user.');
    assert.ok(coverName(book, 't', true).includes(USER_COVER_MARK));
    assert.ok(!coverName(book, 't', false).includes(USER_COVER_MARK));
  });
});
