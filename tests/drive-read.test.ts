/**
 * Reading the drive: the production `listTree`, against a fake filesystem.
 *
 * This is the first thing a scan does and everything else stands on it. Until
 * now none of it ran outside a phone, so the rules it enforces — what counts
 * as junk, what counts as skipped, and above all the difference between "no
 * books here" and "I could not look" — were only ever checked by hand.
 *
 * That last distinction is the one worth the whole file. `markMissingExcept`
 * treats absence from the walk as proof a book has gone, and a scan that
 * wrongly concludes that ends with Settings offering to "Forget N missing
 * books", which deletes notes and history. Every assertion here about
 * `rootReadable`, `unreadableFolders` and `unseenFolders` is really an
 * assertion about that.
 *
 * `tests/fakeDrive.ts` replaces only `expo-file-system`; the walk itself is
 * the real one. Its header says what the fake does and does not model.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  build,
  deregisterDriveHooks,
  faults,
  resetDrive,
  type Tree,
} from './fakeDrive.ts';

const ROOT = 'file:///library';

let access: typeof import('../src/lib/files/access.ts');

before(async () => {
  access = await import('../src/lib/files/access.ts');
});

after(() => deregisterDriveHooks());

beforeEach(() => resetDrive());

const listing = (tree: Tree, options?: { maxDepth?: number }) => {
  build(ROOT, tree);
  return access.listTree(ROOT, options);
};

const paths = (files: { relPath: string }[]) => files.map((f) => f.relPath).sort();

describe('a library it can read', () => {
  it('finds a flat book, with the facts the scanner decides on', async () => {
    const out = await listing({
      Hyperion: { '01.mp3': 1024, '02.mp3': 2048 },
    });
    assert.equal(out.rootReadable, true);
    assert.deepEqual(paths(out.files), ['Hyperion/01.mp3', 'Hyperion/02.mp3']);

    const first = out.files.find((f) => f.relPath === 'Hyperion/01.mp3')!;
    assert.equal(first.name, '01.mp3');
    assert.equal(first.sizeBytes, 1024, 'size is what recognises a book that moved');
    assert.equal(first.modifiedMs, 1);
    assert.ok(first.uri.endsWith('Hyperion/01.mp3'));
  });

  it('descends into discs and spells the path from the root', async () => {
    const out = await listing({
      Hyperion: { 'Disc 1': { '01.mp3': 1 }, 'Disc 2': { '01.mp3': 1 } },
    });
    assert.deepEqual(paths(out.files), [
      'Hyperion/Disc 1/01.mp3',
      'Hyperion/Disc 2/01.mp3',
    ]);
  });

  it('calls an empty folder readable and empty, not unreadable', async () => {
    /*
     * The distinction the whole design rests on. An empty library is a
     * legitimate answer; an unreadable one is not, and `rootReadable` is a
     * separate flag rather than `files.length === 0` precisely so the two can
     * never be confused.
     */
    const out = await listing({});
    assert.equal(out.rootReadable, true);
    assert.deepEqual(out.files, []);
    assert.deepEqual(out.unseenFolders, [], 'nothing was missed; there was nothing there');
  });

  it('keeps non-audio files in the listing', async () => {
    // Covers are found from this listing, and grouping has to see a DRM
    // container to mark its book unplayable rather than hide it.
    const out = await listing({
      Hyperion: { '01.mp3': 1, 'cover.jpg': 10, 'book.aax': 99 },
    });
    assert.deepEqual(paths(out.files), [
      'Hyperion/01.mp3',
      'Hyperion/book.aax',
      'Hyperion/cover.jpg',
    ]);
  });
});

describe('what it refuses to count', () => {
  it('drops the junk a platform leaves behind, without calling it skipped', async () => {
    /*
     * Junk is dropped here rather than later so it is never counted as a
     * skipped file, never warned about, and never offered as cover art.
     * Someone reading "4 files skipped" should be reading about their audio.
     */
    const out = await listing({
      Hyperion: {
        '01.mp3': 1,
        '.DS_Store': 1,
        'Thumbs.db': 1,
        'desktop.ini': 1,
        '._01.mp3': 1,
        'AlbumArtSmall.ini': 1,
      },
    });
    assert.deepEqual(paths(out.files), ['Hyperion/01.mp3']);
    assert.equal(out.unsupportedCount, 0, 'junk is not a skipped audio file');
  });

  it('skips a junk folder whole', async () => {
    const out = await listing({
      '.Trashes': { 'something.mp3': 1 },
      Hyperion: { '01.mp3': 1 },
    });
    assert.deepEqual(paths(out.files), ['Hyperion/01.mp3']);
  });

  it('counts audio it recognises but will not play, and leaves it out', async () => {
    const out = await listing({
      Hyperion: { '01.flac': 1, '02.ogg': 1, '03.opus': 1, '04.wav': 1, '05.mp3': 1 },
    });
    assert.equal(out.unsupportedCount, 4);
    assert.deepEqual(paths(out.files), ['Hyperion/05.mp3']);
  });

  it('lets the app’s own incomplete marker through', async () => {
    /*
     * The one dotfile a scan must see. It marks a book still being written to
     * the drive, and a scan that treated it as junk would index a half-copied
     * book as if it were whole.
     */
    const out = await listing({
      Hyperion: { '.dueback-incomplete': 'x', '01.mp3': 1 },
    });
    assert.ok(
      out.files.some((f) => f.name.startsWith('.dueback-incomplete')),
      'the marker has to reach grouping',
    );
  });
});

describe('a library it cannot fully read', () => {
  it('reports an absent root as unreadable, and says the whole tree was unseen', async () => {
    // Nothing is built: the folder does not exist.
    const out = await access.listTree(ROOT);
    assert.equal(out.rootReadable, false);
    assert.deepEqual(out.unseenFolders, [''], 'the empty string is the root');
    assert.match(out.unreadableFolders[0], /could not be read/);
  });

  it('records a folder that will not list, with the reason', async () => {
    /*
     * The reason matters. A folder recorded as a bare path left "scanned no
     * books" with nothing anyone could act on.
     */
    build(ROOT, { 'Sci-fi': { Hyperion: { '01.mp3': 1 } }, Crime: { Smiley: { '01.mp3': 1 } } });
    faults.unlistable.add(`${ROOT}/Sci-fi`);

    const out = await access.listTree(ROOT);
    assert.equal(out.rootReadable, true, 'the root listed fine; one folder inside did not');
    assert.deepEqual(paths(out.files), ['Crime/Smiley/01.mp3'], 'the rest still scans');
    assert.deepEqual(out.unseenFolders, ['Sci-fi']);
    assert.equal(out.unreadableFolders.length, 1);
    assert.match(out.unreadableFolders[0], /^Sci-fi: /);
    assert.match(out.unreadableFolders[0], /permission denied/);
  });

  it('records a subtree cut off by the depth limit instead of returning silently', async () => {
    /*
     * This returned silently. A book nested deeper than the limit was absent
     * from the listing with nothing to explain it — and absent from a scan's
     * `seenIds`, which `markMissingExcept` reads as proof the book has gone.
     * The regression this guards had no symptom until books vanished.
     */
    const out = await listing(
      { A: { B: { C: { Hyperion: { '01.mp3': 1 } } } } },
      { maxDepth: 2 },
    );
    assert.deepEqual(out.files, [], 'too deep to reach');
    assert.deepEqual(out.unseenFolders, ['A/B/C'], 'and said so, by path');
    assert.match(out.unreadableFolders[0], /nested deeper than the scan goes \(2 folders\)/);
  });

  it('scans what it can reach and reports only what it could not', async () => {
    const out = await listing(
      {
        Shallow: { '01.mp3': 1 },
        A: { B: { C: { Deep: { '01.mp3': 1 } } } },
      },
      { maxDepth: 2 },
    );
    assert.deepEqual(paths(out.files), ['Shallow/01.mp3']);
    assert.deepEqual(out.unseenFolders, ['A/B/C']);
  });

  it('still lists a file it cannot stat, by name', async () => {
    // A file the platform will not stat is still worth having in the listing:
    // the name is what groups a book, and a zero size is a fact a later scan
    // can correct.
    build(ROOT, { Hyperion: { '01.mp3': 1024 } });
    faults.unstattable.add(`${ROOT}/Hyperion/01.mp3`);

    const out = await access.listTree(ROOT);
    assert.deepEqual(paths(out.files), ['Hyperion/01.mp3']);
    assert.equal(out.files[0].sizeBytes, 0);
    assert.equal(out.files[0].modifiedMs, 0);
    assert.deepEqual(out.unreadableFolders, [], 'one bad file is not a bad folder');
  });

  it('never lets one unreadable folder stop the walk', async () => {
    build(ROOT, {
      A: { '01.mp3': 1 },
      B: { '01.mp3': 1 },
      C: { '01.mp3': 1 },
    });
    faults.unlistable.add(`${ROOT}/B`);

    const out = await access.listTree(ROOT);
    assert.deepEqual(paths(out.files), ['A/01.mp3', 'C/01.mp3']);
    assert.deepEqual(out.unseenFolders, ['B']);
  });
});

describe('the root URI', () => {
  it('reads a root given without a trailing slash', async () => {
    /*
     * `expo-file-system` treats a folder URI with no trailing slash as a file
     * and throws on listing it, which silently reported the root unreadable.
     * `asDirectoryUri` is the fix; this is the test that it is still applied.
     */
    build(ROOT, { Hyperion: { '01.mp3': 1 } });
    const bare = await access.listTree(ROOT);
    const slashed = await access.listTree(`${ROOT}/`);
    assert.equal(bare.rootReadable, true);
    assert.deepEqual(paths(bare.files), paths(slashed.files));
  });

  it('answers whether a root is present without walking it', async () => {
    assert.equal(access.isPresent(ROOT), false);
    build(ROOT, { Hyperion: { '01.mp3': 1 } });
    assert.equal(access.isPresent(ROOT), true);
    assert.equal(await access.isReachable(ROOT), true);
  });
});

describe('progress', () => {
  it('reports the count it finishes with', async () => {
    const seen: number[] = [];
    build(ROOT, { A: { '1.mp3': 1, '2.mp3': 1, '3.mp3': 1 } });
    const out = await access.listTree(ROOT, { onProgress: (n) => seen.push(n) });
    assert.equal(out.files.length, 3);
    assert.equal(seen.at(-1), 3, 'the last call is the final total');
  });
});
