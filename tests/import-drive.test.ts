/**
 * Adding a book from the phone, and pushing it onto the drive.
 *
 * Two halves that fail in opposite directions. Staging reads a folder the
 * person chose with the system picker, where the names are SAF document ids
 * rather than filenames and a subfolder may refuse to list. The push writes
 * into the library itself, which is the only copy of anything — so the rule
 * that matters there is that a push which dies partway leaves either a whole
 * book or nothing a scan will ever look at.
 *
 * `tests/fakeDrive.ts` replaces only `expo-file-system`. `collectAudio`,
 * `stageFiles` and `copyImportToDrive` are the real ones.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  build,
  deregisterDriveHooks,
  DOCUMENT_ROOT,
  faults,
  listAll,
  nameAs,
  picker,
  readText,
  resetDrive,
  sizeOf,
} from './fakeDrive.ts';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const PHONE = 'file:///storage/Download';
const DRIVE = 'file:///library';

let imports: typeof import('../src/lib/files/import.ts');
let grouping: typeof import('../src/lib/library/grouping.ts');

before(async () => {
  imports = await import('../src/lib/files/import.ts');
  grouping = await import('../src/lib/library/grouping.ts');
});

after(() => deregisterDriveHooks());

beforeEach(() => resetDrive());

const names = (result: Awaited<ReturnType<typeof imports.importBookFromFolder>>) => {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.files.map((f) => f.name);
};

describe('adding a folder from the phone', () => {
  it('stages a flat book under imported/<id>, numbered locally', async () => {
    /*
     * The local names are deliberately not the picked ones: a local path goes
     * through `java.net.URI`, which rejects non-ASCII and much of the
     * punctuation real audiobook filenames carry. The readable name is kept
     * alongside, and that is what the database and the drive use.
     */
    build(PHONE, { 'My Book': { '01.mp3': 10, '02.mp3': 20 } });
    picker.directory = `${PHONE}/My Book`;

    const out = await imports.importBookFromFolder();
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.folderName, 'My Book');
    assert.deepEqual(out.files.map((f) => f.relPath), [
      `imported/${out.bookId}/0000.mp3`,
      `imported/${out.bookId}/0001.mp3`,
    ]);
    assert.deepEqual(out.files.map((f) => f.name), ['01.mp3', '02.mp3']);
    assert.deepEqual(out.files.map((f) => f.sizeBytes), [10, 20]);
  });

  it('descends into discs, and plays all of one before any of the other', async () => {
    /*
     * This used to list the picked folder's immediate files only, so a book
     * arranged as `Disc 1/` and `Disc 2/` yielded no audio and was refused as
     * if it held none. Both discs number from one, so ordering on the filename
     * alone interleaves them and the book plays 1, 1, 2, 2.
     */
    build(PHONE, {
      'My Book': { 'Disc 1': { '01.mp3': 1, '02.mp3': 1 }, 'Disc 2': { '01.mp3': 1, '02.mp3': 1 } },
    });
    picker.directory = `${PHONE}/My Book`;

    assert.deepEqual(names(await imports.importBookFromFolder()), [
      'Disc 1 - 01.mp3',
      'Disc 1 - 02.mp3',
      'Disc 2 - 01.mp3',
      'Disc 2 - 02.mp3',
    ]);
  });

  it('gives two discs’ identically named parts different names', async () => {
    /*
     * A later push writes every part into one flat folder, by this name. Two
     * `01.mp3` files would mean the second landing on top of the first: a book
     * on the drive that plays disc two twice and has lost disc one.
     */
    build(PHONE, { B: { 'Disc 1': { '01.mp3': 1 }, 'Disc 2': { '01.mp3': 1 } } });
    picker.directory = `${PHONE}/B`;

    const out = names(await imports.importBookFromFolder());
    assert.equal(new Set(out).size, 2, 'the names must differ');
  });

  it('reads names that arrive as SAF document ids', async () => {
    /*
     * A provider hands back `primary:Download/My Book/01.mp3` rather than
     * `01.mp3`. Untrimmed, the volume prefix ended up in the book's title and
     * in every one of its chapter names.
     */
    build(PHONE, { 'My Book': { '01.mp3': 10 } });
    nameAs(`${PHONE}/My Book/01.mp3`, 'primary:Download/My Book/01.mp3');
    picker.directory = `${PHONE}/My Book`;

    assert.deepEqual(names(await imports.importBookFromFolder()), ['01.mp3']);
  });

  it('reaches two levels of subfolder, and no further', async () => {
    /*
     * The boundary, spelled out because "two levels" is ambiguous and the
     * cost of being wrong either way is real: too shallow and a `Disc 1/`
     * book is refused as empty, too deep and a whole music library picked by
     * accident gets walked.
     */
    build(PHONE, {
      B: {
        '00.mp3': 1,
        One: { '01.mp3': 1 },
        Two: { Deep: { '02.mp3': 1 } },
        Three: { Deeper: { Deepest: { '03.mp3': 1 } } },
      },
    });
    picker.directory = `${PHONE}/B`;

    const found = names(await imports.importBookFromFolder());
    assert.deepEqual(found.slice().sort(), [
      '00.mp3',
      'One - 01.mp3',
      'Two - Deep - 02.mp3',
    ]);
    assert.ok(
      !found.some((n) => n.includes('03.mp3')),
      'the third level of subfolder is out of reach',
    );
  });

  it('keeps the book when one subfolder will not list', async () => {
    // One unreadable subfolder is not a reason to refuse the whole book.
    build(PHONE, { B: { Good: { '01.mp3': 1 }, Bad: { '02.mp3': 1 } } });
    faults.unlistable.add(`${PHONE}/B/Bad`);
    picker.directory = `${PHONE}/B`;

    assert.deepEqual(names(await imports.importBookFromFolder()), ['Good - 01.mp3']);
  });

  it('ignores files it cannot play, and says what it was looking for', async () => {
    build(PHONE, { B: { 'notes.txt': 1, 'cover.jpg': 1, 'audio.flac': 1 } });
    picker.directory = `${PHONE}/B`;

    const out = await imports.importBookFromFolder();
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, 'no-audio');
    assert.match(out.message, /\.m4b, \.m4a or \.mp3/);
    assert.match(out.message, /or in a folder inside it/, 'the recursion is part of the promise');
  });

  it('treats a cancelled picker as nothing added, not a failure', async () => {
    picker.directory = null;
    const out = await imports.importBookFromFolder();
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, 'cancelled');
    assert.match(out.message, /Nothing added/);
  });

  it('leaves nothing staged when the copy fails partway', async () => {
    build(PHONE, { B: { '01.mp3': 1, '02.mp3': 1 } });
    picker.directory = `${PHONE}/B`;
    faults.failWriteAfter = 1;

    const out = await imports.importBookFromFolder();
    assert.equal(out.ok, false);
    assert.deepEqual(
      listAll(`${DOCUMENT_ROOT}/imported`).filter((u) => u.endsWith('.mp3')),
      [],
      'a half-staged book is not left on the phone',
    );
  });
});

describe('pushing an imported book onto the drive', () => {
  const staged = async () => {
    build(PHONE, { 'My Book': { '01.mp3': 10, '02.mp3': 20 } });
    picker.directory = `${PHONE}/My Book`;
    const out = await imports.importBookFromFolder();
    assert.equal(out.ok, true);
    if (!out.ok) throw new Error('unreachable');
    return out;
  };

  it('writes a folder of audio and leaves no marker behind', async () => {
    const book = await staged();
    build(DRIVE, {});

    const push = await imports.copyImportToDrive(DRIVE, book.folderName, book.files);
    assert.equal(push.ok, true);
    if (!push.ok) return;
    assert.equal(push.folderRelPath, 'My Book');
    assert.deepEqual(push.files.map((f) => f.name), ['01.mp3', '02.mp3']);
    assert.equal(
      readText(`${DRIVE}/My Book/${grouping.INCOMPLETE_MARKER}`),
      null,
      'the marker is gone, so a scan will index the book',
    );
  });

  /*
   * That a marked folder is invisible to a scan is pinned where the rule
   * lives: `tests/grouping.test.ts`, "skips a folder that holds the marker".
   * Not restated here, because a second copy of it would be a second thing
   * to keep true.
   */
  it('never writes over a book that is already there', async () => {
    const book = await staged();
    build(DRIVE, { 'My Book': { 'existing.mp3': 99 } });

    const push = await imports.copyImportToDrive(DRIVE, book.folderName, book.files);
    assert.equal(push.ok, true);
    if (!push.ok) return;
    assert.equal(push.folderRelPath, 'My Book (2)', 'it takes the next free name');
    assert.equal(sizeOf(`${DRIVE}/My Book/existing.mp3`), 99, 'the original is untouched');
  });

  it('reclaims the wreckage of a push that died rather than numbering past it', async () => {
    /*
     * Without this, a retry takes the next free number and the part-written
     * folder stays on the drive for ever: the scan skips it, so it is
     * invisible from inside the app and only a computer could find it.
     */
    const book = await staged();
    build(DRIVE, {
      'My Book': {
        [grouping.INCOMPLETE_MARKER]: 'still writing',
        '01.mp3': 5,
      },
    });

    const push = await imports.copyImportToDrive(DRIVE, book.folderName, book.files);
    assert.equal(push.ok, true);
    if (!push.ok) return;
    assert.equal(push.folderRelPath, 'My Book', 'the dead folder was ours to clear');
    assert.equal(readText(`${DRIVE}/My Book/${grouping.INCOMPLETE_MARKER}`), null);
  });

  it('refuses when the drive is not there, without inventing a folder', async () => {
    const book = await staged();
    const push = await imports.copyImportToDrive(DRIVE, book.folderName, book.files);
    assert.equal(push.ok, false);
    if (push.ok) return;
    assert.match(push.message, /not reachable/);
  });

  it('says which file went missing from the phone rather than writing a partial book', async () => {
    const book = await staged();
    build(DRIVE, {});
    const { File } = await import('./fakeDrive.ts');
    new File(`${DOCUMENT_ROOT}/${book.files[1].relPath}`).delete();

    const push = await imports.copyImportToDrive(DRIVE, book.folderName, book.files);
    assert.equal(push.ok, false);
    if (push.ok) return;
    assert.match(push.message, /02\.mp3 is missing from the phone/);
    assert.deepEqual(
      listAll(`${DRIVE}/My Book`),
      [],
      'and the folder it had started is removed',
    );
  });

  it('removes the folder it started when the drive goes away mid-push', async () => {
    const book = await staged();
    build(DRIVE, {});
    // Enough writes to create the folder and marker, then failure.
    faults.failWriteAfter = faults.writeCount + 3;

    const push = await imports.copyImportToDrive(DRIVE, book.folderName, book.files);
    assert.equal(push.ok, false);
    assert.deepEqual(
      listAll(`${DRIVE}/My Book`),
      [],
      'a dead push leaves nothing, not even the marker',
    );
  });
});

describe('a staged book on the phone', () => {
  it('resolves to a playable uri, and forgets completely when deleted', async () => {
    build(PHONE, { B: { '01.mp3': 10 } });
    picker.directory = `${PHONE}/B`;
    const out = await imports.importBookFromFolder();
    assert.equal(out.ok, true);
    if (!out.ok) return;

    assert.ok(imports.importedUriFor(out.files[0].relPath));
    imports.deleteImport(out.bookId);
    assert.equal(imports.importedUriFor(out.files[0].relPath), null);
    assert.deepEqual(listAll(`${DOCUMENT_ROOT}/imported/${out.bookId}`), []);
  });
});
