/**
 * Which library a book belongs to, and what the checked-out tray shows.
 *
 * The tray used to be global — what is on the phone is on the phone. That
 * held while the drive was the only thing that could put a book there. With a
 * second source it stopped holding: standing in an Audiobookshelf library and
 * seeing the drive's checkouts answers a question nobody asked, and a book
 * downloaded from the server did not appear under the server.
 *
 * The other half of the same bug: an import is checked out from the moment it
 * exists, so it has to reach the tray. A panel that took the tray over for a
 * library already on the phone hid every import behind it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { belongsToSource, isCheckedOut, occupiesBudget, type Book } from '../src/data/types.ts';

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

/** What the Library screen puts in the tray, in the order it does it. */
const tray = (books: Book[], sourceId: string) =>
  books
    .filter((b) => belongsToSource(b, sourceId, DRIVE))
    .filter((b) => b.local.status !== 'on-shelf')
    .map((b) => b.id);

describe('which library a book belongs to', () => {
  it('files a book with no source under the drive', () => {
    // The drive is the implicit source and has no row of its own.
    assert.equal(belongsToSource(book(), DRIVE, DRIVE), true);
  });

  it('files an import under the drive too', () => {
    // No server, lives on the phone, and the drive's library is where someone
    // goes looking for a book they added themselves.
    const imported = book({ importedFromPhone: true, local: { status: 'checked-out', localPath: 'imported/b1' } });
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
  const onServerShelf = book({ id: 'not-downloaded', sourceId: 'abs-1' });
  const onDriveShelf = book({ id: 'still-on-the-shelf' });

  const all = [driveCheckout, imported, downloaded, onServerShelf, onDriveShelf];

  it('shows the drive its own checkouts and its imports, and no server books', () => {
    assert.deepEqual(tray(all, DRIVE), ['from-the-drive', 'added-here']);
  });

  it('shows a server only what was downloaded from it', () => {
    assert.deepEqual(tray(all, 'abs-1'), ['from-the-server']);
  });

  it('leaves a server library with an empty tray until something is downloaded', () => {
    assert.deepEqual(tray([onServerShelf, driveCheckout], 'abs-1'), []);
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
