/**
 * The scaffolding the on-device test suites are written against.
 *
 * Lives outside `src/app` so Expo Router does not treat it as a route. The
 * screen at `app/dev/selftest.tsx` is only a runner and a log view; everything
 * a test actually does is here or in `suites.ts`.
 *
 * Tests call app internals directly and assert on the database and the
 * filesystem rather than on pixels. That is deliberate: the bugs worth catching
 * in this app are state-machine bugs, and a test that drives the UI would be
 * slower, flakier, and blind to exactly the things that have gone wrong.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { useLibrary } from '@/store/library';
import { useScan } from '@/store/scan';
import { loadParts } from '@/db/books';
import { BOOKS_DIR, BOOKS_TMP_DIR, localUriFor } from '@/lib/files/copy';
import { IMPORTS_DIR } from '@/lib/files/import';
import type { Book } from '@/data/types';

export type CaseResult = {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  ms: number;
};

export type TestCase = {
  id: string;
  name: string;
  /** Set to explain why a case cannot run yet; it is reported as skipped. */
  skip?: string;
  /** Returns a short detail line on success, or throws to fail. */
  run: (ctx: Context) => Promise<string | void>;
};

export type Suite = {
  id: string;
  name: string;
  cases: TestCase[];
};

/** What the generator recorded about the fixture library it built. */
export type Manifest = {
  bigMb: number;
  expectedBookCount: number;
  expectedBooks: { id: string; folder: string; parts: number; note: string }[];
  foldersWithNoBook: string[];
  unsupportedFileCount: number;
};

export type Context = {
  /** Absolute path of the library root, without the `file://` scheme. */
  rootPath: string;
  /** Parsed `manifest.json` from the folder above the root, when present. */
  manifest: Manifest | null;
  log: (line: string) => void;
};

// ---------------------------------------------------------------- assertions

/** How long one case may run before it is reported as a failure. */
const CASE_TIMEOUT_MS = 180000;

export class Failure extends Error {}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

export function equal<T>(actual: T, expected: T, what: string) {
  if (actual !== expected) {
    throw new Failure(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function near(actual: number, expected: number, tolerance: number, what: string) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Failure(`${what}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

// ------------------------------------------------------------------- waiting

export async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs = 60000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(120);
  }
  throw new Failure(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** Like `waitFor`, but a timeout is an acceptable outcome. */
export async function settle(predicate: () => boolean, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(120);
  }
  return false;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------- store access

export const library = () => useLibrary.getState();
export const scanner = () => useScan.getState();

export function books(): Book[] {
  return library().books;
}

export function bookById(id: string): Book | undefined {
  return books().find((b) => b.id === id);
}

/**
 * The folders a book's parts came from, relative to the library root.
 *
 * `rel_path` is recorded per part, so this is exact rather than a guess made by
 * picking apart a URI. A book assembled from disc subfolders reports both of
 * them, which is what the disc-merging tests need to see.
 */
export async function foldersOf(bookId: string): Promise<string[]> {
  const parts = await loadParts(bookId);
  const set = new Set(
    parts.map((p) => {
      const slash = p.rel_path.lastIndexOf('/');
      return slash < 0 ? '' : p.rel_path.slice(0, slash);
    }),
  );
  return [...set].sort();
}

/** Every book with at least one part under `folderRelPath`, discs included. */
export async function booksInFolder(folderRelPath: string): Promise<Book[]> {
  const found: Book[] = [];
  for (const book of books()) {
    const folders = await foldersOf(book.id);
    const inside = folders.some((f) => f === folderRelPath || f.startsWith(`${folderRelPath}/`));
    if (inside) found.push(book);
  }
  return found;
}

/** The single book in `folderRelPath`, or a failure naming what was found. */
export async function oneBookIn(folderRelPath: string): Promise<Book> {
  const found = await booksInFolder(folderRelPath);
  check(
    found.length === 1,
    `expected one book in "${folderRelPath}", found ${found.length}` +
      (found.length ? `: ${found.map((b) => b.title).join(' | ')}` : ''),
  );
  return found[0];
}

/** Waits for any scan already running, then runs one if none was. */
export async function ensureScan(options: { force?: boolean } = {}) {
  await sleep(250);
  if (!scanner().running) await scanner().rescan(options);
  await waitFor('the scan to finish', () => !scanner().running, 300000);
  await library().refresh();
}

/**
 * Starts a check-out and waits for it to reach a settled state.
 *
 * `checkOut` proves the drive is reachable before it marks anything as copying,
 * so waiting only for "not copying" returns immediately and tests the state
 * before any work has begun.
 */
export async function checkOutAndSettle(id: string, timeoutMs = 180000) {
  useLibrary.setState({ slip: null });
  library().checkOut(id);
  await settle(() => bookById(id)?.local.status === 'copying' || !!library().slip, 15000);
  await waitFor('the copy to settle', () => bookById(id)?.local.status !== 'copying', timeoutMs);
  // The outcome message is written after the copy returns.
  await sleep(300);
}

export const lastMessage = () => library().slip?.text ?? '';

// -------------------------------------------------------------- filesystem

export function appDir(...parts: string[]): Directory {
  return new Directory(Paths.document, ...parts);
}

/** Creates a directory, tolerating one that is already there. */
export function ensureDir(dir: Directory) {
  try {
    if (!dir.exists) dir.create({ intermediates: true });
  } catch {
    // Already created, or created concurrently.
  }
  return dir;
}

export function listNames(dir: Directory): string[] {
  try {
    if (!dir.exists) return [];
    return dir.list().map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Nothing staged, and nothing in `books/` that no checked-out book claims. */
export async function assertNoOrphans() {
  const tmp = appDir(BOOKS_TMP_DIR);
  const staged = listNames(tmp);
  check(staged.length === 0, `books-tmp/ is not empty: ${staged.join(', ')}`);

  const claimed = new Set<string>();
  for (const book of books()) {
    if (book.local.status === 'checked-out') claimed.add(book.id);
  }
  const onDisk = listNames(appDir(BOOKS_DIR));
  const orphans = onDisk.filter((name) => !claimed.has(name));
  // Named, not just listed: an id on its own says nothing about how it got
  // there, and the status is usually the whole explanation.
  const described = orphans.map((id) => {
    const book = books().find((b) => b.id === id);
    return book ? `${id} (${book.title}, ${book.local.status})` : `${id} (no such book)`;
  });
  check(orphans.length === 0, `orphan folders in books/: ${described.join(', ')}`);
}

/** Every recorded local path for a book resolves to a file that exists. */
export async function assertLocalFilesPresent(id: string) {
  const parts = await loadParts(id);
  check(parts.length > 0, 'book has no parts recorded');
  const missing = parts.filter((p) => !p.local_uri || !localUriFor(p.local_uri));
  check(missing.length === 0, `${missing.length} of ${parts.length} local files missing`);
}

export async function assertLocalFilesGone(id: string, recorded: { local_uri: string | null }[]) {
  const stillThere = recorded.filter((p) => p.local_uri && localUriFor(p.local_uri));
  check(stillThere.length === 0, `${stillThere.length} local file(s) survived`);
}

/** Removes everything the app has written, leaving the picked root alone. */
export function wipeAppData() {
  for (const name of [BOOKS_DIR, BOOKS_TMP_DIR, IMPORTS_DIR]) {
    try {
      const dir = appDir(name);
      if (dir.exists) dir.delete();
    } catch {
      // Nothing there.
    }
  }
}

/**
 * Moves one book folder out of the library and back again.
 *
 * Parked *outside* the root, not renamed inside it: a folder renamed in place
 * is still in the library, so the next scan indexes it as a new book and the
 * old one is only half gone. That made "nothing should be marked missing"
 * checks fail for a reason that had nothing to do with the app.
 */
/**
 * Deletes a directory if it exists and holds nothing.
 *
 * `move` leaves the empty source directory behind, so without this the next
 * move is refused by a destination that "already exists" while containing
 * nothing. That is what made parking the library root work once and then
 * quietly stop working for every suite afterwards.
 */
function removeIfEmpty(dir: Directory) {
  try {
    if (dir.exists && dir.list().length === 0) dir.delete();
  } catch {
    // Not empty, or already gone.
  }
}

/**
 * Renames a folder within its parent.
 *
 * Built from `new Directory(parent, name)` rather than a hand-assembled URI
 * string: the names here contain spaces, and only the two-argument form
 * percent-encodes them. A raw space in a `file://` URI is rejected outright by
 * the strict parser underneath `expo-file-system`.
 */
function moveFolder(parent: Directory, from: string, to: string): boolean {
  const source = new Directory(parent, from);
  const target = new Directory(parent, to);
  removeIfEmpty(target);
  try {
    if (source.exists && !target.exists) {
      source.move(target);
      removeIfEmpty(source);
    }
  } catch {
    // Verified by the caller.
  }
  return new Directory(parent, to).exists;
}

function splitPath(rootPath: string): { parent: Directory; name: string } {
  const bare = rootPath.replace(/\/$/, '');
  const cut = bare.lastIndexOf('/');
  return {
    parent: new Directory(`file://${bare.slice(0, cut)}/`),
    name: bare.slice(cut + 1),
  };
}

/**
 * Moves one book folder out of the library and back again.
 *
 * Parked outside the root rather than renamed inside it: a folder renamed in
 * place is still in the library, so the next scan indexes it as a new book and
 * the old one is only half gone.
 */
export function parkFolder(rootPath: string, folderName: string) {
  const { parent: libraryParent } = splitPath(rootPath);
  const root = new Directory(`file://${rootPath.replace(/\/$/, '')}/`);
  const parkedName = `parked-${folderName}`;
  return {
    park(): boolean {
      // Out of the library root and into its parent, so a scan cannot see it.
      const source = new Directory(root, folderName);
      const target = new Directory(libraryParent, parkedName);
      removeIfEmpty(target);
      try {
        if (source.exists && !target.exists) {
          source.move(target);
          removeIfEmpty(source);
        }
      } catch {
        // Verified below.
      }
      return !new Directory(root, folderName).exists;
    },
    restore(): boolean {
      const source = new Directory(libraryParent, parkedName);
      const target = new Directory(root, folderName);
      removeIfEmpty(target);
      try {
        if (source.exists && !target.exists) {
          source.move(target);
          removeIfEmpty(source);
        }
      } catch {
        // Verified below.
      }
      return new Directory(root, folderName).exists;
    },
  };
}

/**
 * Moves the library root aside and back, to stand in for unplugging the drive.
 *
 * The emulator cannot eject the volume the app is reading from, and a scripted
 * test cannot pull a USB cable — but an unreachable root is exactly what the
 * app sees either way: `isReachable` fails and the drive reads as not connected.
 */
export function setRootReachable(rootPath: string, reachable: boolean): boolean {
  const { parent, name } = splitPath(rootPath);
  const parked = `${name}_off`;
  if (reachable) {
    moveFolder(parent, parked, name);
    return new Directory(parent, name).exists;
  }
  moveFolder(parent, name, parked);
  return !new Directory(parent, name).exists;
}


/** The generator writes `manifest.json` in the folder above the library root. */
/**
 * Moves the library root aside and back, to stand in for unplugging the drive.
 *
 * The emulator cannot eject the volume the app is reading from, and a scripted
 * test cannot pull a USB cable — but an unreachable root is exactly what the
 * app sees either way: `isReachable` fails and the drive reads as not connected.
 */

export async function readManifest(rootPath: string): Promise<Manifest | null> {
  try {
    const parent = rootPath.replace(/\/$/, '').replace(/\/[^/]+$/, '');
    const file = new File(`file://${parent}/manifest.json`);
    if (!file.exists) return null;
    return (await file.json()) as Manifest;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ runner

export async function runSuites(
  suites: Suite[],
  ctx: Context,
  onResult: (r: CaseResult) => void,
): Promise<{ passed: number; failed: number; skipped: number }> {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const suite of suites) {
    // A suite that leaves the library root parked would fail every suite
    // behind it for reasons that have nothing to do with the code under test.
    // One line here is worth more than a `finally` in every case that moves it.
    if (!setRootReachable(ctx.rootPath, true)) {
      ctx.log(`${suite.id}: WARNING — the library root could not be restored`);
    }
    ctx.log(`---- ${suite.id} ${suite.name}`);
    for (const testCase of suite.cases) {
      if (testCase.skip) {
        skipped += 1;
        onResult({ id: testCase.id, name: testCase.name, status: 'skip', detail: testCase.skip, ms: 0 });
        continue;
      }
      const started = Date.now();
      try {
        // A case that hangs must not take the rest of the run with it: the
        // first version of this runner stalled silently on one bad await and
        // reported nothing at all for the suites behind it.
        const detail = await Promise.race([
          testCase.run(ctx),
          sleep(CASE_TIMEOUT_MS).then(() => {
            throw new Failure(`case did not finish within ${CASE_TIMEOUT_MS / 1000}s`);
          }),
        ]);
        passed += 1;
        onResult({
          id: testCase.id,
          name: testCase.name,
          status: 'pass',
          detail: detail || '',
          ms: Date.now() - started,
        });
      } catch (err) {
        failed += 1;
        onResult({
          id: testCase.id,
          name: testCase.name,
          status: 'fail',
          detail: (err as Error)?.message ?? String(err),
          ms: Date.now() - started,
        });
      }
    }
  }
  return { passed, failed, skipped };
}
