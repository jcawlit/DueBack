/**
 * Storing and reading a listener's corrections to a book's metadata.
 *
 * The rules live in `src/lib/library/overrides.ts`, which is pure and tested.
 * This file is only the storage: one row per book, every column nullable,
 * NULL meaning "not corrected" and `''` meaning "corrected to nothing".
 *
 * Like the margins, these rows soft-delete. A reverted correction leaves a
 * tombstone so the revert itself travels to the other phone — without one, a
 * sync would read the other side's surviving correction as news and put it
 * straight back.
 */

import { readingDataChanged } from '@/lib/sync/changes';
import type { BookOverride, OverrideField } from '@/lib/library/overrides';
import { OVERRIDE_FIELDS } from '@/lib/library/overrides';
// A uuid rather than the id helper in `notes.ts`: importing from there would
// put this module in a cycle with `books.ts` once `loadBooks` layers
// corrections in.
import { newUuid } from '@/lib/library/ids';
import { getDb, withLockRetry } from './schema';
import { ensureDeviceId } from './identity';

export type OverrideRow = {
  book_id: string;
  title: string | null;
  author: string | null;
  narrator: string | null;
  series: string | null;
  series_index: string | null;
  cover_file: string | null;
  updated_at: string;
  writer_device: string;
  mutation_id: string;
  deleted_at: string | null;
  base_updated_at: string | null;
};

/** The column each editable field lives in. One place, so a rename is caught. */
const COLUMN: Record<OverrideField, keyof OverrideRow> = {
  title: 'title',
  author: 'author',
  narrator: 'narrator',
  series: 'series',
  seriesIndex: 'series_index',
  coverFile: 'cover_file',
};

let cachedDevice: string | null = null;
async function stamp() {
  if (!cachedDevice) cachedDevice = await ensureDeviceId();
  return { at: new Date().toISOString(), mutationId: newUuid(), device: cachedDevice };
}

export function overrideFromRow(row: OverrideRow | null | undefined): BookOverride | null {
  if (!row || row.deleted_at) return null;
  const override: BookOverride = {};
  for (const field of OVERRIDE_FIELDS) {
    override[field] = row[COLUMN[field]] as string | null;
  }
  return override;
}

/**
 * Live corrections, keyed by book, for `loadBooks` to layer in one pass.
 *
 * `onlyId` narrows it to one book, for the single-book reload behind an edit.
 */
export async function loadOverrides(onlyId?: string): Promise<Map<string, BookOverride>> {
  const db = await getDb();
  const rows = await db.getAllAsync<OverrideRow>(
    `SELECT * FROM book_overrides WHERE deleted_at IS NULL${onlyId ? ' AND book_id = ?' : ''}`,
    ...(onlyId ? [onlyId] : []),
  );
  const byBook = new Map<string, BookOverride>();
  for (const row of rows) {
    const override = overrideFromRow(row);
    if (override) byBook.set(row.book_id, override);
  }
  return byBook;
}

export async function loadOverride(bookId: string): Promise<BookOverride | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<OverrideRow>(
    'SELECT * FROM book_overrides WHERE book_id = ?',
    bookId,
  );
  return overrideFromRow(row);
}

/**
 * Applies a patch to one book's corrections.
 *
 * A patch is **per field**: a key that is absent leaves that correction as it
 * was, and a key set to `null` removes it. That matters because the cover is
 * saved on its own — picking a new picture must not quietly revert a title
 * typed a moment earlier.
 *
 * Writing a patch that leaves nothing behind tombstones the row rather than
 * deleting it, for the reason in this file's header.
 */
export async function saveOverride(bookId: string, patch: BookOverride): Promise<void> {
  const db = await getDb();
  const { at, mutationId, device } = await stamp();

  /*
   * Read and write in one transaction, because the merge below is
   * read-modify-write over the row. The cover is saved by one gesture and the
   * text by another, so two saves can be in flight at once — and interleaved
   * they would drop whichever correction was read first.
   */
  await withLockRetry(() => db.withExclusiveTransactionAsync(async (txn) => {
    const existing = await txn.getFirstAsync<OverrideRow>(
      'SELECT * FROM book_overrides WHERE book_id = ?',
      bookId,
    );
    const live = existing && !existing.deleted_at ? existing : null;

    const merged = OVERRIDE_FIELDS.map((field) => {
      if (field in patch) return patch[field] ?? null;
      return live ? ((live[COLUMN[field]] as string | null) ?? null) : null;
    });

    // Nothing corrected any more. The row stays as a tombstone so the revert
    // is a fact the other phone can read, not an absence it has to infer.
    const empty = merged.every((value) => value === null);

    await txn.runAsync(
      `INSERT INTO book_overrides (
         book_id, title, author, narrator, series, series_index, cover_file,
         updated_at, writer_device, mutation_id, deleted_at, base_updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(book_id) DO UPDATE SET
         title           = excluded.title,
         author          = excluded.author,
         narrator        = excluded.narrator,
         series          = excluded.series,
         series_index    = excluded.series_index,
         cover_file      = excluded.cover_file,
         updated_at      = excluded.updated_at,
         writer_device   = excluded.writer_device,
         mutation_id     = excluded.mutation_id,
         deleted_at      = excluded.deleted_at,
         -- What both sides last agreed on, so a two-sided edit is detectable.
         base_updated_at = book_overrides.updated_at`,
      bookId,
      ...merged,
      at,
      device,
      mutationId,
      empty ? at : null,
      live ? live.updated_at : null,
    );
  }));

  readingDataChanged();
}

/** Puts a book back the way the files describe it. */
export async function clearOverride(bookId: string): Promise<void> {
  const patch: BookOverride = {};
  for (const field of OVERRIDE_FIELDS) patch[field] = null;
  await saveOverride(bookId, patch);
}
