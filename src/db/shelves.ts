/**
 * Shelves the listener arranged by hand, and which book sits on which.
 *
 * Authored data, in the same sense notes are: a rescan can rebuild every
 * other table from the drive, but not a shelf called "Re-reads" with eleven
 * books on it. So everything here soft-deletes, every write carries a sync
 * stamp, and every write tells the backup. `src/db/notes.ts` is the model;
 * the rules are deliberately identical, because two tables that merge the
 * same way should look the same way.
 *
 * A book is on at most one shelf, so `shelf_books` is keyed on the book. Two
 * phones disagreeing about where a book goes then merges to one answer,
 * rather than putting the book on both shelves.
 */

import { readingDataChanged } from '@/lib/sync/changes';
import { needsRenumber, positionBetween, renumbered, STEP } from '@/lib/library/shelfOrder';
import { withLockRetry } from './books';
import { newId } from './notes';
import { getDb } from './schema';
import { ensureDeviceId } from './identity';

export type Shelf = {
  id: string;
  /** Null for the drive, which is the implicit source and has no row. */
  sourceId: string | null;
  name: string;
  position: number;
  /** Book ids on this shelf, in the order they were arranged. */
  bookIds: string[];
};

let cachedDevice: string | null = null;
async function stamp(): Promise<{ at: string; mutationId: string; device: string }> {
  if (!cachedDevice) cachedDevice = await ensureDeviceId();
  return { at: new Date().toISOString(), mutationId: newId(), device: cachedDevice };
}

type ShelfRow = {
  id: string;
  source_id: string | null;
  name: string;
  position: number;
};

/**
 * Every live shelf for one source, in order, each with its books in order.
 *
 * Tombstones are filtered here rather than by the caller: a deleted shelf is
 * a row the sync still needs and the UI must never see.
 */
export async function loadShelves(sourceId: string | null): Promise<Shelf[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ShelfRow>(
    `SELECT id, source_id, name, position FROM shelves
      WHERE deleted_at IS NULL AND source_id IS ?
      ORDER BY position, created_at`,
    sourceId,
  );
  if (rows.length === 0) return [];

  const placed = await db.getAllAsync<{ book_id: string; shelf_id: string }>(
    `SELECT sb.book_id, sb.shelf_id FROM shelf_books sb
       JOIN shelves s ON s.id = sb.shelf_id
      WHERE sb.deleted_at IS NULL AND s.deleted_at IS NULL AND s.source_id IS ?
      ORDER BY sb.position, sb.book_id`,
    sourceId,
  );

  const byShelf = new Map<string, string[]>();
  for (const row of placed) {
    const list = byShelf.get(row.shelf_id);
    if (list) list.push(row.book_id);
    else byShelf.set(row.shelf_id, [row.book_id]);
  }

  return rows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    name: row.name,
    position: row.position,
    bookIds: byShelf.get(row.id) ?? [],
  }));
}

/** Appends a shelf after the last one this source has. */
export async function createShelf(sourceId: string | null, name: string): Promise<Shelf> {
  const db = await getDb();
  const { at, mutationId, device } = await stamp();
  const id = newId();
  const last = await db.getFirstAsync<{ position: number }>(
    `SELECT MAX(position) AS position FROM shelves WHERE deleted_at IS NULL AND source_id IS ?`,
    sourceId,
  );
  const position = last?.position === null || last?.position === undefined
    ? 0
    : last.position + STEP;

  await withLockRetry(() =>
    db.runAsync(
      `INSERT INTO shelves (id, source_id, name, position, created_at, updated_at,
                            mutation_id, writer_device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, sourceId, name.trim(), position, at, at, mutationId, device,
    ),
  );
  readingDataChanged();
  return { id, sourceId, name: name.trim(), position, bookIds: [] };
}

export async function renameShelf(shelfId: string, name: string): Promise<void> {
  const db = await getDb();
  const { at, mutationId, device } = await stamp();
  await withLockRetry(() =>
    db.runAsync(
      `UPDATE shelves SET name = ?, updated_at = ?, mutation_id = ?, writer_device = ?
        WHERE id = ?`,
      name.trim(), at, mutationId, device, shelfId,
    ),
  );
  readingDataChanged();
}

/**
 * Removes a shelf, and lets go of the books that were on it.
 *
 * Their assignments are tombstoned too rather than left pointing at a deleted
 * shelf: a dangling assignment would survive a sync and put the books back on
 * a shelf the other phone had thrown away.
 */
export async function softDeleteShelf(shelfId: string): Promise<void> {
  const db = await getDb();
  const { at, mutationId, device } = await stamp();
  await withLockRetry(() =>
    db.withTransactionAsync(async () => {
      await db.runAsync(
        `UPDATE shelves SET deleted_at = ?, updated_at = ?, mutation_id = ?, writer_device = ?
          WHERE id = ?`,
        at, at, mutationId, device, shelfId,
      );
      await db.runAsync(
        `UPDATE shelf_books
            SET deleted_at = ?, updated_at = ?, mutation_id = ?, writer_device = ?
          WHERE shelf_id = ? AND deleted_at IS NULL`,
        at, at, mutationId, device, shelfId,
      );
    }),
  );
  readingDataChanged();
}

/**
 * Puts a book on a shelf, between the two books it was dropped between.
 *
 * `beforeId` and `afterId` are the books either side of the gap, as the UI
 * sees them — not indexes, because by the time this runs the list may have
 * been rebuilt. Either may be null, meaning the top or the bottom.
 *
 * The precision guard runs first: if the gap those two leave is too small to
 * split, the shelf is spread out again and the gap re-read, so the position
 * stored always has room on both sides of it.
 */
export async function placeBookOnShelf(
  bookId: string,
  shelfId: string,
  beforeId: string | null,
  afterId: string | null,
): Promise<void> {
  const db = await getDb();
  const { at, mutationId, device } = await stamp();

  const positionOf = async (id: string | null): Promise<number | null> => {
    if (!id) return null;
    const row = await db.getFirstAsync<{ position: number }>(
      `SELECT position FROM shelf_books WHERE book_id = ? AND deleted_at IS NULL`,
      id,
    );
    return row?.position ?? null;
  };

  await withLockRetry(() =>
    db.withTransactionAsync(async () => {
      let before = await positionOf(beforeId);
      let after = await positionOf(afterId);

      if (needsRenumber(before, after)) {
        const rows = await db.getAllAsync<{ book_id: string }>(
          `SELECT book_id FROM shelf_books
            WHERE shelf_id = ? AND deleted_at IS NULL ORDER BY position, book_id`,
          shelfId,
        );
        const spread = renumbered(rows.length);
        for (let i = 0; i < rows.length; i += 1) {
          await db.runAsync(
            `UPDATE shelf_books SET position = ? WHERE book_id = ?`,
            spread[i], rows[i].book_id,
          );
        }
        before = await positionOf(beforeId);
        after = await positionOf(afterId);
      }

      const position = positionBetween(before, after);
      /*
       * One row per book, so this is an upsert rather than an insert. Moving
       * a book from one shelf to another is the same write as placing it for
       * the first time, and `deleted_at` is cleared because re-placing a book
       * that was taken off a shelf is a placement, not a resurrection.
       */
      await db.runAsync(
        `INSERT INTO shelf_books (book_id, shelf_id, position, updated_at,
                                  mutation_id, writer_device, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(book_id) DO UPDATE SET
           shelf_id = excluded.shelf_id,
           position = excluded.position,
           updated_at = excluded.updated_at,
           mutation_id = excluded.mutation_id,
           writer_device = excluded.writer_device,
           deleted_at = NULL`,
        bookId, shelfId, position, at, mutationId, device,
      );
    }),
  );
  readingDataChanged();
}

/**
 * Writes a whole rearrangement in one transaction.
 *
 * A drop onto a full shelf moves more than one book: the book you dropped,
 * the ones that shifted along, and whatever was pushed down. They have to
 * land together or a crash between two writes leaves a shelf holding four
 * books and another holding none.
 *
 * `shelfId: null` means the book belongs to no shelf — it fell off the
 * bottom — which is a tombstone rather than a row saying "nowhere".
 *
 * Positions are indexes here, not midpoints. A shelf holds three, so
 * rewriting all three costs nothing and leaves the numbers tidy; the
 * fractional machinery in `shelfOrder` is for inserting without
 * renumbering, which a shelf this small never needs.
 */
export async function applyArrangement(
  changes: { bookId: string; shelfId: string | null; position: number }[],
): Promise<void> {
  if (changes.length === 0) return;
  const db = await getDb();
  const { at, mutationId, device } = await stamp();
  await withLockRetry(() =>
    db.withTransactionAsync(async () => {
      for (const change of changes) {
        if (change.shelfId === null) {
          await db.runAsync(
            `UPDATE shelf_books
                SET deleted_at = ?, updated_at = ?, mutation_id = ?, writer_device = ?
              WHERE book_id = ? AND deleted_at IS NULL`,
            at, at, mutationId, device, change.bookId,
          );
          continue;
        }
        await db.runAsync(
          `INSERT INTO shelf_books (book_id, shelf_id, position, updated_at,
                                    mutation_id, writer_device, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(book_id) DO UPDATE SET
             shelf_id = excluded.shelf_id,
             position = excluded.position,
             updated_at = excluded.updated_at,
             mutation_id = excluded.mutation_id,
             writer_device = excluded.writer_device,
             deleted_at = NULL`,
          change.bookId, change.shelfId, change.position, at, mutationId, device,
        );
      }
    }),
  );
  readingDataChanged();
}

/** Takes a book off whatever shelf it was on, without deleting the shelf. */
export async function removeBookFromShelves(bookId: string): Promise<void> {
  const db = await getDb();
  const { at, mutationId, device } = await stamp();
  await withLockRetry(() =>
    db.runAsync(
      `UPDATE shelf_books
          SET deleted_at = ?, updated_at = ?, mutation_id = ?, writer_device = ?
        WHERE book_id = ? AND deleted_at IS NULL`,
      at, at, mutationId, device, bookId,
    ),
  );
  readingDataChanged();
}
