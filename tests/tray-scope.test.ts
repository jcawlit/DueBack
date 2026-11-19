/**
 * Which library a book belongs to, and what the checked-out tray shows.
 *
 * The tray was global once — what is on the phone is on the phone — and that
 * held while the drive was the only thing that could put a book there. With a
 * server it stopped holding, so it was scoped to the active source instead.
 *
 * **That traded one wrong answer for another, and the second cost storage.**
 * Remove a server and its downloads belonged to no source you could switch
 * to, so they appeared nowhere: still on the phone, still taking gigabytes,
 * with no screen offering to release them. Found on a real phone, after a
 * server was removed and signed into again.
 *
 * So the tray shows everything again, in groups — the drive, then each server,
 * then anything from a server not signed into — and the labels do the work
 * the scoping was doing badly. `belongsToSource` is still the rule for which
 * *library* a book is in, which is a different question and still scoped.
 *
 * The other half of the original bug, still true: an import is checked out
 * from the moment it exists, so it has to reach the tray.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { belongsToSource, isCheckedOut, occupiesBudget, type Book } from '../src/data/types.ts';
import { trayBreakdown, trayGroups } from '../src/lib/library/tray.ts';

const DRIVE = 'usb';

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: 'b1',
    title: 'A Book',
    author: 'An Author',
    durationSec: 3600,
    sizeBytes: 1000,
    sourceRelPath: 'A Book',
    files: ['A Book/01.mp3'],
    chapters: [],
    local: { status: 'on-shelf' },
    progressSec: 0,
    checkouts: [],
    ...overrides,
  };
}

describe('which library a book belongs to', () => {
  it('files a book with no source under the drive', () => {
    // The drive is the implicit source and has no row of its own.
    assert.equal(belongsToSource(book(), DRIVE, DRIVE), true);
  });

  it('files an import under the drive too', () => {
    // No server, lives on the phone, and the drive's library is where someone
    // goes looking for a book they added themselves.
    const imported = book({
      importedFromPhone: true,
      local: { status: 'checked-out', localPath: 'imported/b1' },
    });
    assert.equal(belongsToSource(imported, DRIVE, DRIVE), true);
    assert.equal(belongsToSource(imported, 'abs-1', DRIVE), false);
  });

  it('files a server book under its own server, and nowhere else', () => {
    const remote = book({ sourceId: 'abs-1' });
    assert.equal(belongsToSource(remote, 'abs-1', DRIVE), true);
    assert.equal(belongsToSource(remote, DRIVE, DRIVE), false);
    assert.equal(belongsToSource(remote, 'abs-2', DRIVE), false);
  });
});

describe('what the checked-out tray shows', () => {
  const driveCheckout = book({
    id: 'from-the-drive',
    local: { status: 'checked-out', localPath: 'books/from-the-drive' },
  });
  const imported = book({
    id: 'added-here',
    importedFromPhone: true,
    local: { status: 'checked-out', localPath: 'imported/added-here' },
  });
  const downloaded = book({
    id: 'from-the-server',
    sourceId: 'abs-1',
    local: { status: 'checked-out', localPath: 'books/from-the-server' },
  });
  const orphaned = book({
    id: 'from-a-server-i-left',
    sourceId: 'abs-gone',
    local: { status: 'checked-out', localPath: 'books/from-a-server-i-left' },
  });
  const onServerShelf = book({ id: 'not-downloaded', sourceId: 'abs-1' });
  const onDriveShelf = book({ id: 'still-on-the-shelf' });

  const all = [driveCheckout, imported, downloaded, onServerShelf, onDriveShelf];
  const live = [{ id: 'abs-1', label: 'Home' }];
  const groups = (books: Book[], servers = live) =>
    trayGroups(books, { driveSourceId: DRIVE, servers });
  const shape = (books: Book[], servers = live) =>
    groups(books, servers).map((g) => [g.label, g.books.map((b) => b.id)]);

  it('shows the drive first, then the server', () => {
    assert.deepEqual(shape(all), [
      ['Drive', ['from-the-drive', 'added-here']],
      ['Home', ['from-the-server']],
    ]);
  });

  it('shows a book from a server that is no longer signed into', () => {
    /*
     * The reason this file changed. These used to appear nowhere at all while
     * still holding gigabytes, with nothing offering to release them.
     */
    const out = shape([...all, orphaned]);
    assert.deepEqual(out.at(-1), ['Signed out', ['from-a-server-i-left']]);
  });

  it('marks that group so nothing offers to fetch for it', () => {
    // The audio is on the phone and plays; there is no server left to ask for
    // anything more, so a screen must not pretend otherwise.
    const out = groups([orphaned]);
    assert.equal(out.length, 1);
    assert.equal(out[0].signedOut, true);
  });

  it('puts a book back under its server when you sign in again', () => {
    // Books keep their `source_id` through a removal, so reviving the source
    // is all it takes. Nothing has to be matched up or guessed.
    assert.deepEqual(shape([orphaned], [{ id: 'abs-gone', label: 'Home' }]), [
      ['Home', ['from-a-server-i-left']],
    ]);
  });

  it('leaves the tray looking exactly as it always did with no server', () => {
    /*
     * One group, so no dividers and no breakdown line. A listener who never
     * opens Audiobookshelf must not be shown scaffolding for it.
     */
    const out = groups([driveCheckout, imported, onDriveShelf], []);
    assert.equal(out.length, 1);
    assert.equal(out[0].label, 'Drive');
    assert.equal(trayBreakdown(out), null);
  });

  it('names the counts once there is more than one group', () => {
    assert.equal(trayBreakdown(groups(all)), '2 Drive · 1 Home');
  });

  it('drops a group with nothing in it', () => {
    assert.deepEqual(shape([driveCheckout]), [['Drive', ['from-the-drive']]]);
    assert.deepEqual(shape([downloaded]), [['Home', ['from-the-server']]]);
  });

  it('leaves books still on a shelf out of it entirely', () => {
    assert.deepEqual(shape([onServerShelf, onDriveShelf]), []);
  });

  it('includes a book on hold and a copy in flight', () => {
    // On hold is part of what somebody is taking with them even though no
    // bytes have moved; a copy in flight is the one they are watching.
    const held = book({ id: 'held', local: { status: 'on-hold', since: 'now' } });
    const landing = book({ id: 'landing', local: { status: 'copying', progress: 0.5 } });
    assert.deepEqual(shape([held, landing]), [['Drive', ['held', 'landing']]]);
  });

  it('counts an import as checked out and against the budget', () => {
    // Both are why the tray cannot be replaced wholesale for a library that
    // is already on the phone: an import is in it, and it costs room.
    assert.equal(isCheckedOut(imported), true);
    assert.equal(occupiesBudget(imported), true);
  });

  it('does not count a book still on a shelf against the budget', () => {
    assert.equal(occupiesBudget(onDriveShelf), false);
    assert.equal(occupiesBudget(onServerShelf), false);
  });

  it('counts a copy in flight, so the ruler moves while it lands', () => {
    assert.equal(occupiesBudget(book({ local: { status: 'copying', progress: 0.5 } })), true);
  });
});
