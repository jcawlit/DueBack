/**
 * Reading and writing books. The scanner writes through `upsertBook`; screens
 * read through `loadBooks`, which assembles the `Book` shape the UI already
 * uses so nothing downstream had to change when fixtures went away.
 */

import type { Book, Chapter, Checkout, LocalState } from '@/data/types';
import { coverUri } from '@/lib/files/access';
import { fallbackPalette } from '@/lib/library/palette';
import { fingerprintKey } from '@/lib/library/grouping';
import { newUuid } from '@/lib/library/ids';
import { ensureDeviceId, getDb } from './schema';

export type BookRow = {
  id: string;
  folder_rel_path: string;
  raw_folder_name: string;
  title: string;
  author: string | null;
  narrator: string | null;
  title_source: string | null;
  author_source: string | null;
  duration_sec: number;
  size_bytes: number;
  cover_file: string | null;
  cover_source: string | null;
  dominant_color: string | null;
  progress_sec: number;
  finished_at: string | null;
  last_played_at: string | null;
  local_status: string;
  local_path: string | null;
  hold_since: string | null;
  missing: number;
  drm: number;
  warnings: string | null;
  skipped_files: number;
  last_scanned_at: string | null;
  scan_ms: number;
  bytes_read: number;
  read_count: number;
  source_kind: string;
  on_drive: number;
  chapters_from_parts: number;
};

export type PartRow = {
  book_id: string;
  idx: number;
  rel_path: string;
  name: string;
  uri: string;
  size_bytes: number;
  modified_ms: number;
  duration_sec: number;
  start_sec: number;
  track_number: number | null;
  error: string | null;
  local_rel_path: string | null;
};

/** Everything the scanner knows about one book after reading its files. */
export type ScannedBook = {
  /** The book's identity. A uuid, minted once and kept for ever. */
  id: string;
  /** Where it was found, which is how a scan finds this row again. */
  pathKey?: string;
  /** The library it belongs to, so a drive at a new path keeps its books. */
  libraryId?: string | null;
  /** Part sizes in playback order, for recognising a book that has moved. */
  partSizes?: number[];
  /** Proof that a candidate is the same audio. Null until sampled. */
  sampleHash?: string | null;
  sampleVersion?: number;
  folderRelPath: string;
  rawFolderName: string;
  title: string;
  author?: string;
  narrator?: string;
  titleSource: string;
  authorSource: string;
  durationSec: number;
  sizeBytes: number;
  coverFile?: string;
  coverSource?: string;
  dominantColor?: string;
  drm: boolean;
  /** True when chapters are the one-per-part fallback, not real chapters. */
  chaptersFromParts: boolean;
  warnings: string[];
  skippedFiles: number;
  scanMs: number;
  bytesRead: number;
  readCount: number;
  parts: {
    relPath: string;
    name: string;
    uri: string;
    sizeBytes: number;
    modifiedMs: number;
    durationSec: number;
    startSec: number;
    trackNumber?: number;
    error?: string;
  }[];
  chapters: Chapter[];
};

function localStateFrom(row: BookRow): LocalState {
  switch (row.local_status) {
    case 'checked-out':
      return { status: 'checked-out', localPath: row.local_path ?? '' };
    case 'on-hold':
      return { status: 'on-hold', since: row.hold_since ?? new Date().toISOString() };
    case 'copying':
      return { status: 'copying', progress: 0 };
    default:
      return { status: 'on-shelf' };
  }
}

/**
 * Options for a book that did not come from a library scan.
 *
 * An imported book arrives already on the phone, so it is checked out from the
 * moment it exists, and carries `on_drive = 0` until it has been copied across
 * — the state that means the phone holds the only copy.
 */
export type UpsertOptions = {
  sourceKind?: 'library' | 'imported';
  onDrive?: boolean;
  /** Per-part local paths, when the files are already on the phone. */
  localRelPaths?: string[];
};

/**
 * Writes a scanned book, preserving the playback and checkout columns the scan
 * knows nothing about. A rescan must never reset someone's progress.
 */
export async function upsertBook(book: ScannedBook, options: UpsertOptions = {}) {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT INTO books (
         id, folder_rel_path, raw_folder_name, title, author, narrator,
         title_source, author_source, duration_sec, size_bytes,
         cover_file, cover_source, dominant_color,
         missing, drm, warnings, skipped_files, last_scanned_at,
         scan_ms, bytes_read, read_count, chapters_from_parts,
         path_key, library_id, part_sizes, sample_hash, sample_version
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         folder_rel_path = excluded.folder_rel_path,
         raw_folder_name = excluded.raw_folder_name,
         title           = excluded.title,
         author          = excluded.author,
         narrator        = excluded.narrator,
         title_source    = excluded.title_source,
         author_source   = excluded.author_source,
         duration_sec    = excluded.duration_sec,
         size_bytes      = excluded.size_bytes,
         cover_file      = COALESCE(excluded.cover_file, books.cover_file),
         cover_source    = COALESCE(excluded.cover_source, books.cover_source),
         dominant_color  = COALESCE(excluded.dominant_color, books.dominant_color),
         missing         = 0,
         drm             = excluded.drm,
         warnings        = excluded.warnings,
         skipped_files   = excluded.skipped_files,
         last_scanned_at = excluded.last_scanned_at,
         scan_ms         = excluded.scan_ms,
         bytes_read      = excluded.bytes_read,
         read_count      = excluded.read_count,
         chapters_from_parts = excluded.chapters_from_parts,
         path_key        = COALESCE(excluded.path_key, books.path_key),
         library_id      = COALESCE(excluded.library_id, books.library_id),
         part_sizes      = COALESCE(excluded.part_sizes, books.part_sizes),
         -- A scan that did not sample keeps the sample it has: the hash is
         -- what proves a moved book, and dropping it would cost a prompt.
         sample_hash     = COALESCE(excluded.sample_hash, books.sample_hash),
         sample_version  = MAX(excluded.sample_version, books.sample_version)`,
      book.id,
      book.folderRelPath,
      book.rawFolderName,
      book.title,
      book.author ?? null,
      book.narrator ?? null,
      book.titleSource,
      book.authorSource,
      book.durationSec,
      book.sizeBytes,
      book.coverFile ?? null,
      book.coverSource ?? null,
      book.dominantColor ?? null,
      book.drm ? 1 : 0,
      book.warnings.length ? JSON.stringify(book.warnings) : null,
      book.skippedFiles,
      new Date().toISOString(),
      book.scanMs,
      book.bytesRead,
      book.readCount,
      book.chaptersFromParts ? 1 : 0,
      book.pathKey ?? null,
      book.libraryId ?? null,
      book.partSizes ? JSON.stringify(book.partSizes) : null,
      book.sampleHash ?? null,
      book.sampleVersion ?? 0,
    );

    /*
     * Carry the local copy's whereabouts across the rewrite. These rows hold
     * the only record of where a checked-out book's copy lives, and losing it
     * leaves the book checked out with nothing behind it. `npm run kb rescan`.
     *
     * Keyed on `rel_path` so the paths survive parts being reordered by a
     * changed track tag. A part whose size changed is deliberately not
     * carried: the local copy is then a copy of something else.
     */
    const carried = new Map<string, string>();
    if (!options.localRelPaths) {
      const previous = await txn.getAllAsync<{
        rel_path: string;
        size_bytes: number;
        local_rel_path: string | null;
      }>('SELECT rel_path, size_bytes, local_rel_path FROM parts WHERE book_id = ?', book.id);
      for (const row of previous) {
        if (row.local_rel_path) carried.set(`${row.rel_path}:${row.size_bytes}`, row.local_rel_path);
      }
    }

    await txn.runAsync('DELETE FROM parts WHERE book_id = ?', book.id);
    for (let i = 0; i < book.parts.length; i += 1) {
      const p = book.parts[i];
      await txn.runAsync(
        `INSERT INTO parts (book_id, idx, rel_path, name, uri, size_bytes, modified_ms,
                            duration_sec, start_sec, track_number, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        book.id, i, p.relPath, p.name, p.uri, p.sizeBytes, p.modifiedMs,
        p.durationSec, p.startSec, p.trackNumber ?? null, p.error ?? null,
      );
      const local = options.localRelPaths?.[i] ?? carried.get(`${p.relPath}:${p.sizeBytes}`);
      if (local) {
        await txn.runAsync(
          'UPDATE parts SET local_rel_path = ? WHERE book_id = ? AND idx = ?',
          local, book.id, i,
        );
      }
    }

    if (options.sourceKind || options.onDrive !== undefined || options.localRelPaths) {
      await txn.runAsync(
        `UPDATE books SET source_kind = ?, on_drive = ?, local_status = ?, local_path = ?
         WHERE id = ?`,
        options.sourceKind ?? 'library',
        options.onDrive === false ? 0 : 1,
        options.localRelPaths ? 'checked-out' : 'on-shelf',
        options.localRelPaths ? `imported/${book.id}` : null,
        book.id,
      );
    }

    await txn.runAsync('DELETE FROM chapters WHERE book_id = ?', book.id);
    for (let i = 0; i < book.chapters.length; i += 1) {
      const c = book.chapters[i];
      await txn.runAsync(
        'INSERT INTO chapters (book_id, idx, title, start_sec) VALUES (?,?,?,?)',
        book.id, i, c.title, c.startSec,
      );
    }
  });
}

/**
 * Reconciles what the scan saw with what the database holds: anything missed
 * is flagged rather than deleted, and anything seen is un-flagged. Clearing
 * the flag matters because an unchanged book skips `upsertBook` entirely.
 *
 * The evidence is an argument, not something the caller is trusted to check.
 * This is the most destructive write in the app, and it is only meaningful
 * after a scan that walked the whole of a readable root. `npm run kb evidence`.
 */
export async function markMissingExcept(
  seenIds: string[],
  evidence: { completed: boolean; rootReadable: boolean },
) {
  if (!evidence.completed || !evidence.rootReadable) return;
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    // Books added from the phone that have never been copied across were
    // never on the drive, so a drive scan cannot be evidence that they have
    // gone from it. Sweeping them up marked every fresh import "NOT ON DRIVE"
    // the moment anything triggered a scan.
    await txn.runAsync(
      `UPDATE books SET missing = 1
       WHERE NOT (COALESCE(source_kind, 'library') = 'imported' AND COALESCE(on_drive, 1) = 0)`,
    );
    // Chunked so a very large library cannot exceed SQLite's variable limit.
    const CHUNK = 400;
    for (let i = 0; i < seenIds.length; i += CHUNK) {
      const chunk = seenIds.slice(i, i + CHUNK);
      await txn.runAsync(
        `UPDATE books SET missing = 0 WHERE id IN (${chunk.map(() => '?').join(',')})`,
        ...chunk,
      );
    }
  });
}

/**
 * What a rescan compares against to decide whether a folder changed.
 *
 * Keyed on the folder, not the book: one folder can hold several books, and
 * the decision to re-read comes before the tags that would say so. The ids
 * come back too, so a skipped folder's books still count as seen.
 *
 * Assembled here rather than in SQL so that it sorts the same way
 * `fingerprintOf` does in the scanner; `group_concat` has no guaranteed order.
 */
export async function existingFingerprints(): Promise<
  Map<string, { fingerprint: string; ids: string[] }>
> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    folder: string;
    id: string;
    relPath: string;
    size: number;
    modified: number;
  }>(
    `SELECT b.folder_rel_path AS folder, b.id AS id,
            p.rel_path AS relPath, p.size_bytes AS size, p.modified_ms AS modified
     FROM books b JOIN parts p ON p.book_id = b.id`,
  );

  // Gathered per book first, because the key a book is filed under depends on
  // its own parts: a file loose in the library root is keyed by its path, not
  // by the empty folder it shares with every other loose file.
  const byBook = new Map<string, { folder: string; parts: string[] }>();
  for (const row of rows) {
    let book = byBook.get(row.id);
    if (!book) {
      book = { folder: row.folder, parts: [] };
      byBook.set(row.id, book);
    }
    book.parts.push(`${row.relPath}:${row.size}:${row.modified}`);
  }

  const byKey = new Map<string, { parts: string[]; ids: Set<string> }>();
  for (const [id, book] of byBook) {
    const first = [...book.parts].sort()[0] ?? '';
    // The stored string is `relPath:size:modified`; the key needs the path.
    const firstRelPath = first.slice(0, first.lastIndexOf(':', first.lastIndexOf(':') - 1));
    const key = fingerprintKey(book.folder, firstRelPath);

    let entry = byKey.get(key);
    if (!entry) {
      entry = { parts: [], ids: new Set() };
      byKey.set(key, entry);
    }
    entry.parts.push(...book.parts);
    entry.ids.add(id);
  }

  return new Map(
    [...byKey].map(([key, entry]) => [
      key,
      { fingerprint: entry.parts.sort().join('|'), ids: [...entry.ids] },
    ]),
  );
}

export async function loadBooks(): Promise<Book[]> {
  const db = await getDb();
  const books = await db.getAllAsync<BookRow>('SELECT * FROM books ORDER BY title');
  if (books.length === 0) return [];

  const parts = await db.getAllAsync<PartRow>('SELECT * FROM parts ORDER BY book_id, idx');
  const chapters = await db.getAllAsync<{
    book_id: string;
    title: string;
    start_sec: number;
  }>('SELECT book_id, title, start_sec FROM chapters ORDER BY book_id, idx');
  const checkouts = await db.getAllAsync<{
    book_id: string;
    out_at: string;
    back_at: string | null;
  }>('SELECT book_id, out_at, back_at FROM checkouts ORDER BY book_id, out_at');

  const partsBy = new Map<string, PartRow[]>();
  for (const p of parts) {
    const list = partsBy.get(p.book_id);
    if (list) list.push(p);
    else partsBy.set(p.book_id, [p]);
  }
  const chaptersBy = new Map<string, Chapter[]>();
  for (const c of chapters) {
    const list = chaptersBy.get(c.book_id) ?? [];
    list.push({ title: c.title, startSec: c.start_sec });
    chaptersBy.set(c.book_id, list);
  }
  const checkoutsBy = new Map<string, Checkout[]>();
  for (const c of checkouts) {
    const list = checkoutsBy.get(c.book_id) ?? [];
    list.push({ out: c.out_at, back: c.back_at ?? undefined });
    checkoutsBy.set(c.book_id, list);
  }

  return books.map((row) => {
    const bookParts = partsBy.get(row.id) ?? [];
    const palette = fallbackPalette(row.id);
    return {
      id: row.id,
      title: row.title,
      author: row.author ?? '',
      narrator: row.narrator ?? undefined,
      durationSec: row.duration_sec,
      sizeBytes: row.size_bytes,
      sourceRelPath: row.folder_rel_path,
      files: bookParts.map((p) => p.rel_path),
      chapters: chaptersBy.get(row.id) ?? [],
      // Stored as a bare file name so the row survives the app's data
      // directory moving; resolved to a URI only when handed to the UI.
      coverThumbPath: row.cover_file ? coverUri(row.cover_file) : undefined,
      local: localStateFrom(row),
      progressSec: row.progress_sec,
      finishedAt: row.finished_at ?? undefined,
      checkouts: checkoutsBy.get(row.id) ?? [],
      dominantColor: row.dominant_color ?? palette.bg,
      coverInk: palette.ink,
      missingFromDrive: row.missing === 1,
      // An imported book not yet copied across means the phone holds the only
      // copy, which is the same hazard as a book that left the drive.
      onlyCopyOnPhone: row.missing === 1 || (row.source_kind === 'imported' && row.on_drive === 0),
      importedFromPhone: row.source_kind === 'imported',
      chaptersFromParts: row.chapters_from_parts === 1,
      drmProtected: row.drm === 1,
      lastPlayedAt: row.last_played_at ?? undefined,
    } satisfies Book;
  });
}

/** Rows for the dev screen, which wants the scan bookkeeping too. */
export type DevBook = BookRow & { parts: PartRow[]; chapterCount: number };

export async function loadDevBooks(): Promise<DevBook[]> {
  const db = await getDb();
  const books = await db.getAllAsync<BookRow>(
    'SELECT * FROM books ORDER BY folder_rel_path',
  );
  const parts = await db.getAllAsync<PartRow>('SELECT * FROM parts ORDER BY book_id, idx');
  const counts = await db.getAllAsync<{ book_id: string; n: number }>(
    'SELECT book_id, COUNT(*) AS n FROM chapters GROUP BY book_id',
  );
  const countBy = new Map(counts.map((c) => [c.book_id, c.n]));
  const partsBy = new Map<string, PartRow[]>();
  for (const p of parts) {
    const list = partsBy.get(p.book_id);
    if (list) list.push(p);
    else partsBy.set(p.book_id, [p]);
  }
  return books.map((b) => ({
    ...b,
    parts: partsBy.get(b.id) ?? [],
    chapterCount: countBy.get(b.id) ?? 0,
  }));
}

/**
 * A book's parts, in playback order, for the audio engine.
 *
 * `local_uri` is the copy on the phone once checking out is real; until then
 * it is null and playback falls back to the file on the drive.
 */
export async function loadParts(
  bookId: string,
): Promise<(PartRow & { local_uri: string | null })[]> {
  const db = await getDb();
  return db.getAllAsync<PartRow & { local_uri: string | null }>(
    `SELECT p.*, p.local_rel_path AS local_uri
     FROM parts p WHERE p.book_id = ? ORDER BY p.idx`,
    bookId,
  );
}

export async function updateProgress(id: string, positionSec: number, finishedAt?: string) {
  const db = await getDb();
  /*
   * Stamped like any other authored record, because that is what it is.
   * The stamp is what lets two phones agree on a position: the latest write
   * wins, not the furthest through the book, so a deliberate rewind is not
   * undone by a sync. `npm run kb merge`.
   */
  const writer = await syncStamp();
  await db.runAsync(
    `UPDATE books SET progress_sec = ?, last_played_at = ?,
                      finished_at = COALESCE(?, finished_at),
                      progress_updated_at = ?, progress_mutation_id = ?,
                      progress_writer_device = ?
       WHERE id = ?`,
    positionSec, writer.at, finishedAt ?? null,
    writer.at, writer.mutationId, writer.device, id,
  );
}

/** Records where each part's local copy landed after a successful copy. */
/**
 * Retries a write that lost a race for the database.
 *
 * `withExclusiveTransactionAsync` runs on a connection of its own — the
 * expo-sqlite docs say outright that while one is open, "the other async write
 * queries will abort with `database is locked`". `PRAGMA busy_timeout` is set
 * per connection, so the one on ours does not cover the transaction's.
 *
 * Everything here is short, so waiting and trying again is the whole answer.
 * Only a lock is retried: a constraint failure would fail the same way for
 * ever.
 */
const LOCK_BACKOFF_MS = [80, 200, 400, 800, 1600, 3000];

function isLockedError(err: unknown): boolean {
  return /database is locked|SQLITE_BUSY/i.test((err as Error)?.message ?? '');
}

export async function withLockRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!isLockedError(err) || attempt >= LOCK_BACKOFF_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, LOCK_BACKOFF_MS[attempt]));
    }
  }
}

/**
 * Everything that turns a finished copy into a checked-out book, in one go.
 *
 * These were three separate awaits — the parts' local paths, the book's state,
 * the checkout row — and the window between them was long enough to lose. A
 * lock on the second or third left a book whose audio was on the phone and
 * whose database said otherwise, and the failure was handled by deleting the
 * copy: the book reached 100% and vanished.
 *
 * One transaction on the main connection, so it cannot collide with itself,
 * and retried as a whole, because by this point the bytes are already on the
 * phone and giving up means copying them again.
 */
export async function recordCheckoutComplete(
  bookId: string,
  localPath: string,
  localRelPaths: (string | null)[],
  outAt: string,
) {
  const db = await getDb();
  await withLockRetry(() =>
    db.withTransactionAsync(async () => {
      for (let i = 0; i < localRelPaths.length; i += 1) {
        await db.runAsync(
          'UPDATE parts SET local_rel_path = ? WHERE book_id = ? AND idx = ?',
          localRelPaths[i], bookId, i,
        );
      }
      await db.runAsync(
        'UPDATE books SET local_status = ?, local_path = ?, hold_since = NULL WHERE id = ?',
        'checked-out', localPath, bookId,
      );
      const writer = await syncStamp();
      await db.runAsync(
        `INSERT INTO checkouts (uuid, book_id, out_at, updated_at, mutation_id, writer_device)
         VALUES (?, ?, ?, ?, ?, ?)`,
        newUuid(), bookId, outAt, writer.at, writer.mutationId, writer.device,
      );
    }),
  );
}

export async function clearPartLocalPaths(bookId: string) {
  const db = await getDb();
  await db.runAsync('UPDATE parts SET local_rel_path = NULL WHERE book_id = ?', bookId);
}

export async function setLocalState(id: string, state: LocalState) {
  const db = await getDb();
  await db.runAsync(
    'UPDATE books SET local_status = ?, local_path = ?, hold_since = ? WHERE id = ?',
    state.status,
    state.status === 'checked-out' ? state.localPath : null,
    state.status === 'on-hold' ? state.since : null,
    id,
  );
}

/**
 * Who wrote this, and which write it was.
 *
 * A library-card event is authored data: it is backed up to the drive and
 * merged with whatever another phone recorded, so it needs the same stamp as
 * a note. Kept local to this module and lazy, because `books.ts` is imported
 * long before any device id is wanted.
 */
let cachedDevice: string | null = null;
async function syncStamp(): Promise<{ at: string; mutationId: string; device: string }> {
  if (!cachedDevice) cachedDevice = await ensureDeviceId();
  return { at: new Date().toISOString(), mutationId: newUuid(), device: cachedDevice };
}

export async function addCheckout(id: string, outAt: string) {
  const db = await getDb();
  const writer = await syncStamp();
  await db.runAsync(
    `INSERT INTO checkouts (uuid, book_id, out_at, updated_at, mutation_id, writer_device)
     VALUES (?, ?, ?, ?, ?, ?)`,
    newUuid(), id, outAt, writer.at, writer.mutationId, writer.device,
  );
}

export async function closeCheckout(id: string, backAt: string) {
  const db = await getDb();
  const writer = await syncStamp();
  await db.runAsync(
    `UPDATE checkouts SET back_at = ?, updated_at = ?, mutation_id = ?, writer_device = ?
     WHERE id = (SELECT id FROM checkouts WHERE book_id = ? AND back_at IS NULL
                 ORDER BY out_at DESC LIMIT 1)`,
    backAt, writer.at, writer.mutationId, writer.device, id,
  );
}

/** How many indexed books are no longer on the drive. */
export async function countMissing(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM books WHERE missing = 1',
  );
  return row?.n ?? 0;
}

/**
 * Deletes the rows for books that are no longer on the drive, and the cover
 * thumbnails they were using.
 *
 * Only ever called from an explicit, confirmed action: a missing book still
 * holds its listening progress and library-card history, which is exactly why
 * a scan flags rather than deletes.
 */
export async function forgetMissingBooks(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    'SELECT id FROM books WHERE missing = 1',
  );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  await db.withExclusiveTransactionAsync(async (txn) => {
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const q = chunk.map(() => '?').join(',');
      await txn.runAsync(`DELETE FROM chapters WHERE book_id IN (${q})`, ...chunk);
      await txn.runAsync(`DELETE FROM parts WHERE book_id IN (${q})`, ...chunk);
      await txn.runAsync(`DELETE FROM checkouts WHERE book_id IN (${q})`, ...chunk);
      await txn.runAsync(`DELETE FROM books WHERE id IN (${q})`, ...chunk);
    }
  });
  return ids;
}

/**
 * Every checked-out book, with the local paths actually recorded for its parts.
 *
 * The recorded paths are the point: a library book's files sit in
 * `books/<id>/` and an imported book's in `imported/<id>/`, so reconciliation
 * cannot assume either.
 */
export async function checkedOutLocalParts(): Promise<
  { id: string; sourceKind: string; onDrive: boolean; partCount: number; localPaths: string[] }[]
> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    sourceKind: string;
    onDrive: number;
    localPath: string | null;
  }>(
    `SELECT b.id AS id,
            COALESCE(b.source_kind, 'library') AS sourceKind,
            COALESCE(b.on_drive, 1) AS onDrive,
            p.local_rel_path AS localPath
     FROM books b LEFT JOIN parts p ON p.book_id = b.id
     WHERE b.local_status = 'checked-out'
     ORDER BY b.id, p.idx`,
  );

  const byId = new Map<
    string,
    { id: string; sourceKind: string; onDrive: boolean; partCount: number; localPaths: string[] }
  >();
  for (const row of rows) {
    let entry = byId.get(row.id);
    if (!entry) {
      entry = {
        id: row.id,
        sourceKind: row.sourceKind,
        onDrive: row.onDrive !== 0,
        partCount: 0,
        localPaths: [],
      };
      byId.set(row.id, entry);
    }
    entry.partCount += 1;
    if (row.localPath) entry.localPaths.push(row.localPath);
  }
  return [...byId.values()];
}

/**
 * Flags one book as no longer present in the library folder.
 *
 * Used when a copy discovers the files have gone: the shelf should say so at
 * once rather than waiting for the user to think of running a rescan.
 */
export async function markBookMissing(id: string) {
  const db = await getDb();
  await db.runAsync('UPDATE books SET missing = 1 WHERE id = ?', id);
}

/** Removes one book and everything hanging off it. */
export async function deleteBook(id: string) {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM parts WHERE book_id = ?', id);
    await txn.runAsync('DELETE FROM chapters WHERE book_id = ?', id);
    await txn.runAsync('DELETE FROM checkouts WHERE book_id = ?', id);
    await txn.runAsync('DELETE FROM books WHERE id = ?', id);
  });
}
/** Imported books that have not yet been copied onto the library drive. */
export async function importsAwaitingDrive(): Promise<
  { id: string; title: string; folderName: string }[]
> {
  const db = await getDb();
  return db.getAllAsync<{ id: string; title: string; folderName: string }>(
    `SELECT id, title, raw_folder_name AS folderName
     FROM books WHERE source_kind = 'imported' AND on_drive = 0 ORDER BY title`,
  );
}

/**
 * Re-points an imported book at the drive once its files have been copied.
 *
 * The book keeps its id, and its audio keeps sitting in `imported/<id>/`: it
 * is still checked out, and moving files it may be playing from would be a
 * gratuitous risk. What changes is that `drive_rel_path` now claims the folder
 * on the drive, so the next scan knows it. `npm run kb claimed`.
 */
export async function markImportOnDrive(
  bookId: string,
  folderRelPath: string,
  files: { uri: string; name: string; modifiedMs: number }[],
) {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (let i = 0; i < files.length; i += 1) {
      await txn.runAsync(
        'UPDATE parts SET uri = ?, rel_path = ?, name = ?, modified_ms = ? WHERE book_id = ? AND idx = ?',
        files[i].uri,
        `${folderRelPath}/${files[i].name}`,
        files[i].name,
        files[i].modifiedMs,
        bookId,
        i,
      );
    }
    await txn.runAsync(
      `UPDATE books
          SET on_drive = 1,
              missing = 0,
              drive_rel_path = ?,
              folder_rel_path = ?,
              raw_folder_name = ?,
              -- "Added from this phone. Not on the drive yet." is no longer true.
              warnings = NULL
        WHERE id = ?`,
      folderRelPath,
      folderRelPath,
      folderRelPath,
      bookId,
    );
  });
}

/**
 * Folders on the drive that an existing book already claims, by relative path.
 *
 * Only ever written by a push of an imported book onto the drive. Without it a
 * scan would hash the folder's path into a fresh id and index the app's own
 * copy as a second book.
 */
export async function claimedDriveFolders(): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; path: string }>(
    `SELECT id, drive_rel_path AS path FROM books
      WHERE drive_rel_path IS NOT NULL AND drive_rel_path <> ''`,
  );
  return new Map(rows.map((r) => [r.path, r.id]));
}
