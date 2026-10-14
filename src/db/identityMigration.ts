/**
 * Turning path-derived book ids into uuids, once, without losing a reference.
 *
 * Every table that names a book names it by `books.id`, and that id used to be
 * a hash of the folder's path. Rewriting it means rewriting all of them in the
 * same breath: parts (which hold where the checked-out audio lives), chapters,
 * the library-card history, notes and characters. A half-done rename would
 * leave someone's place and their writing attached to a book that no longer
 * exists — so it is one transaction, and the old id is kept as `path_key` so
 * a scan can still find the row for a folder it has walked.
 *
 * Written as its own module rather than inline in the migration list because
 * it is the one migration with something to get wrong, and because the mapping
 * step is worth being able to read on its own.
 */

import type * as SQLite from 'expo-sqlite';
import { newUuid } from '../lib/library/ids.ts';

/** Tables that reference a book by its id, and the column that does it. */
const REFERENCES: { table: string; column: string }[] = [
  { table: 'parts', column: 'book_id' },
  { table: 'chapters', column: 'book_id' },
  { table: 'checkouts', column: 'book_id' },
  { table: 'notes', column: 'book_id' },
  { table: 'characters', column: 'book_id' },
];

/**
 * Rewrites every book id to a uuid, keeping the old id as the path key.
 *
 * Runs inside the caller's transaction. `mint` is injectable so a test can
 * make the mapping predictable.
 */
export async function rewriteBookIdsToUuids(
  db: SQLite.SQLiteDatabase,
  mint: () => string = newUuid,
): Promise<number> {
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM books');
  if (rows.length === 0) return 0;

  for (const row of rows) {
    const uuid = mint();
    /*
     * Children first, then the book. With foreign keys off — SQLite's default,
     * and what this database runs with — the order does not matter for
     * enforcement, but it matters for reading a half-applied state if anything
     * ever goes wrong: a child pointing at a book that still exists is easier
     * to understand than a book no child points at.
     */
    for (const ref of REFERENCES) {
      await db.runAsync(
        `UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ?`,
        uuid, row.id,
      );
    }
    // `path_key` is the old id: that is exactly what it was, a hash of where
    // the book was found.
    await db.runAsync('UPDATE books SET id = ?, path_key = ? WHERE id = ?', uuid, row.id, row.id);
  }
  return rows.length;
}
