/**
 * Checking a book out: the production copy path, against a fake filesystem.
 *
 * This is where losing data is possible. A copy writes gigabytes into app
 * storage over minutes, across a cable that can be pulled, with a phone that
 * can be killed and a drive that can have had the book deleted from it since
 * the last scan. Every rule below exists because getting it wrong leaves
 * either a book the player cannot find or audio nothing will ever clean up.
 *
 * None of it has ever run outside a phone. `tests/fakeDrive.ts` replaces only
 * `expo-file-system`; `copyBookToDevice`, `swapIntoPlace` and
 * `recoverInterruptedSwaps` are the real ones, and the `move` semantics the
 * fake implements are transcribed from expo-file-system's Android source
 * rather than guessed — the swap depends on them exactly.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  build,
  deregisterDriveHooks,
  DOCUMENT_ROOT,
  faults,
  listAll,
  readText,
  resetDrive,
  sizeOf,
} from './fakeDrive.ts';

// A bundler global the copy path logs behind. Set before the module loads.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const DRIVE = 'file:///library';
const BOOK = 'book-1';

let copy: typeof import('../src/lib/files/copy.ts');

before(async () => {
  copy = await import('../src/lib/files/copy.ts');
});

after(() => deregisterDriveHooks());

beforeEach(() => resetDrive());

/** Two parts on the drive, with sizes, as the scanner would have recorded them. */
const onDrive = (sizes = [1000, 2000]) => {
  const tree: Record<string, number> = {};
  sizes.forEach((size, i) => {
    tree[`${String(i + 1).padStart(2, '0')}.mp3`] = size;
  });
  build(DRIVE, { Hyperion: tree });
  return sizes.map((size, i) => ({
    uri: `${DRIVE}/Hyperion/${String(i + 1).padStart(2, '0')}.mp3`,
    name: `${String(i + 1).padStart(2, '0')}.mp3`,
    sizeBytes: size,
  }));
};

const finalDir = `${DOCUMENT_ROOT}/books/${BOOK}`;
const stagingDir = `${DOCUMENT_ROOT}/books-tmp/${BOOK}`;

describe('a copy that works', () => {
  it('lands the audio under books/<id>, numbered and stripped of drive names', async () => {
    /*
     * The names are deliberately not the drive's. A local path goes through
     * `java.net.URI`, which rejects non-ASCII and much of the punctuation real
     * audiobook filenames carry. `npm run kb ascii`.
     */
    const parts = onDrive();
    const out = await copy.copyBookToDevice(BOOK, parts);

    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(out.localRelPaths, [
      `books/${BOOK}/0000.mp3`,
      `books/${BOOK}/0001.mp3`,
    ]);
    assert.equal(out.bytes, 3000);
    assert.equal(sizeOf(`${finalDir}/0000.mp3`), 1000);
    assert.equal(sizeOf(`${finalDir}/0001.mp3`), 2000);
  });

  it('keeps a drive name’s extension, because the mime lookup reads it', async () => {
    build(DRIVE, { Hyperion: { 'Hyperion — Part 1 (unabridged).m4b': 50 } });
    const out = await copy.copyBookToDevice(BOOK, [
      {
        uri: `${DRIVE}/Hyperion/Hyperion — Part 1 (unabridged).m4b`,
        name: 'Hyperion — Part 1 (unabridged).m4b',
        sizeBytes: 50,
      },
    ]);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual(out.localRelPaths, [`books/${BOOK}/0000.m4b`]);
  });

  it('leaves nothing in staging, and no manifest with the audio', async () => {
    /*
     * The manifest exists to let an interrupted copy resume. Shipping it into
     * the book's folder would put a stray file among the audio, which
     * reconciliation and the part count both read.
     */
    const parts = onDrive();
    await copy.copyBookToDevice(BOOK, parts);

    assert.deepEqual(
      listAll(`${DOCUMENT_ROOT}/books-tmp/${BOOK}`),
      [],
      'staging is gone',
    );
    assert.deepEqual(listAll(finalDir).map((u) => u.slice(finalDir.length + 1)).filter(Boolean), [
      '0000.mp3',
      '0001.mp3',
    ]);
    assert.equal(readText(`${finalDir}/${copy.MANIFEST_NAME}`), null);
  });

  it('reports progress that ends at the whole book', async () => {
    const parts = onDrive();
    const seen: number[] = [];
    await copy.copyBookToDevice(BOOK, parts, {
      onProgress: (p) => seen.push(p.bytesCopied),
    });
    assert.ok(seen.length > 0);
    assert.equal(seen.at(-1), 3000);
    assert.ok(
      seen.every((n, i) => i === 0 || n >= seen[i - 1]),
      'progress never goes backwards',
    );
  });
});

describe('a book that is no longer on the drive', () => {
  it('says so rather than reporting a failure', async () => {
    /*
     * Kept apart from `failed` on purpose: nothing went wrong, the book was
     * deleted from the drive since the last scan. The caller marks it missing
     * instead of telling somebody their copy broke.
     */
    const parts = onDrive();
    build(DRIVE, {});
    new (await import('./fakeDrive.ts')).Directory(`${DRIVE}/Hyperion`).delete();

    const out = await copy.copyBookToDevice(BOOK, parts);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, 'source-missing');
    assert.deepEqual(out.missingNames, ['01.mp3', '02.mp3']);
    assert.match(out.message, /no longer in the library folder/);
  });

  it('distinguishes some parts missing from all of them', async () => {
    const parts = onDrive();
    const { File } = await import('./fakeDrive.ts');
    new File(`${DRIVE}/Hyperion/02.mp3`).delete();

    const out = await copy.copyBookToDevice(BOOK, parts);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.deepEqual(out.missingNames, ['02.mp3']);
    assert.match(out.message, /1 of 2 files/);
  });

  it('checks before copying anything, so nothing is left behind', async () => {
    const parts = onDrive();
    const { File } = await import('./fakeDrive.ts');
    new File(`${DRIVE}/Hyperion/02.mp3`).delete();

    await copy.copyBookToDevice(BOOK, parts);
    assert.deepEqual(listAll(stagingDir), []);
    assert.deepEqual(listAll(finalDir), []);
  });
});

describe('a phone with no room', () => {
  it('refuses before copying, and says how much short it is', async () => {
    const parts = onDrive([5 * 1024 * 1024 * 1024]);
    // The margin is a gigabyte on top of the book itself.
    faults.freeBytes = 5 * 1024 * 1024 * 1024;

    const out = await copy.copyBookToDevice(BOOK, parts);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, 'no-space');
    assert.match(out.message, /MB short/);
    assert.deepEqual(listAll(finalDir), [], 'nothing was written');
  });

  it('keeps a margin free rather than filling the phone exactly', async () => {
    // A phone with no headroom left cannot write its own database.
    const parts = onDrive([1000]);
    faults.freeBytes = copy.FREE_SPACE_MARGIN_BYTES + 999;
    const tight = await copy.copyBookToDevice(BOOK, parts);
    assert.equal(tight.ok, false);

    resetDrive();
    const more = onDrive([1000]);
    faults.freeBytes = copy.FREE_SPACE_MARGIN_BYTES + 1000;
    const fits = await copy.copyBookToDevice(BOOK, more);
    assert.equal(fits.ok, true);
  });
});

describe('a copy that is stopped', () => {
  it('saves nothing when cancelled before it starts', async () => {
    const parts = onDrive();
    const out = await copy.copyBookToDevice(BOOK, parts, { shouldCancel: () => true });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, 'cancelled');
    assert.match(out.message, /Nothing was saved/);
    assert.deepEqual(listAll(stagingDir), []);
    assert.deepEqual(listAll(finalDir), []);
  });

  it('saves nothing when cancelled between parts', async () => {
    const parts = onDrive([1000, 2000, 3000]);
    let seen = 0;
    const out = await copy.copyBookToDevice(BOOK, parts, {
      shouldCancel: () => {
        seen += 1;
        return seen > 2;
      },
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, 'cancelled');
    assert.deepEqual(listAll(finalDir), [], 'a half-copied book never becomes a book');
    assert.deepEqual(listAll(stagingDir), [], 'and the staged bytes are discarded');
  });

  it('discards everything when the drive goes away mid-copy', async () => {
    const parts = onDrive([1000, 2000]);
    // The second write fails, as an unplugged cable does.
    faults.failWriteAfter = 2;

    const out = await copy.copyBookToDevice(BOOK, parts);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.notEqual(out.reason, 'source-missing');
    assert.deepEqual(listAll(finalDir), []);
  });
});

describe('resuming a copy the app did not live to finish', () => {
  it('keeps the parts an interrupted run landed and copies only the rest', async () => {
    /*
     * Only reachable after a kill: every other exit discards the staging
     * folder. The manifest is what makes it safe — without proof the staged
     * bytes belong to these parts, resuming would splice two books together.
     */
    const parts = onDrive([1000, 2000]);
    const { Directory, File } = await import('./fakeDrive.ts');

    // Stage part one by hand, with the manifest a real run would have left.
    new Directory(`${DOCUMENT_ROOT}/books-tmp`).create({ intermediates: true, idempotent: true });
    new Directory(stagingDir).create();
    const staged = new File(`${stagingDir}/0000.mp3`);
    staged.write(new Uint8Array(1000));
    // The shape the production code writes: pairs of [name, size]. Spelled
    // out rather than imported because `manifestFor` is private, so this
    // doubles as a check that its format has not quietly changed.
    new File(`${stagingDir}/${copy.MANIFEST_NAME}`).write(
      JSON.stringify(parts.map((p) => [p.name, p.sizeBytes])),
    );

    const out = await copy.copyBookToDevice(BOOK, parts);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(sizeOf(`${finalDir}/0000.mp3`), 1000);
    assert.equal(sizeOf(`${finalDir}/0001.mp3`), 2000);
  });

  it('charges a resume only for the bytes still to come', async () => {
    /*
     * A resume that was charged for the whole book would refuse on a phone
     * that has room for what is actually left — which is the phone you are
     * most likely to be holding, since it is the one that just filled up.
     */
    const parts = onDrive([3000, 1000]);
    const { Directory, File } = await import('./fakeDrive.ts');
    new Directory(`${DOCUMENT_ROOT}/books-tmp`).create({ intermediates: true, idempotent: true });
    new Directory(stagingDir).create();
    new File(`${stagingDir}/0000.mp3`).write(new Uint8Array(3000));
    new File(`${stagingDir}/${copy.MANIFEST_NAME}`).write(
      JSON.stringify(parts.map((p) => [p.name, p.sizeBytes])),
    );

    // Room for the remaining 1000 bytes, but not for all 4000.
    faults.freeBytes = copy.FREE_SPACE_MARGIN_BYTES + 1500;
    const out = await copy.copyBookToDevice(BOOK, parts);
    assert.equal(out.ok, true, 'the staged 3000 bytes are already on the phone');
  });

  it('starts over when two same-sized parts swapped places on the drive', async () => {
    /*
     * The case the manifest exists for, and the only one the size check
     * cannot catch. Staged files are named by index, so if two parts of equal
     * length trade places on the drive between runs, resuming would read each
     * back under the other's name — a book that plays its halves in the wrong
     * order, with every file the right length and nothing to flag.
     *
     * Deliberately not tested with a malformed manifest: that passes whether
     * or not the check works, since unreadable and mismatched both start over.
     */
    build(DRIVE, { Hyperion: { 'a.mp3': 1000, 'b.mp3': 1000 } });
    const { Directory, File } = await import('./fakeDrive.ts');

    // Staged by a run whose part order was b, a.
    new Directory(`${DOCUMENT_ROOT}/books-tmp`).create({ intermediates: true, idempotent: true });
    new Directory(stagingDir).create();
    const bBytes = new Uint8Array(1000).fill(2);
    const aBytes = new Uint8Array(1000).fill(1);
    new File(`${stagingDir}/0000.mp3`).write(bBytes);
    new File(`${stagingDir}/0001.mp3`).write(aBytes);
    new File(`${stagingDir}/${copy.MANIFEST_NAME}`).write(
      JSON.stringify([['b.mp3', 1000], ['a.mp3', 1000]]),
    );

    // This run's order is a, b. Same names, same sizes, different places.
    const parts = [
      { uri: `${DRIVE}/Hyperion/a.mp3`, name: 'a.mp3', sizeBytes: 1000 },
      { uri: `${DRIVE}/Hyperion/b.mp3`, name: 'b.mp3', sizeBytes: 1000 },
    ];
    // Distinguishable contents, so "which file landed here" is answerable.
    new File(`${DRIVE}/Hyperion/a.mp3`).write(aBytes);
    new File(`${DRIVE}/Hyperion/b.mp3`).write(bBytes);

    const out = await copy.copyBookToDevice(BOOK, parts);
    assert.equal(out.ok, true);

    const landed = new File(`${finalDir}/0000.mp3`).bytesSync();
    assert.equal(landed[0], 1, 'part 0 must be a.mp3, recopied — not the staged b.mp3');
  });

});

describe('the swap into place', () => {
  it('replaces an existing copy without nesting it one folder deeper', async () => {
    /*
     * The hazard the order guards against. `Directory.move` lands *inside* a
     * destination that already exists and renames to it only when it does
     * not — so moving the old copy aside first is what keeps the audio at
     * `books/<id>/0000.mp3` instead of `books/<id>/<id>/0000.mp3`, which
     * nothing would ever find.
     */
    const first = onDrive([1000]);
    await copy.copyBookToDevice(BOOK, first);
    assert.equal(sizeOf(`${finalDir}/0000.mp3`), 1000);

    resetDrive();
    const second = onDrive([2000]);
    await copy.copyBookToDevice(BOOK, second);

    assert.equal(sizeOf(`${finalDir}/0000.mp3`), 2000, 'replaced in place');
    assert.equal(sizeOf(`${finalDir}/${BOOK}/0000.mp3`), null, 'and not nested');
  });

  it('leaves no .previous folder behind once it is done', async () => {
    const parts = onDrive([1000]);
    await copy.copyBookToDevice(BOOK, parts);
    resetDrive();
    const again = onDrive([1000]);
    await copy.copyBookToDevice(BOOK, again);

    assert.deepEqual(
      listAll(`${DOCUMENT_ROOT}/books`).filter((u) => u.includes('.previous')),
      [],
    );
  });

  it('does not offer a .previous folder as a checked-out book', async () => {
    const { Directory } = await import('./fakeDrive.ts');
    new Directory(`${DOCUMENT_ROOT}/books`).create({ intermediates: true, idempotent: true });
    new Directory(`${DOCUMENT_ROOT}/books/${BOOK}`).create();
    new Directory(`${DOCUMENT_ROOT}/books/${BOOK}.previous`).create();

    assert.deepEqual(copy.listLocalBookIds(), [BOOK]);
  });
});

describe('recovering a swap the app was killed during', () => {
  it('puts the old copy back when the new one never arrived', async () => {
    /*
     * The whole reason the old copy is moved aside rather than deleted. A
     * kill between the two steps would otherwise leave a gap with neither
     * version on disk: a book the app believes is checked out, with no audio.
     */
    const { Directory, File } = await import('./fakeDrive.ts');
    new Directory(`${DOCUMENT_ROOT}/books`).create({ intermediates: true, idempotent: true });
    new Directory(`${DOCUMENT_ROOT}/books/${BOOK}.previous`).create();
    new File(`${DOCUMENT_ROOT}/books/${BOOK}.previous/0000.mp3`).write(new Uint8Array(1000));

    await copy.recoverInterruptedSwaps();

    assert.equal(sizeOf(`${finalDir}/0000.mp3`), 1000, 'the old copy is the book again');
    assert.deepEqual(
      listAll(`${DOCUMENT_ROOT}/books`).filter((u) => u.includes('.previous')),
      [],
    );
  });

  it('discards the old copy when the new one did arrive', async () => {
    const { Directory, File } = await import('./fakeDrive.ts');
    new Directory(`${DOCUMENT_ROOT}/books`).create({ intermediates: true, idempotent: true });
    new Directory(finalDir).create();
    new File(`${finalDir}/0000.mp3`).write(new Uint8Array(2000));
    new Directory(`${DOCUMENT_ROOT}/books/${BOOK}.previous`).create();
    new File(`${DOCUMENT_ROOT}/books/${BOOK}.previous/0000.mp3`).write(new Uint8Array(1000));

    await copy.recoverInterruptedSwaps();

    assert.equal(sizeOf(`${finalDir}/0000.mp3`), 2000, 'the new copy wins');
    assert.deepEqual(
      listAll(`${DOCUMENT_ROOT}/books`).filter((u) => u.includes('.previous')),
      [],
    );
  });

  it('does nothing when there is nothing to recover', async () => {
    await copy.recoverInterruptedSwaps();
    assert.deepEqual(listAll(`${DOCUMENT_ROOT}/books`), []);
  });
});

describe('what is on the phone', () => {
  it('lists the ids with audio, and finds their files', async () => {
    const parts = onDrive([1000, 2000]);
    await copy.copyBookToDevice(BOOK, parts);

    assert.deepEqual(copy.listLocalBookIds(), [BOOK]);
    // URIs, not relative paths: the player is handed these directly. Note the
    // filter is `instanceof File`, which is why a `.previous` folder beside
    // the book never shows up here as audio.
    assert.deepEqual(copy.localPathsFor(BOOK), [
      `${finalDir}/0000.mp3`,
      `${finalDir}/0001.mp3`,
    ]);
    assert.ok(copy.localUriFor(`books/${BOOK}/0000.mp3`));
  });

  it('forgets a returned book completely', async () => {
    const parts = onDrive();
    await copy.copyBookToDevice(BOOK, parts);
    copy.deleteLocalCopy(BOOK);

    assert.deepEqual(copy.listLocalBookIds(), []);
    assert.deepEqual(listAll(finalDir), []);
  });

  it('reports no local paths for a book that was never checked out', () => {
    assert.deepEqual(copy.localPathsFor('never'), []);
    assert.equal(copy.localUriFor('books/never/0000.mp3'), null);
  });
});
