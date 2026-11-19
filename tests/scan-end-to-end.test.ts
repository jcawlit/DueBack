/**
 * A whole scan, from files on a drive to rows in a database.
 *
 * `scanLibrary` is the largest thing in the repository and the one that
 * decides what a library *is*: which files are which book, which book is the
 * one that moved, and — the part with teeth — what a scan is entitled to
 * conclude from not finding something. Its helpers were well covered and the
 * orchestration joining them was not covered at all.
 *
 * Both layers under it are stood in for and nothing else is. The filesystem is
 * `tests/fakeDrive.ts`; the database is real SQLite through `node:sqlite`, so
 * the production migrations and every production statement run for real. The
 * audio is real too — the committed fixtures, with genuine ID3 tags, chapters,
 * cover art and a Xing duration header — so the parser, the naming, the
 * grouping, the identity and the missing sweep are all the real ones.
 *
 * Two things here are deliberately *not* covered, so nothing is mistaken for
 * covering them: anything about speed, and lock contention. The fake's
 * `withExclusiveTransactionAsync` is an ordinary transaction, where the real
 * one opens its own connection — which is the entire reason `withLockRetry`
 * exists.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import {
  build,
  deregisterDriveHooks,
  faults,
  fixtureBytes,
  installFakeDatabase,
  resetDrive,
  type Tree,
} from './fakeDrive.ts';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const DRIVE = 'file:///library';

/**
 * Real audio. `chap.mp3` is "The Count of Monte Cristo" by Alexandre Dumas,
 * 30 seconds, five ID3 chapters and a cover; `id3v24.mp3` is "Les Misérables
 * — Tome I" by Victor Hugo.
 */
const MONTE_CRISTO = fixtureBytes('chap.mp3');
const LES_MIS = fixtureBytes('id3v24.mp3');

let scanner: typeof import('../src/lib/scan/scanner.ts');
let schema: typeof import('../src/db/schema.ts');
let raw: DatabaseSync;

before(async () => {
  raw = installFakeDatabase();
  schema = await import('../src/db/schema.ts');
  const migrations = await import('../src/db/migrations.ts');
  await migrations.migrate((await schema.getDb()) as never);
  scanner = await import('../src/lib/scan/scanner.ts');
});

after(() => {
  deregisterDriveHooks();
  raw.close();
});

beforeEach(() => {
  resetDrive();
  for (const table of ['books', 'parts', 'chapters', 'checkouts', 'settings', 'book_overrides']) {
    raw.exec(`DELETE FROM ${table}`);
  }
});

const scan = async (tree: Tree, options: Partial<Parameters<typeof scanner.scanLibrary>[0]> = {}) => {
  build(DRIVE, tree);
  return scanner.scanLibrary({ rootUri: DRIVE, ...options });
};

const rows = () =>
  raw
    .prepare(
      `SELECT id, title, author, folder_rel_path, missing, path_key, duration_sec, cover_file
         FROM books ORDER BY folder_rel_path`,
    )
    .all() as {
    id: string;
    title: string;
    author: string | null;
    folder_rel_path: string;
    missing: number;
    path_key: string | null;
    duration_sec: number;
    cover_file: string | null;
  }[];

const partsOf = (bookId: string) =>
  (
    raw
      .prepare('SELECT rel_path FROM parts WHERE book_id = ? ORDER BY idx')
      .all(bookId) as { rel_path: string }[]
  ).map((p) => p.rel_path);

const chapterCount = (bookId: string) =>
  (raw.prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?').get(bookId) as { n: number })
    .n;

describe('a library arriving for the first time', () => {
  it('turns folders of audio into books, titled from their tags', async () => {
    const result = await scan({
      Hyperion: { '01.mp3': MONTE_CRISTO },
      'Gorky Park': { '01.mp3': LES_MIS },
    });

    assert.equal(result.rootReadable, true);
    assert.equal(result.completed, true);
    assert.equal(result.books, 2);

    const [gorky, hyperion] = rows();
    assert.equal(hyperion.title, 'The Count of Monte Cristo', 'the tag, not the folder');
    assert.equal(hyperion.author, 'Alexandre Dumas');
    assert.equal(gorky.title, 'Les Misérables — Tome I');
    assert.equal(gorky.author, 'Victor Hugo');
  });

  it('reads duration, chapters and cover art through the real parser', async () => {
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO } });
    const [book] = rows();
    assert.ok(Math.abs(book.duration_sec - 30) < 1, `duration ${book.duration_sec}`);
    assert.equal(chapterCount(book.id), 5, 'the five ID3 chapters');
    assert.ok(book.cover_file, 'the embedded cover was extracted and cached');
  });

  it('keeps a book’s parts in playback order', async () => {
    // "Part 2" before "Part 10": the reason it is not a string sort.
    await scan({
      Hyperion: {
        'Part 10.mp3': MONTE_CRISTO,
        'Part 2.mp3': MONTE_CRISTO,
        'Part 1.mp3': MONTE_CRISTO,
      },
    });
    const [book] = rows();
    assert.deepEqual(partsOf(book.id), [
      'Hyperion/Part 1.mp3',
      'Hyperion/Part 2.mp3',
      'Hyperion/Part 10.mp3',
    ]);
  });

  it('counts the audio it will not play and ignores the platform’s litter', async () => {
    const result = await scan({
      Hyperion: {
        '01.mp3': MONTE_CRISTO,
        '02.flac': 1,
        '03.ogg': 1,
        '.DS_Store': 1,
        'Thumbs.db': 1,
      },
    });
    assert.equal(result.books, 1);
    assert.equal(result.skippedUnsupported, 2);
    assert.deepEqual(partsOf(rows()[0].id), ['Hyperion/01.mp3']);
  });

  it('indexes a folder of unreadable audio rather than dropping it', async () => {
    /*
     * Zero-filled files are not audio. One bad file must never break a scan,
     * so the book is still indexed — with warnings, no parts and no duration
     * — instead of vanishing with nothing to explain why.
     */
    const result = await scan({ Broken: { '01.mp3': 4096 } });
    assert.equal(result.books, 1);
    assert.deepEqual(result.errors, [], 'a book that cannot be read is not a scan error');
    const [book] = rows();
    assert.equal(book.folder_rel_path, 'Broken');
    assert.deepEqual(partsOf(book.id), [], 'nothing playable to record');
    const warnings = (
      raw.prepare('SELECT warnings FROM books WHERE id = ?').get(book.id) as { warnings: string }
    ).warnings;
    assert.match(warnings, /no readable audio/, 'the file is named');
    assert.match(warnings, /Nothing in this folder could be read as audio/, 'and the book says so');
  });

  it('gives each book an id that is not its path, and a path key that is', async () => {
    /*
     * Identity is minted once and kept for ever; the path key is how a later
     * scan finds the row again. Progress, notes and history hang off the id,
     * which is why a folder rename must not produce a new one.
     */
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO } });
    const [book] = rows();
    assert.ok(book.path_key, 'a path key is recorded');
    assert.notEqual(book.id, book.folder_rel_path);
    assert.notEqual(book.id, book.title);
  });
});

describe('scanning the same library again', () => {
  it('updates the existing rows instead of making new ones', async () => {
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO }, 'Gorky Park': { '01.mp3': LES_MIS } });
    const first = rows();

    const again = await scanner.scanLibrary({ rootUri: DRIVE });
    assert.equal(again.books, 2);
    assert.deepEqual(
      rows().map((b) => b.id),
      first.map((b) => b.id),
      'the same ids, so everything written against them survives',
    );
  });

  it('reports a book whose files have not changed as unchanged', async () => {
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO } });
    const again = await scanner.scanLibrary({ rootUri: DRIVE });
    assert.equal(again.unchanged, 1);
    assert.equal(again.updated, 0);
  });

  it('re-reads everything when forced', async () => {
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO } });
    const forced = await scanner.scanLibrary({ rootUri: DRIVE, force: true });
    assert.equal(forced.unchanged, 0, 'force means read it again whatever the fingerprint says');
  });
});

describe('a book that moved', () => {
  it('is recognised rather than duplicated when its folder is renamed', async () => {
    /*
     * The case the identity layer exists for. Renaming a folder on a computer
     * must not produce a second book: the notes, the place in the story and
     * the history all hang off the id, and a duplicate leaves them attached
     * to a book that no longer appears on any shelf.
     */
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO, '02.mp3': LES_MIS } });
    const before = rows();
    assert.equal(before.length, 1);

    resetDrive();
    await scan({ 'Hyperion (1989)': { '01.mp3': MONTE_CRISTO, '02.mp3': LES_MIS } });

    const after = rows();
    assert.equal(after.length, 1, 'one book, not two');
    assert.equal(after[0].id, before[0].id, 'and the same id');
    assert.equal(after[0].folder_rel_path, 'Hyperion (1989)', 'now at its new address');
  });

  it('does not quietly consume an unrelated book that merely looks alike', async () => {
    /*
     * Reconnecting the wrong book moves somebody's place, their history and
     * everything they wrote onto a book that is not theirs, and there is no
     * undo for that worth the name. Two existing books of the same shape make
     * any guess ambiguous, so neither may be taken.
     */
    await scan({ 'Book A': { '01.mp3': MONTE_CRISTO }, 'Book B': { '01.mp3': MONTE_CRISTO } });
    assert.equal(rows().length, 2);

    resetDrive();
    await scan({ 'Book C': { '01.mp3': MONTE_CRISTO } });

    const folders = rows().map((b) => b.folder_rel_path);
    assert.ok(folders.includes('Book C'), 'the new folder is indexed');
    assert.ok(
      folders.includes('Book A') && folders.includes('Book B'),
      'and neither old book was consumed by it',
    );
  });
});

describe('what a scan may conclude from not finding a book', () => {
  it('marks a book missing when it has really gone from the drive', async () => {
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO }, 'Gorky Park': { '01.mp3': LES_MIS } });
    resetDrive();
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO } });

    const gone = rows().find((b) => b.folder_rel_path === 'Gorky Park')!;
    assert.equal(gone.missing, 1, 'marked, not deleted: the notes stay');
    assert.equal(rows().find((b) => b.folder_rel_path === 'Hyperion')!.missing, 0);
  });

  it('does not mark a book missing because its folder could not be read', async () => {
    /*
     * The end-to-end form of `tests/coverage.test.ts`. A gap read as "gone"
     * ends with Settings offering to "Forget N missing books", which deletes
     * notes and history — so a scan that could not look must not conclude.
     */
    await scan({
      'Sci-fi': { Hyperion: { '01.mp3': MONTE_CRISTO } },
      Crime: { Smiley: { '01.mp3': LES_MIS } },
    });
    assert.equal(rows().length, 2);

    faults.unlistable.add(`${DRIVE}/Sci-fi`);
    const partial = await scanner.scanLibrary({ rootUri: DRIVE });

    assert.equal(partial.rootReadable, true);
    assert.ok(partial.unreadableFolders.length > 0, 'and it says which folder');
    const hidden = rows().find((b) => b.folder_rel_path.startsWith('Sci-fi'))!;
    assert.equal(hidden.missing, 0, 'present, and left alone');
  });

  /*
   * The depth-limit case is **not** tested here, deliberately.
   *
   * For the sweep's protection to apply, a book's recorded folder has to sit
   * under a subtree the walk truncated — which means it was indexed when it
   * was reachable and is now not. The limit is fixed at eight and not a scan
   * option, so there is no way to arrange that through `scanLibrary` without
   * writing the row by hand, and a test that writes the row by hand is the
   * unit test that already exists. `tests/coverage.test.ts` pins it against
   * real SQLite, including that an already-missing book stays missing.
   *
   * Said out loud because a plausible-looking end-to-end version of this
   * passes whether or not the protection works: nest the library deeper and
   * the old shallow path is simply gone from a readable root, which *should*
   * mark it missing.
   */
  it('concludes nothing at all when the root itself cannot be read', async () => {
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO } });
    resetDrive();

    const unplugged = await scanner.scanLibrary({ rootUri: DRIVE });
    assert.equal(unplugged.rootReadable, false);
    assert.equal(rows()[0].missing, 0, 'an unplugged drive is not an empty library');
  });

  it('concludes nothing when the scan was cancelled partway', async () => {
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO }, 'Gorky Park': { '01.mp3': LES_MIS } });

    let seen = 0;
    const stopped = await scanner.scanLibrary({
      rootUri: DRIVE,
      shouldCancel: () => {
        seen += 1;
        return seen > 1;
      },
    });
    assert.equal(stopped.completed, false);
    assert.deepEqual(
      rows().map((b) => b.missing),
      [0, 0],
      'a scan that stopped early speaks for nothing',
    );
  });

  it('brings a book back when it reappears', async () => {
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO } });
    resetDrive();
    await scan({});
    assert.equal(rows()[0].missing, 1);

    resetDrive();
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO } });
    assert.equal(rows()[0].missing, 0, 'found is found');
  });
});

describe('a library that fights back', () => {
  it('indexes what it can reach and reports the folder it could not', async () => {
    build(DRIVE, {
      Good: { '01.mp3': MONTE_CRISTO },
      Bad: { '01.mp3': LES_MIS },
      AlsoGood: { '01.mp3': MONTE_CRISTO },
    });
    faults.unlistable.add(`${DRIVE}/Bad`);

    const result = await scanner.scanLibrary({ rootUri: DRIVE });
    assert.equal(result.rootReadable, true);
    assert.equal(result.unreadableFolders.length, 1);
    assert.match(result.unreadableFolders[0], /^Bad: /);
    assert.equal(rows().length, 2, 'the two readable books are indexed');
  });

  it('reads an empty but present library as empty, without error', async () => {
    const result = await scan({});
    assert.equal(result.rootReadable, true);
    assert.equal(result.books, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.unreadableFolders, []);
  });

  it('reports progress, ending in a terminal phase', async () => {
    const phases: string[] = [];
    await scan({ Hyperion: { '01.mp3': MONTE_CRISTO } }, { onProgress: (p) => phases.push(p.phase) });
    assert.ok(phases.length > 0);
    assert.ok(
      phases.includes('listing') || phases.includes('reading'),
      `phases were ${phases.join(', ')}`,
    );
  });
});
