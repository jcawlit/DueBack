/**
 * The on-device test suites, written against the F and X fixture library that
 * `npm run make:fixtures` builds.
 *
 * Section ids follow the test plan, so a failure here names the case in the
 * plan directly. Cases that depend on features which do not exist yet carry a
 * `skip` reason rather than being left out, so the gap stays visible.
 */

import { occupiesBudget } from '@/data/types';
import {
  assertLocalFilesGone,
  assertLocalFilesPresent,
  assertNoOrphans,
  bookById,
  booksInFolder,
  books,
  check,
  checkOutAndSettle,
  ensureDir,
  ensureScan,
  parkFolder,
  setRootReachable,
  equal,
  foldersOf,
  lastMessage,
  library,
  listNames,
  near,
  oneBookIn,
  scanner,
  sleep,
  waitFor,
  appDir,
  type Suite,
} from './harness';
import { File } from 'expo-file-system';
import { forgetMissingBooks, loadDevBooks, loadParts } from '@/db/books';
import { SETTING_KEYS, getSetting } from '@/db/schema';
import { usePlayer } from '@/store/player';
import { SPEEDS } from '@/lib/audio/engine';
import { buildShelves } from '@/lib/shelves';
import { IMPORTS_DIR } from '@/lib/files/import';
import { buildImportedBook, saveImportedBook } from '@/lib/scan/importBook';
import { reconcileLocalCopies } from '@/store/library';
import { BOOKS_DIR, BOOKS_TMP_DIR, clearTempCopies } from '@/lib/files/copy';

const player = () => usePlayer.getState();

const titlesOf = (list: { title: string }[]) => list.map((b) => b.title).sort().join(' | ');

/** Part names of a book, in stored order. */
async function partNames(bookId: string): Promise<string[]> {
  const parts = await loadParts(bookId);
  return parts.map((p) => p.name);
}

async function partRelPaths(bookId: string): Promise<string[]> {
  const parts = await loadParts(bookId);
  return parts.map((p) => p.rel_path);
}

// =====================================================================  A1

const a1Scanning: Suite = {
  id: 'A1',
  name: 'Scanning and indexing',
  cases: [
    {
      id: 'S-02',
      name: 'baseline scan of the full fixture set',
      async run(ctx) {
        await library().setLibraryRoot({ uri: `file://${ctx.rootPath}`, name: 'fixtures' });
        await ensureScan({ force: true });
        const result = scanner().lastResult;
        check(!!result, 'no scan result');
        check(result!.books > 0, 'scanned no books');

        if (ctx.manifest) {
          equal(books().length, ctx.manifest.expectedBookCount, 'book count');
        }
        return `${books().length} books, ${result!.filesSeen} files, ` +
          `${result!.errors.length + result!.unreadableFiles.length} errors`;
      },
    },
    {
      id: 'S-03',
      name: 'scanning never copies audio',
      async run() {
        const copied = listNames(appDir(BOOKS_DIR));
        const staged = listNames(appDir(BOOKS_TMP_DIR));
        check(copied.length === 0, `books/ is not empty after a scan: ${copied.join(', ')}`);
        check(staged.length === 0, `books-tmp/ is not empty: ${staged.join(', ')}`);
        return 'books/ and books-tmp/ empty';
      },
    },
    {
      id: 'S-04',
      name: 'title and author resolution',
      async run() {
        const hyperion = await oneBookIn('Hyperion - Dan Simmons');
        equal(hyperion.title, 'Hyperion', 'F1 title');
        equal(hyperion.author, 'Dan Simmons', 'F1 author');

        const natural = await oneBookIn('Natural Sort');
        equal(natural.title, 'Natural Sort', 'F3 title');

        const tolstoy = await oneBookIn('Война и мир - Лев Толстой');
        equal(tolstoy.title, 'Война и мир', 'F17 title');
        equal(tolstoy.author, 'Лев Толстой', 'F17 author');
        return 'F1, F3, F17 resolved';
      },
    },
    {
      id: 'S-05',
      name: 'part ordering by tags and by natural filename',
      async run() {
        const longWay = await oneBookIn('The Long Way (Unabridged) [MP3] 64kbps');
        equal((await partNames(longWay.id)).join(','),
          Array.from({ length: 12 }, (_, i) => `Part ${i + 1}.mp3`).join(','),
          'F2 order');

        const natural = await oneBookIn('Natural Sort');
        equal((await partNames(natural.id)).join(','),
          'Part 1.mp3,Part 2.mp3,Part 10.mp3', 'F3 natural order');

        const tagWins = await oneBookIn('Tag Wins');
        equal((await partNames(tagWins.id)).join(','), 'b.mp3,c.mp3,a.mp3', 'F4 tag order');
        return 'F2, F3, F4 ordered correctly';
      },
    },
    {
      id: 'S-06',
      name: 'chapter fallback rules',
      async run() {
        const hyperion = await oneBookIn('Hyperion - Dan Simmons');
        equal(hyperion.chapters.length, 5, 'F1 chapters');

        const longWay = await oneBookIn('The Long Way (Unabridged) [MP3] 64kbps');
        equal(longWay.chapters.length, 12, 'F2 one chapter per part');
        check(longWay.chaptersFromParts, 'F2 should be flagged as per-part chapters');

        const noArt = await oneBookIn('No Art');
        equal(noArt.chapters.length, 0, 'F6 chapters');

        const qt = await oneBookIn('Chapters QT');
        equal(qt.chapters.length, 300, 'F20 chapters past the Nero ceiling');
        return 'F1=5, F2=12 per-part, F6=0, F20=300';
      },
    },
    {
      id: 'S-07',
      name: 'cover selection and thumbnail size',
      async run() {
        const hyperion = await oneBookIn('Hyperion - Dan Simmons');
        check(!!hyperion.coverThumbPath, 'F1 has no cover');
        const embedded = await oneBookIn('Embedded Only');
        check(!!embedded.coverThumbPath, 'F5 has no cover');
        const noArt = await oneBookIn('No Art');
        check(!noArt.coverThumbPath, 'F6 should have no stored cover');
        const mixed = await oneBookIn('Mixed');
        check(!!mixed.coverThumbPath, 'F8 should use back.png');
        return 'F1, F5, F8 have covers; F6 falls back to a generated one';
      },
    },
    {
      id: 'S-08',
      name: 'non-audio files in a book folder are ignored',
      async run() {
        const mixed = await oneBookIn('Mixed');
        const names = await partNames(mixed.id);
        equal(names.length, 1, 'F8 part count');
        equal(names[0], 'book.m4b', 'F8 part');
        return 'the .mobi and .txt are not parts';
      },
    },
    {
      id: 'S-09',
      name: 'unsupported formats are counted, not indexed',
      async run(ctx) {
        equal((await booksInFolder('Unsupported')).length, 0, 'F9 book count');
        const result = scanner().lastResult;
        if (ctx.manifest) {
          check(
            result!.skippedUnsupported >= ctx.manifest.unsupportedFileCount,
            `skipped count was ${result!.skippedUnsupported}`,
          );
        }
        return `${result!.skippedUnsupported} skipped`;
      },
    },
    {
      id: 'S-10',
      name: 'a folder with no audio produces no book',
      async run() {
        equal((await booksInFolder('No Audio')).length, 0, 'F10 book count');
        return 'no book, no warning';
      },
    },
    {
      id: 'S-11',
      name: 'a zero-length file is not a playable book',
      async run() {
        const found = await booksInFolder('Zero');
        if (found.length === 0) return 'no book created';
        const book = found[0];
        equal((await partNames(book.id)).length, 0, 'an empty file must not become a part');
        await checkOutAndSettle(book.id);
        equal(bookById(book.id)!.local.status, 'on-shelf', 'F11 status after check-out');
        check(/no audio|empty|damaged/i.test(lastMessage()), `message was "${lastMessage()}"`);
        return `no parts, refused: "${lastMessage()}"`;
      },
    },
    {
      id: 'S-12',
      name: 'corrupt and truncated files never stop the scan',
      async run() {
        // Whether they produce a flagged book or none at all is acceptable;
        // what matters is that the rest of the library is complete.
        const corrupt = await booksInFolder('Corrupt');
        const truncated = await booksInFolder('Truncated');
        for (const book of [...corrupt, ...truncated]) {
          check(book.durationSec === 0, `${book.title} should have no duration`);
        }
        const hyperion = await oneBookIn('Hyperion - Dan Simmons');
        check(hyperion.durationSec > 0, 'a later book was left incomplete');
        return `corrupt=${corrupt.length}, truncated=${truncated.length}, rest intact`;
      },
    },
    {
      id: 'S-13',
      name: 'DRM is detected and refuses check-out',
      async run() {
        const drm = await oneBookIn('DRM');
        check(!!drm.drmProtected, 'F14 is not flagged as DRM');
        library().dismissSlip();
        library().checkOut(drm.id);
        await sleep(600);
        equal(bookById(drm.id)!.local.status, 'on-shelf', 'F14 status');
        check(/drm/i.test(lastMessage()), `message was "${lastMessage()}"`);
        return `refused: "${lastMessage()}"`;
      },
    },
    {
      id: 'S-14',
      name: 'URI-hostile and non-ASCII paths are indexed',
      async run() {
        await oneBookIn('Weird #1 %20 &= [v2]');
        await oneBookIn('Война и мир - Лев Толстой');
        return 'both indexed';
      },
    },
    {
      id: 'S-15',
      name: 'the scan stops at the depth limit',
      async run() {
        equal((await booksInFolder('d1/d2/d3/d4/d5/d6/d7/Deep Ok')).length, 1, 'depth 8');
        equal((await booksInFolder('e1/e2/e3/e4/e5/e6/e7/e8/Too Deep')).length, 0, 'depth 9');
        return 'depth 8 indexed, depth 9 skipped';
      },
    },
    {
      id: 'S-16',
      name: 'a large file is read by byte range, not in full',
      async run() {
        const big = await oneBookIn('Big');
        const parts = await loadParts(big.id);
        const size = parts[0].size_bytes;
        check(size > 20 * 1024 * 1024, `the Big fixture is only ${size} bytes`);
        check(big.durationSec > 0, 'Big has no duration');
        return `${(size / 1024 ** 2).toFixed(0)} MB indexed`;
      },
    },
  ],
};


// ====================================================================  A1b

const a1bMessy: Suite = {
  id: 'A1b',
  name: 'Messy real-world content',
  cases: [
    {
      id: 'MX-01a',
      name: 'disc subfolders become one book (X1)',
      async run() {
        const dune = await oneBookIn('Dune');
        const folders = await foldersOf(dune.id);
        equal(folders.join(','), 'Dune/CD 1,Dune/CD 2', 'Dune disc folders');
        equal((await partNames(dune.id)).length, 10, 'Dune part count');
        const paths = await partRelPaths(dune.id);
        equal(paths[0], 'Dune/CD 1/01.mp3', 'first part');
        equal(paths[4], 'Dune/CD 1/05.mp3', 'last part of disc 1');
        equal(paths[5], 'Dune/CD 2/01.mp3', 'first part of disc 2');
        return '10 parts, disc 1 then disc 2';
      },
    },
    {
      id: 'MX-01b',
      name: 'disc subfolders with disc tags (X2)',
      async run() {
        const foundation = await oneBookIn('Foundation');
        equal((await partNames(foundation.id)).length, 8, 'Foundation part count');
        const paths = await partRelPaths(foundation.id);
        equal(paths[0], 'Foundation/Disc1/Track01.mp3', 'first part');
        equal(paths[4], 'Foundation/Disc2/Track01.mp3', 'first part of disc 2');
        return '8 parts in disc order';
      },
    },
    {
      id: 'MX-02',
      name: 'self-recorded and untagged (X3)',
      async run() {
        const memoir = await oneBookIn('My Memoir (self recorded)');
        equal((await partNames(memoir.id)).length, 4, 'part count');
        check(memoir.durationSec > 0, 'no duration');
        equal(memoir.chapters.length, 4, 'one chapter per file');
        return `"${memoir.title}", 4 parts`;
      },
    },
    {
      id: 'MX-03',
      name: 'one folder of distinct albums splits into separate books (X4)',
      async run() {
        const found = await booksInFolder('Kids Stories');
        equal(found.length, 3, `Kids Stories book count (${titlesOf(found)})`);
        for (const book of found) {
          equal((await partNames(book.id)).length, 1, `${book.title} part count`);
        }
        return titlesOf(found);
      },
    },
    {
      id: 'MX-04',
      name: 'inconsistent and duplicate track tags (X5)',
      async run() {
        const odyssey = await oneBookIn('Odyssey');
        const paths = await partRelPaths(odyssey.id);
        equal(paths.length, 24, 'Odyssey part count');
        // Two files claim track 7, so the tags cannot be trusted for ordering
        // and natural filename order must be used instead.
        equal(paths[0], 'Odyssey/01 - Book I.mp3', 'first part');
        equal(paths[23], 'Odyssey/24 - Book XXIV.mp3', 'last part');
        return '24 parts in filename order';
      },
    },
    {
      id: 'MX-05',
      name: 'tags copied from the wrong source (X6)',
      async run() {
        const wrong = await oneBookIn('Wrong Tags');
        check(
          !wrong.author || !/various/i.test(wrong.author),
          `author should not be a placeholder, got "${wrong.author}"`,
        );
        return `title "${wrong.title}", author "${wrong.author ?? '(none)'}"`;
      },
    },
    {
      id: 'MX-06',
      name: 'mixed formats in one book (X7)',
      async run() {
        const mixed = await oneBookIn('Mixed Formats');
        const names = await partNames(mixed.id);
        equal(names.join(','), '01.mp3,02.m4a,03.mp3', 'part order');
        return '3 parts across two formats';
      },
    },
    {
      id: 'MX-07',
      name: 'loose files in the library root (X8)',
      async run() {
        const loose = await booksInFolder('');
        equal(loose.length, 2, `loose root files should be two books (${titlesOf(loose)})`);
        return titlesOf(loose);
      },
    },
    {
      id: 'MX-08',
      name: 'nested series with a shared parent cover (X9)',
      async run() {
        const one = await oneBookIn('Author/Series/Book 1');
        const two = await oneBookIn('Author/Series/Book 2');
        check(!!one.coverThumbPath, 'Book 1 did not inherit the series cover');
        check(!!two.coverThumbPath, 'Book 2 did not inherit the series cover');
        equal((await booksInFolder('Author')).length, 2, 'the series folder itself made a book');
        return 'two books, both using the series cover';
      },
    },
    {
      id: 'MX-09',
      name: 'hidden junk files are invisible (X10)',
      async run() {
        const junk = await oneBookIn('Mac Junk');
        const names = await partNames(junk.id);
        equal(names.join(','), 'book.m4b', 'parts');
        check(!!junk.coverThumbPath, 'the real cover was not found');

        // Warnings are not on `Book`; the developer row carries them.
        const dev = (await loadDevBooks()).find((d) => d.id === junk.id);
        const warnings: string[] = dev?.warnings ? JSON.parse(dev.warnings) : [];
        equal(warnings.length, 0, `unexpected warnings: ${warnings.join(' | ')}`);
        return 'one part, real cover, no warnings';
      },
    },
    {
      id: 'MX-10',
      name: 'uppercase extensions are recognised (X11)',
      async run() {
        const upper = await oneBookIn('UPPER');
        const upper2 = await oneBookIn('Upper2');
        check(upper.durationSec > 0, 'UPPER has no duration');
        check(upper2.durationSec > 0, 'Upper2 has no duration');
        return 'both .MP3 and .M4B indexed';
      },
    },
    {
      id: 'MX-11',
      name: 'VBR mp3 with no Xing header (X12)',
      async run() {
        const vbr = await oneBookIn('VBR No Header');
        // The fixture is 20 minutes. Without a header the duration has to be
        // estimated, so the tolerance is generous.
        near(vbr.durationSec, 1200, 120, 'estimated duration');
        return `${Math.round(vbr.durationSec)}s (actual 1200s)`;
      },
    },
    {
      id: 'MX-12',
      name: 'junk chapter data is cleaned up (X13)',
      async run() {
        const bad = await oneBookIn('Bad Chapters');
        const starts = bad.chapters.map((c) => c.startSec);
        const sorted = [...starts].sort((a, b) => a - b);
        equal(starts.join(','), sorted.join(','), 'chapters must be sorted by start');
        equal(new Set(starts).size, starts.length, 'duplicate chapter starts must be collapsed');
        const past = starts.filter((s) => s > bad.durationSec + 1);
        equal(past.length, 0, `${past.length} chapters start past the end of the book`);
        return `${bad.chapters.length} chapters, sorted and deduplicated`;
      },
    },
    {
      id: 'MX-13',
      name: 'blank chapter titles get a usable name (X14)',
      async run() {
        const blank = await oneBookIn('Empty Titles');
        const empty = blank.chapters.filter((c) => !c.title.trim());
        equal(empty.length, 0, `${empty.length} chapters still have blank titles`);
        return `${blank.chapters.length} chapters, all named`;
      },
    },
    {
      id: 'MX-14',
      name: 'a long untagged single file (X15)',
      async run() {
        const huge = await oneBookIn('One Huge');
        near(huge.durationSec, 36000, 600, 'ten-hour duration');
        equal(huge.chapters.length, 0, 'should have no chapters');
        return `${(huge.durationSec / 3600).toFixed(1)}h`;
      },
    },
    {
      id: 'MX-15',
      name: 'pathological numbering is ordered deterministically (X16)',
      async run() {
        const zeros = await oneBookIn('Leading Zeros');
        const first = await partRelPaths(zeros.id);
        equal(first.length, 3, 'part count');
        await ensureScan({ force: true });
        const again = await oneBookIn('Leading Zeros');
        equal((await partRelPaths(again.id)).join(','), first.join(','), 'order across rescans');
        return first.map((p) => p.split('/').pop()).join(',');
      },
    },
    {
      id: 'MX-16',
      name: 'multi-file book with chapters inside each part (X17)',
      async run() {
        const perFile = await oneBookIn('Chapters Per File');
        equal((await partNames(perFile.id)).length, 3, 'part count');
        equal(perFile.chapters.length, 9, 'embedded chapters from all three parts');
        check(!perFile.chaptersFromParts, 'should use embedded chapters, not one per file');
        // Chapters from later parts must be offset onto the whole-book timeline.
        const starts = perFile.chapters.map((c) => c.startSec);
        equal([...starts].sort((a, b) => a - b).join(','), starts.join(','), 'chapter order');
        check(starts[8] > starts[0], 'later chapters are not offset by part start');
        return '9 chapters across 3 parts';
      },
    },
    {
      id: 'MX-17',
      name: 'intro and outro numbering (X18)',
      async run() {
        const intro = await oneBookIn('Intro Outro');
        const names = await partNames(intro.id);
        equal(names.length, 12, 'part count');
        equal(names[0], '00 - Intro.mp3', 'first part');
        equal(names[11], '99 - Credits.mp3', 'last part');
        return '00, 01..10, 99';
      },
    },
    {
      id: 'MX-18',
      name: 'dots as spaces and junk in the folder name (X19)',
      async run() {
        const dotted = await oneBookIn('Spaces and Dots/Book.Name.2019.MP3.64kbps');
        equal((await partNames(dotted.id)).length, 8, 'part count');
        check(
          !/64kbps/i.test(dotted.title) && !/\bMP3\b/i.test(dotted.title),
          `release junk left in the title: "${dotted.title}"`,
        );
        return `title "${dotted.title}"`;
      },
    },
    {
      id: 'MX-19',
      name: 'very long paths (X20)',
      async run() {
        const found = await booksInFolder('Very Long');
        check(found.length >= 1, 'the long-named book was not indexed');
        return `${found.length} book indexed`;
      },
    },
  ],
};

// =====================================================================  A2

const a2Identity: Suite = {
  id: 'A2',
  name: 'Identity, duplicates and rescans',
  cases: [
    {
      id: 'I-01',
      name: 'an incremental rescan keeps every identity',
      async run() {
        const before = books().map((b) => b.id).sort().join(',');
        await ensureScan();
        const after = books().map((b) => b.id).sort().join(',');
        equal(after, before, 'book ids after an incremental rescan');
        return `${books().length} books, ids unchanged`;
      },
    },
    {
      id: 'I-08',
      name: 'duplicate books stay separate',
      async run() {
        const a = await oneBookIn('Dup A');
        const b = await oneBookIn('Dup B');
        check(a.id !== b.id, 'duplicates share an id');
        return 'two ids, same content';
      },
    },
    {
      id: 'I-11',
      name: 'a full rescan does not duplicate anything',
      async run() {
        const before = books().map((b) => b.id).sort().join(',');
        await ensureScan({ force: true });
        const after = books().map((b) => b.id).sort().join(',');
        equal(after, before, 'book ids after a forced rescan');
        return `${books().length} books, ids unchanged`;
      },
    },
  ],
};

// =====================================================================  A4

const a4CheckOut: Suite = {
  id: 'A4',
  name: 'Check-out lifecycle',
  cases: [
    {
      id: 'C-01',
      name: 'check out a single-file book',
      async run() {
        const book = await oneBookIn('Hyperion - Dan Simmons');
        await checkOutAndSettle(book.id);
        equal(bookById(book.id)!.local.status, 'checked-out', `status (${lastMessage()})`);
        await assertLocalFilesPresent(book.id);
        await assertNoOrphans();
        const names = listNames(appDir(BOOKS_DIR, book.id));
        check(names.every((n) => /^\d{4}\.(m4b|m4a|mp3)$/.test(n)), `local names: ${names.join(',')}`);
        return names.join(',');
      },
    },
    {
      id: 'C-02',
      name: 'check out a multi-part book',
      async run() {
        const book = await oneBookIn('The Long Way (Unabridged) [MP3] 64kbps');
        await checkOutAndSettle(book.id);
        equal(bookById(book.id)!.local.status, 'checked-out', `status (${lastMessage()})`);
        await assertLocalFilesPresent(book.id);
        equal(listNames(appDir(BOOKS_DIR, book.id)).length, 12, 'local file count');
        return '12 parts copied';
      },
    },
    {
      id: 'C-03',
      name: 'check out books with URI-hostile filenames',
      async run() {
        for (const folder of ['Weird #1 %20 &= [v2]', 'Война и мир - Лев Толстой']) {
          const book = await oneBookIn(folder);
          await checkOutAndSettle(book.id);
          equal(bookById(book.id)!.local.status, 'checked-out', `${folder} (${lastMessage()})`);
          await assertLocalFilesPresent(book.id);
        }
        return 'both copied';
      },
    },
    {
      id: 'C-11',
      name: 'checking out an already checked-out book changes nothing',
      async run() {
        const book = await oneBookIn('Hyperion - Dan Simmons');
        const before = listNames(appDir(BOOKS_DIR, book.id)).join(',');
        const outs = bookById(book.id)!.checkouts.length;
        library().checkOut(book.id);
        await sleep(600);
        equal(listNames(appDir(BOOKS_DIR, book.id)).join(','), before, 'local files');
        equal(bookById(book.id)!.checkouts.length, outs, 'checkout history entries');
        return 'no-op';
      },
    },
    {
      id: 'C-14',
      name: 'a DRM book is refused',
      async run() {
        const drm = await oneBookIn('DRM');
        library().dismissSlip();
        library().checkOut(drm.id);
        await sleep(600);
        equal(bookById(drm.id)!.local.status, 'on-shelf', 'status');
        equal(listNames(appDir(BOOKS_DIR, drm.id)).length, 0, 'files copied');
        return `refused: "${lastMessage()}"`;
      },
    },
    {
      id: 'C-17',
      name: 'local filenames are generated and keep the source extension',
      async run() {
        let checked = 0;
        for (const book of books()) {
          if (book.local.status !== 'checked-out') continue;
          const names = listNames(appDir(BOOKS_DIR, book.id));
          for (const name of names) {
            check(/^\d{4}\.(m4b|m4a|mp3)$/.test(name), `bad local name "${name}" in ${book.title}`);
          }
          checked += names.length;
        }
        check(checked > 0, 'nothing was checked out to inspect');
        return `${checked} local files`;
      },
    },
  ],
};

// =====================================================================  A7

const a7Returning: Suite = {
  id: 'A7',
  name: 'Returning',
  cases: [
    {
      id: 'R-01',
      name: 'returning deletes the files and keeps the progress',
      async run() {
        const book = await oneBookIn('Hyperion - Dan Simmons');
        if (bookById(book.id)!.local.status !== 'checked-out') {
          await checkOutAndSettle(book.id);
        }
        library().recordProgress(book.id, 60);
        await library().refresh();
        const parts = await loadParts(book.id);

        library().returnBook(book.id, { confirmed: true });
        await waitFor('the return', () => bookById(book.id)?.local.status === 'on-shelf');
        await assertLocalFilesGone(book.id, parts);
        await assertNoOrphans();
        near(bookById(book.id)!.progressSec, 60, 2, 'saved position after a return');
        return 'files gone, position kept';
      },
    },
  ],
};

// =====================================================================  A9

const a9Startup: Suite = {
  id: 'A9',
  name: 'Startup reconciliation',
  cases: [
    {
      id: 'ST-01',
      name: 'leftover staging folders are deleted on startup',
      async run() {
        const junk = ensureDir(appDir(BOOKS_TMP_DIR, 'junk'));
        check(junk.exists, 'could not create the staging folder');
        clearTempCopies();
        equal(listNames(appDir(BOOKS_TMP_DIR)).length, 0, 'books-tmp/ after startup');
        return 'staging cleared';
      },
    },
    {
      id: 'ST-04',
      name: 'orphan folders in books/ are removed',
      async run() {
        ensureDir(appDir(BOOKS_DIR, 'not-a-book'));
        await reconcileLocalCopies();
        await library().refresh();
        await assertNoOrphans();
        return 'orphan removed';
      },
    },
  ],
};


// =====================================================================  A3

const a3Missing: Suite = {
  id: 'A3',
  name: 'Missing files and drive reachability',
  cases: [
    {
      id: 'M-01',
      name: 'a deleted book folder is marked missing by the next scan',
      async run(ctx) {
        const book = await oneBookIn('No Art');
        const noArt = parkFolder(ctx.rootPath, 'No Art');
        check(noArt.park(), 'could not park the book folder');
        try {
          await ensureScan();
          const after = bookById(book.id);
          check(!!after, 'the book row was deleted rather than flagged');
          check(!!after!.missingFromDrive, 'the book was not marked missing');
          return 'flagged, still listed';
        } finally {
          noArt.restore();
        }
      },
    },
    {
      id: 'I-07',
      name: 'a missing book comes back when its folder returns',
      async run() {
        await ensureScan();
        const book = await oneBookIn('No Art');
        check(!book.missingFromDrive, 'the book is still flagged missing after returning');
        return 'no longer missing, same id';
      },
    },
    {
      id: 'M-02',
      name: 'forgetting missing books removes them and their progress',
      async run(ctx) {
        const book = await oneBookIn('No Art');
        library().recordProgress(book.id, 42);
        const noArt = parkFolder(ctx.rootPath, 'No Art');
        check(noArt.park(), 'could not park the book folder');
        try {
          await ensureScan();
          check(!!bookById(book.id)?.missingFromDrive, 'setup: the book should be missing');
          const forgotten = await forgetMissingBooks();
          await library().refresh();
          check(forgotten.includes(book.id), 'the missing book was not forgotten');
          check(!bookById(book.id), 'the row survived being forgotten');
          return `${forgotten.length} forgotten`;
        } finally {
          noArt.restore();
          await ensureScan();
        }
      },
    },
    {
      id: 'M-03',
      name: 'an unreachable root shuts the drawer without losing the library',
      async run(ctx) {
        const before = books().length;
        check(setRootReachable(ctx.rootPath, false), 'could not park the root');
        try {
          const connected = await library().checkDrive();
          equal(connected, false, 'drive reported as connected');
          equal(books().length, before, 'books disappeared from the library');
          const missing = books().filter((b) => b.missingFromDrive).length;
          equal(missing, 0, 'an unreachable root must not mark anything missing');
          return `${before} books still listed, drawer shut`;
        } finally {
          setRootReachable(ctx.rootPath, true);
          await library().checkDrive();
        }
      },
    },
    {
      id: 'M-04',
      name: 'the root returning re-syncs the index on its own',
      async run(ctx) {
        check(setRootReachable(ctx.rootPath, false), 'could not park the root');
        await library().checkDrive();
        scanner().forgetSync();
        setRootReachable(ctx.rootPath, true);

        const connected = await library().checkDrive();
        equal(connected, true, 'drive did not come back');
        // The screen-level watcher reacts to the state change; give it a tick,
        // then make sure whatever it started finishes.
        await sleep(600);
        await waitFor('the re-sync to finish', () => !scanner().running, 300000);
        await library().refresh();
        equal(books().filter((b) => b.missingFromDrive).length, 0, 'books left marked missing');
        return 'drawer open, index re-synced';
      },
    },
    {
      id: 'M-05',
      name: 'a root that vanishes mid-scan fails without losing books',
      async run(ctx) {
        const before = books().length;
        const running = scanner().rescan({ force: true });
        await sleep(400);
        setRootReachable(ctx.rootPath, false);
        await running;
        try {
          await library().refresh();
          // The scan may have finished before the move landed; either way it
          // must not have emptied the library or flagged everything missing.
          check(books().length >= before - 1, `book count fell from ${before} to ${books().length}`);
          return `${books().length} books survived`;
        } finally {
          setRootReachable(ctx.rootPath, true);
          await library().checkDrive();
          await ensureScan({ force: true });
        }
      },
    },
    {
      id: 'M-06',
      name: 'unmounting the SD volume',
      skip: 'the test root is app-internal storage, so there is no volume to unmount',
      run: async () => {},
    },
    {
      id: 'M-07',
      name: 'the folder permission being revoked',
      skip: 'a file:// root carries no SAF permission to revoke; needs the picker',
      run: async () => {},
    },
  ],
};

// =====================================================================  A5

const a5Budget: Suite = {
  id: 'A5',
  name: 'Budget and free space',
  cases: [
    {
      id: 'B-01',
      name: 'a book over the budget is refused',
      async run() {
        const big = await oneBookIn('Big');
        const previous = library().budgetBytes;
        try {
          library().setBudgetBytes(10 * 1024 * 1024);
          library().dismissSlip();
          library().checkOut(big.id);
          await sleep(800);
          equal(bookById(big.id)!.local.status, 'on-shelf', 'status');
          check(/needs|left/i.test(lastMessage()), `message was "${lastMessage()}"`);
          equal(listNames(appDir(BOOKS_DIR, big.id)).length, 0, 'files copied');
          return `refused: "${lastMessage()}"`;
        } finally {
          library().setBudgetBytes(previous);
        }
      },
    },
    {
      id: 'B-02',
      name: 'a book that exactly fits the budget is allowed',
      async run() {
        const previous = library().budgetBytes;
        try {
          const book = await oneBookIn('Embedded Only');
          const used = books().reduce(
            (n, b) => (b.local.status === 'checked-out' ? n + b.sizeBytes : n),
            0,
          );
          library().setBudgetBytes(used + book.sizeBytes);
          await checkOutAndSettle(book.id);
          equal(bookById(book.id)!.local.status, 'checked-out', `status (${lastMessage()})`);

          // Nothing more fits now.
          const next = await oneBookIn('Natural Sort');
          library().dismissSlip();
          library().checkOut(next.id);
          await sleep(800);
          equal(bookById(next.id)!.local.status, 'on-shelf', 'a second book fitted anyway');
          return 'exact fit allowed, the next one refused';
        } finally {
          library().setBudgetBytes(previous);
        }
      },
    },
    {
      id: 'B-03',
      name: 'lowering the budget below what is already on the phone keeps the books',
      async run() {
        const previous = library().budgetBytes;
        try {
          const out = books().filter((b) => b.local.status === 'checked-out');
          check(out.length > 0, 'nothing is checked out to test with');
          // Half of what is already on the phone, so the budget is genuinely
          // below current usage. A fixed 1 MB was not: it happened to leave
          // 61 KB of headroom, the next book was 55 KB, and it fitted — the
          // app was right and the test was wrong.
          const used = out.reduce((n, b) => n + b.sizeBytes, 0);
          library().setBudgetBytes(Math.floor(used / 2));
          await library().refresh();
          for (const book of out) {
            equal(bookById(book.id)!.local.status, 'checked-out', `${book.title} was evicted`);
            await assertLocalFilesPresent(book.id);
          }
          const next = await oneBookIn('Natural Sort');
          library().dismissSlip();
          library().checkOut(next.id);
          await sleep(800);
          const committed = books().reduce(
            (n, b) => (occupiesBudget(b) || b.local.status === 'on-hold' ? n + b.sizeBytes : n),
            0,
          );
          equal(
            bookById(next.id)!.local.status,
            'on-shelf',
            `a new check-out was allowed (budget ${library().budgetBytes}, committed ` +
              `${committed}, wanted ${next.sizeBytes}, said "${lastMessage()}")`,
          );
          return `${out.length} kept, new check-outs refused`;
        } finally {
          library().setBudgetBytes(previous);
        }
      },
    },
    {
      id: 'B-04',
      name: 'the 1 GB free-space floor',
      skip: 'needs disk-fill fault injection, which is not built yet',
      run: async () => {},
    },
    {
      id: 'B-06',
      name: 'the disk filling during a copy',
      skip: 'needs disk-fill fault injection, which is not built yet',
      run: async () => {},
    },
    {
      id: 'B-07',
      name: 'the budget is persisted',
      async run() {
        const previous = library().budgetBytes;
        try {
          const target = 2 * 1024 * 1024 * 1024;
          library().setBudgetBytes(target);
          await sleep(300);
          const stored = await getSetting(SETTING_KEYS.budgetBytes);
          equal(Number(stored), target, 'stored budget');
          return '2 GB written to settings';
        } finally {
          library().setBudgetBytes(previous);
        }
      },
    },
  ],
};

// =====================================================================  A6

const a6Holds: Suite = {
  id: 'A6',
  name: 'Holds',
  cases: [
    {
      id: 'H-01',
      name: 'checking out with the drawer shut places a hold',
      async run(ctx) {
        const book = await oneBookIn('Natural Sort');
        if (bookById(book.id)!.local.status === 'checked-out') {
          library().returnBook(book.id, { confirmed: true });
          await waitFor('the return', () => bookById(book.id)?.local.status === 'on-shelf');
        }
        check(setRootReachable(ctx.rootPath, false), 'could not park the root');
        const connected = await library().checkDrive();
        equal(connected, false, 'the drive still reads as connected after parking the root');

        library().checkOut(book.id);
        await waitFor(
          `the hold (status ${bookById(book.id)?.local.status}, said "${lastMessage()}")`,
          () => bookById(book.id)?.local.status === 'on-hold',
          20000,
        );
        equal(listNames(appDir(BOOKS_DIR, book.id)).length, 0, 'files were copied anyway');
        return `on hold: "${lastMessage()}"`;
      },
    },
    {
      id: 'H-06',
      name: 'a hold is recorded in the database, so it survives a restart',
      async run() {
        const held = books().filter((b) => b.local.status === 'on-hold');
        check(held.length > 0, 'nothing is on hold');
        const rows = await loadDevBooks();
        for (const book of held) {
          const row = rows.find((r) => r.id === book.id);
          equal(row?.local_status, 'on-hold', `${book.title} in the database`);
        }
        return `${held.length} hold(s) persisted`;
      },
    },
    {
      id: 'H-02',
      name: 'holds are copied one at a time when the drawer opens',
      async run(ctx) {
        const held = books().filter((b) => b.local.status === 'on-hold');
        check(held.length > 0, 'nothing is on hold to flush');
        setRootReachable(ctx.rootPath, true);
        scanner().forgetSync();
        await library().checkDrive();

        await waitFor(
          'the holds to clear',
          () => books().every((b) => b.local.status !== 'on-hold'),
          120000,
        );
        await waitFor(
          'the copies to finish',
          () => books().every((b) => b.local.status !== 'copying'),
          180000,
        );
        for (const book of held) {
          equal(
            bookById(book.id)!.local.status,
            'checked-out',
            `${book.title} after the flush (budget ${library().budgetBytes}, said "${lastMessage()}")`,
          );
        }
        return `${held.length} hold(s) checked out`;
      },
    },
    {
      id: 'H-05',
      name: 'a hold can be cancelled',
      async run(ctx) {
        const book = await oneBookIn('Natural Sort');
        if (bookById(book.id)!.local.status === 'checked-out') {
          library().returnBook(book.id, { confirmed: true });
          await waitFor('the return', () => bookById(book.id)?.local.status === 'on-shelf');
        }
        check(setRootReachable(ctx.rootPath, false), 'could not park the root');
        await library().checkDrive();
        try {
          library().checkOut(book.id);
          await waitFor('the hold', () => bookById(book.id)?.local.status === 'on-hold', 20000);
          library().cancelHold(book.id);
          await waitFor('the cancel', () => bookById(book.id)?.local.status === 'on-shelf', 20000);
          return 'hold cleared';
        } finally {
          setRootReachable(ctx.rootPath, true);
          scanner().forgetSync();
          await library().checkDrive();
          await waitFor('any flush to settle', () => !scanner().running, 300000);
        }
      },
    },
    {
      id: 'H-03',
      name: 'holds count against the budget',
      skip: 'needs several large fixtures held at once; folded into B-01 for now',
      run: async () => {},
    },
    {
      id: 'H-04',
      name: 'a hold on a book that disappeared',
      skip: 'needs the drive to change while holds are flushing',
      run: async () => {},
    },
    {
      id: 'H-07',
      name: 'the drive disappearing during hold processing',
      skip: 'needs mid-copy drive removal, which is not scripted yet',
      run: async () => {},
    },
  ],
};

// =====================================================================  A8

const a8Imports: Suite = {
  id: 'A8',
  name: 'Importing from the phone',
  cases: [
    {
      id: 'IM-01',
      name: 'importing through the system picker',
      skip: 'the system file picker cannot be driven from a script',
      run: async () => {},
    },
    {
      id: 'IM-A',
      name: 'a staged import is indexed and checked out',
      async run() {
        const source = await oneBookIn('Embedded Only');
        const sourceParts = await loadParts(source.id);
        const bookId = `imp-selftest-${Date.now().toString(36)}`;
        const dir = ensureDir(appDir(IMPORTS_DIR, bookId));

        const staged = [];
        for (let i = 0; i < sourceParts.length; i += 1) {
          const part = sourceParts[i];
          const name = `${String(i).padStart(4, '0')}.${part.name.split('.').pop() ?? 'm4b'}`;
          const dest = new File(dir, name);
          // A leftover from an earlier run makes `copy` reject outright.
          if (dest.exists) dest.delete();
          await new File(part.uri).copy(dest);
          staged.push({
            relPath: `${IMPORTS_DIR}/${bookId}/${name}`,
            uri: dest.uri,
            name: part.name,
            sizeBytes: dest.size ?? 0,
          });
        }

        const built = await buildImportedBook(bookId, 'Self Test Import', staged);
        await saveImportedBook(built, staged.map((s) => s.relPath));
        await library().refresh();

        const imported = bookById(bookId);
        check(!!imported, 'the import was not saved');
        equal(imported!.local.status, 'checked-out', 'status');
        check(!!imported!.importedFromPhone, 'not flagged as imported from the phone');
        check(!!imported!.onlyCopyOnPhone, 'not flagged as the only copy');
        return `${staged.length} part(s) staged and indexed`;
      },
    },
    {
      id: 'IM-B',
      name: 'an imported book survives reconciliation',
      async run() {
        const imported = books().find((b) => b.importedFromPhone);
        check(!!imported, 'no imported book to test with');
        await reconcileLocalCopies();
        await library().refresh();
        const after = bookById(imported!.id);
        check(!!after, 'reconciliation deleted the import');
        equal(after!.local.status, 'checked-out', 'status after reconciliation');
        return 'still checked out';
      },
    },
    {
      id: 'IM-C',
      name: 'a pending import is offered to the drive once it is reachable',
      async run() {
        await library().checkDrive();
        const pending = library().pendingDriveImports;
        check(pending.length > 0, 'no import was offered for the drive');
        return `${pending.length} offered`;
      },
    },
    {
      id: 'IM-D',
      name: 'returning the only copy of an import removes it entirely',
      async run() {
        const imported = books().find((b) => b.importedFromPhone);
        check(!!imported, 'no imported book to test with');
        const id = imported!.id;

        // Without confirmation it must do nothing: this is the only copy.
        library().returnBook(id, {});
        await sleep(400);
        check(!!bookById(id), 'the import was deleted without asking');
        check(!!library().confirm, 'no confirmation was requested');

        library().returnBook(id, { confirmed: true });
        await waitFor('the removal', () => !bookById(id), 20000);
        // Reload and check again: dropping it from the list in memory is not
        // the same as deleting the row, and only the second one lasts.
        await sleep(600);
        await library().refresh();
        check(!bookById(id), 'the row came back after a reload');
        return 'confirmed, removed, and gone after a reload';
      },
    },
  ],
};


// ====================================================================  A10

/** Opens a book in the player, checking it out first if it is not here yet. */
async function openForPlayback(folder: string) {
  const book = await oneBookIn(folder);
  if (bookById(book.id)!.local.status !== 'checked-out') {
    await checkOutAndSettle(book.id);
    check(
      bookById(book.id)!.local.status === 'checked-out',
      `could not check out ${folder}: ${lastMessage()}`,
    );
  }
  await player().close();
  await player().open(book.id);
  check(!player().error, `player refused the book: ${player().error}`);
  return bookById(book.id)!;
}

const a10Playback: Suite = {
  id: 'A10',
  name: 'Playback',
  cases: [
    {
      id: 'P-01',
      name: 'a book that is not on the phone will not play',
      async run() {
        const shelf = books().find(
          (b) => b.local.status === 'on-shelf' && !b.missingFromDrive && b.durationSec > 0,
        );
        check(!!shelf, 'no on-shelf book to test with');
        await player().close();
        await player().open(shelf!.id);
        check(!!player().error, 'the player accepted a book that is not on the phone');
        check(/not on your phone/i.test(player().error!), `error was "${player().error}"`);
        return `refused: "${player().error}"`;
      },
    },
    {
      id: 'P-03',
      name: 'seeking lands in the right part of a merged disc set',
      async run() {
        // X1 is ten 4-second parts spread over two disc folders, so a seek
        // past 20 seconds has to cross both a part and a folder boundary.
        const dune = await openForPlayback('Dune');
        check(dune.files.length === 10, `expected 10 parts, got ${dune.files.length}`);
        const target = Math.min(25, dune.durationSec - 2);
        player().seekTo(target);
        await sleep(1200);
        near(player().positionSec, target, 2.5, 'whole-book position after a seek');
        return `seeked to ${target.toFixed(1)}s of ${dune.durationSec.toFixed(1)}s`;
      },
    },
    {
      id: 'P-02',
      name: 'the timeline runs continuously across a part boundary',
      async run() {
        const dune = await openForPlayback('Dune');
        const partSec = dune.durationSec / dune.files.length;
        // Start shortly before the end of the second part and let it roll.
        const start = partSec * 2 - 1.2;
        player().seekTo(start);
        await sleep(900);
        player().togglePlay();
        await sleep(4000);
        const reached = player().positionSec;
        player().togglePlay();
        check(
          reached > partSec * 2 + 0.3,
          `position ${reached.toFixed(1)}s did not pass the boundary at ${(partSec * 2).toFixed(1)}s`,
        );
        return `crossed ${(partSec * 2).toFixed(1)}s, reached ${reached.toFixed(1)}s`;
      },
    },
    {
      id: 'P-04',
      name: 'chapter navigation steps and restarts correctly',
      async run() {
        const hyperion = await openForPlayback('Hyperion - Dan Simmons');
        equal(hyperion.chapters.length, 5, 'chapter count');
        const third = hyperion.chapters[2].startSec;

        // Well into chapter 3: back should restart chapter 3, not leave it.
        // Past the 3-second threshold, below which "back" steps to the
        // previous chapter instead — 2.5s put this on the wrong side of it.
        player().seekTo(third + 4);
        await sleep(700);
        player().skipChapter(-1);
        await sleep(700);
        near(player().positionSec, third, 1, 'restart of the current chapter');

        // Immediately again: now it should step back to chapter 2.
        player().skipChapter(-1);
        await sleep(700);
        near(player().positionSec, hyperion.chapters[1].startSec, 1, 'previous chapter');

        player().skipChapter(1);
        await sleep(700);
        near(player().positionSec, third, 1, 'next chapter');
        return 'restart, back, forward all land on chapter starts';
      },
    },
    {
      id: 'P-05',
      name: 'the speed control cycles through every speed and sticks',
      async run() {
        await openForPlayback('Hyperion - Dan Simmons');
        const seen: number[] = [];
        for (let i = 0; i < SPEEDS.length; i += 1) {
          seen.push(SPEEDS[player().speedIndex]);
          player().cycleSpeed();
          await sleep(120);
        }
        equal(seen.join(','), SPEEDS.join(','), 'speeds cycled');
        equal(SPEEDS[player().speedIndex], SPEEDS[0], 'wraps back to the start');
        return SPEEDS.join(', ');
      },
    },
    {
      id: 'P-08',
      name: 'the position is written to the database',
      async run() {
        const hyperion = await openForPlayback('Hyperion - Dan Simmons');
        player().seekTo(12);
        await sleep(800);
        player().savePosition();
        await sleep(400);
        await library().refresh();
        near(bookById(hyperion.id)!.progressSec, 12, 2, 'saved position');
        return `${bookById(hyperion.id)!.progressSec.toFixed(1)}s persisted`;
      },
    },
    {
      id: 'P-16',
      name: 'playback is unaffected by the drive going away',
      async run(ctx) {
        await openForPlayback('Hyperion - Dan Simmons');
        player().seekTo(4);
        await sleep(600);
        check(setRootReachable(ctx.rootPath, false), 'could not park the root');
        try {
          await library().checkDrive();
          player().togglePlay();
          await sleep(2500);
          player().togglePlay();
          check(player().positionSec > 4.3, `position stuck at ${player().positionSec.toFixed(1)}s`);
          check(!player().error, `player errored: ${player().error}`);
          return `played on from the local copy to ${player().positionSec.toFixed(1)}s`;
        } finally {
          setRootReachable(ctx.rootPath, true);
          scanner().forgetSync();
          await library().checkDrive();
          await waitFor('any re-sync to finish', () => !scanner().running, 300000);
        }
      },
    },
    {
      id: 'P-06',
      name: 'the sleep timer',
      skip: 'needs the timer durations to be overridable; no test hook yet',
      run: async () => {},
    },
    {
      id: 'P-07',
      name: 'resume rewind after a long pause',
      skip: 'needs an injectable clock for the paused duration; no test hook yet',
      run: async () => {},
    },
    {
      id: 'P-09',
      name: 'phone call interruption',
      skip: 'driven by adb emu gsm call, outside this harness',
      run: async () => {},
    },
    {
      id: 'P-10',
      name: 'media buttons',
      skip: 'driven by adb input keyevent, outside this harness',
      run: async () => {},
    },
    {
      id: 'P-11',
      name: 'screen off and background playback',
      skip: 'driven by adb input keyevent, outside this harness',
      run: async () => {},
    },
    {
      id: 'P-12',
      name: 'playback under doze',
      skip: 'driven by adb dumpsys deviceidle, outside this harness',
      run: async () => {},
    },
    {
      id: 'P-13',
      name: 'playback under memory pressure',
      skip: 'driven by adb am send-trim-memory, outside this harness',
      run: async () => {},
    },
    {
      id: 'P-14',
      name: 'lock-screen metadata',
      skip: 'read with adb dumpsys media_session; the harness cannot see it',
      run: async () => {},
    },
    {
      id: 'P-15',
      name: 'the mini player across screens',
      skip: 'needs UI navigation and screenshots, outside this harness',
      run: async () => {},
    },
  ],
};

// ====================================================================  A11

const a11Ui: Suite = {
  id: 'A11',
  name: 'UI resilience',
  cases: [
    {
      id: 'U-01',
      name: 'large text layout',
      skip: 'needs adb font_scale plus screenshots; no assertion the harness can make',
      run: async () => {},
    },
    {
      id: 'U-02',
      name: 'rotation',
      skip: 'needs adb user_rotation plus screenshots, outside this harness',
      run: async () => {},
    },
    {
      id: 'U-04',
      name: 'accessibility labels',
      skip: 'needs adb uiautomator dump, outside this harness',
      run: async () => {},
    },
    {
      id: 'U-05',
      name: 'the library survives every sort with awkward data',
      async run() {
        // Not in the plan, but this is the one UI-adjacent thing the harness
        // can genuinely assert: the by-author sort used to crash outright on a
        // book with no readable author, and the fixture set has several.
        const all = books();
        check(all.length > 0, 'no books');
        for (const sort of ['length', 'author', 'color', 'dust'] as const) {
          const shelves = buildShelves(all, sort);
          const placed = shelves.reduce((n, s) => n + s.books.length, 0);
          equal(placed, all.length, `${sort} lost or duplicated books`);
        }
        return `${all.length} books survive all four sorts`;
      },
    },
  ],
};

// =====================================================================  A0

const a0Blocked: Suite = {
  id: 'A0',
  name: 'Blocked until built',
  cases: [
    { id: 'U-03', name: 'search', skip: 'search is not built yet', run: async () => {} },
    {
      id: 'I-08b',
      name: 'duplicate note on the Book screen',
      skip: 'the "Same book also in" note is not built yet',
      run: async () => {},
    },
    {
      id: 'S-13b',
      name: 'DRM stamp on the cover',
      skip: 'the cover stamp is not built yet',
      run: async () => {},
    },
  ],
};

export const SUITES: Suite[] = [
  a1Scanning,
  a1bMessy,
  a2Identity,
  a3Missing,
  a4CheckOut,
  a5Budget,
  a6Holds,
  a7Returning,
  a8Imports,
  a9Startup,
  a10Playback,
  a11Ui,
  a0Blocked,
];

export function suitesFor(selector: string | undefined): Suite[] {
  if (!selector || selector === 'all') return SUITES;
  const wanted = selector.split(',').map((s) => s.trim().toLowerCase());
  return SUITES.filter((s) => wanted.includes(s.id.toLowerCase()));
}
