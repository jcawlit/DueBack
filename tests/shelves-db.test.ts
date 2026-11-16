/**
 * The shelves tables, against real SQLite.
 *
 * `src/db/shelves.ts` reaches `expo-sqlite` and cannot be loaded off a phone,
 * so this exercises the schema and the statements it runs: the shapes, the
 * tombstones, the one-shelf-per-book key, and the ordering a drag relies on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrate } from '../src/db/migrations.ts';
import { positionBetween } from '../src/lib/library/shelfOrder.ts';

function sqlite() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF');
  const db = {
    async execAsync(sql: string) { raw.exec(sql); },
    async runAsync(sql: string, ...a: SQLInputValue[]) { return raw.prepare(sql).run(...a); },
    async getFirstAsync<T>(sql: string, ...a: SQLInputValue[]) {
      return (raw.prepare(sql).get(...a) as T) ?? null;
    },
    async getAllAsync<T>(sql: string, ...a: SQLInputValue[]) {
      return raw.prepare(sql).all(...a) as T[];
    },
    async closeAsync() {},
  };
  return { raw, db };
}

const STAMP = `'2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z', 'dev-1', 'mut-1'`;

function addShelf(raw: DatabaseSync, id: string, sourceId: string | null, name: string, position: number) {
  raw.prepare(
    `INSERT INTO shelves (id, source_id, name, position, created_at, updated_at,
                          writer_device, mutation_id)
     VALUES (?, ?, ?, ?, ${STAMP})`,
  ).run(id, sourceId, name, position);
}

function place(raw: DatabaseSync, bookId: string, shelfId: string, position: number) {
  raw.prepare(
    `INSERT INTO shelf_books (book_id, shelf_id, position, updated_at, writer_device, mutation_id)
     VALUES (?, ?, ?, '2026-11-16T00:00:00Z', 'dev-1', 'mut-1')
     ON CONFLICT(book_id) DO UPDATE SET
       shelf_id = excluded.shelf_id, position = excluded.position, deleted_at = NULL`,
  ).run(bookId, shelfId, position);
}

const liveOn = (raw: DatabaseSync, shelfId: string) =>
  raw
    .prepare(
      `SELECT book_id FROM shelf_books
        WHERE shelf_id = ? AND deleted_at IS NULL ORDER BY position, book_id`,
    )
    .all(shelfId)
    .map((r) => (r as { book_id: string }).book_id);

describe('the shelves schema', () => {
  it('creates both tables with the sync stamp every authored table carries', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      const cols = (table: string) =>
        raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => (c as { name: string }).name);

      for (const table of ['shelves', 'shelf_books']) {
        const c = cols(table);
        for (const stamped of ['updated_at', 'writer_device', 'mutation_id', 'deleted_at', 'base_updated_at']) {
          assert.ok(c.includes(stamped), `${table}.${stamped}`);
        }
        assert.ok(c.includes('position'), `${table}.position`);
      }
      assert.ok(cols('shelves').includes('source_id'), 'a shelf belongs to one library');
    } finally {
      raw.close();
    }
  });

  it('keys an assignment on the book, so a book cannot be on two shelves', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      addShelf(raw, 'sh-1', null, 'Sci-fi', 0);
      addShelf(raw, 'sh-2', null, 'Re-reads', 1);
      place(raw, 'book-1', 'sh-1', 0);
      // Moving it is the same write, not a second row.
      place(raw, 'book-1', 'sh-2', 0);

      assert.deepEqual(liveOn(raw, 'sh-1'), []);
      assert.deepEqual(liveOn(raw, 'sh-2'), ['book-1']);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM shelf_books').get()!.n, 1);
    } finally {
      raw.close();
    }
  });

  it('orders books by position, so a midpoint drop lands where it was dropped', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      addShelf(raw, 'sh-1', null, 'Sci-fi', 0);
      place(raw, 'first', 'sh-1', 0);
      place(raw, 'last', 'sh-1', 1);
      assert.deepEqual(liveOn(raw, 'sh-1'), ['first', 'last']);

      // Dropped between them, with one write and no renumbering.
      place(raw, 'middle', 'sh-1', positionBetween(0, 1));
      assert.deepEqual(liveOn(raw, 'sh-1'), ['first', 'middle', 'last']);

      // And again into the upper gap.
      place(raw, 'later', 'sh-1', positionBetween(0.5, 1));
      assert.deepEqual(liveOn(raw, 'sh-1'), ['first', 'middle', 'later', 'last']);
    } finally {
      raw.close();
    }
  });

  it('hides a tombstoned assignment but keeps the row for the sync', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      addShelf(raw, 'sh-1', null, 'Sci-fi', 0);
      place(raw, 'book-1', 'sh-1', 0);
      raw.prepare(
        `UPDATE shelf_books SET deleted_at = '2026-11-16T01:00:00Z' WHERE book_id = ?`,
      ).run('book-1');

      assert.deepEqual(liveOn(raw, 'sh-1'), [], 'gone from the shelf');
      assert.equal(
        raw.prepare('SELECT COUNT(*) AS n FROM shelf_books').get()!.n,
        1,
        'the tombstone stays, or a sync would put it back',
      );
    } finally {
      raw.close();
    }
  });

  it('separates one library\'s shelves from another\'s', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      addShelf(raw, 'drive-1', null, 'Sci-fi', 0);
      addShelf(raw, 'abs-1', 'server-1', 'Sci-fi', 0);

      const forDrive = raw
        .prepare('SELECT id FROM shelves WHERE source_id IS NULL AND deleted_at IS NULL')
        .all()
        .map((r) => (r as { id: string }).id);
      assert.deepEqual(forDrive, ['drive-1'], 'NULL source_id is the drive, as in books');

      const forServer = raw
        .prepare("SELECT id FROM shelves WHERE source_id = 'server-1' AND deleted_at IS NULL")
        .all()
        .map((r) => (r as { id: string }).id);
      assert.deepEqual(forServer, ['abs-1'], 'two libraries may both have a "Sci-fi"');
    } finally {
      raw.close();
    }
  });

  it('runs on a database that already has books in it', async () => {
    // Which is every database this migration will ever run on.
    const { raw, db } = sqlite();
    try {
      const upToShelves = (await import('../src/db/migrations.ts')).MIGRATIONS;
      for (const m of upToShelves.slice(0, upToShelves.length - 1)) await m(db as never);
      raw.exec(`INSERT INTO books(id, folder_rel_path, raw_folder_name, title)
                VALUES ('b1','A','A','A Book')`);
      raw.exec(`PRAGMA user_version = ${upToShelves.length - 1}`);

      await migrate(db as never);

      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM books').get()!.n, 1, 'books untouched');
      addShelf(raw, 'sh-1', null, 'Sci-fi', 0);
      place(raw, 'b1', 'sh-1', 0);
      assert.deepEqual(liveOn(raw, 'sh-1'), ['b1']);
    } finally {
      raw.close();
    }
  });
});
