/**
 * The migration that adds sources, run against a database that already has
 * books in it — which is every database this will ever run on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS, migrate } from '../src/db/migrations.ts';

function sqlite() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF');
  const db = {
    async execAsync(sql: string) { raw.exec(sql); },
    async runAsync(sql: string, ...args: SQLInputValue[]) {
      return raw.prepare(sql).run(...args);
    },
    async getFirstAsync<T>(sql: string, ...args: SQLInputValue[]) {
      return (raw.prepare(sql).get(...args) as T) ?? null;
    },
    async getAllAsync<T>(sql: string, ...args: SQLInputValue[]) {
      return raw.prepare(sql).all(...args) as T[];
    },
    async closeAsync() {},
  };
  return { raw, db };
}

const columns = (raw: DatabaseSync, table: string) =>
  raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name as string);

describe('the sources migration', () => {
  it('adds the table and the two book columns, leaving the drive alone', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);

      assert.deepEqual(
        columns(raw, 'sources').sort(),
        ['config', 'created_at', 'id', 'kind', 'label', 'last_seen_at'],
      );
      const book = columns(raw, 'books');
      assert.ok(book.includes('source_id'), 'books.source_id');
      assert.ok(book.includes('remote_id'), 'books.remote_id');

      // The USB library is the implicit source and gets no row of its own.
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sources').get()!.n, 0);
    } finally {
      raw.close();
    }
  });

  it('leaves an existing library untouched — every book still reads as a drive book', async () => {
    const { raw, db } = sqlite();
    try {
      // A database as it stood before this migration existed.
      for (const migration of MIGRATIONS.slice(0, MIGRATIONS.length - 1)) {
        await migration(db as never);
      }
      raw.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1};
        INSERT INTO books(id, folder_rel_path, raw_folder_name, title, progress_sec, local_status)
          VALUES ('b1', 'A', 'A', 'Book One', 412, 'checked-out');
        INSERT INTO notes (id, book_id, position_sec, chapter_index, text, created_at, updated_at)
          VALUES ('n1','b1',10,0,'a note','c','u');`);

      await migrate(db as never);

      const book = raw.prepare('SELECT * FROM books').get()!;
      assert.equal(book.id, 'b1');
      assert.equal(book.progress_sec, 412);
      assert.equal(book.local_status, 'checked-out');
      // Null is what "on the drive" looks like. Nothing was backfilled.
      assert.equal(book.source_id, null);
      assert.equal(book.remote_id, null);
      assert.equal(raw.prepare('SELECT text FROM notes').get()!.text, 'a note');
      assert.equal(
        raw.prepare('PRAGMA user_version').get()!.user_version,
        MIGRATIONS.length,
      );
    } finally {
      raw.close();
    }
  });

  it('holds a source without holding anything secret', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      const config = JSON.stringify({
        serverUrl: 'http://192.168.1.90:13378',
        username: 'dueback-test',
        absLibraryId: 'lib-1',
      });
      raw.prepare(
        'INSERT INTO sources (id, kind, label, config, created_at) VALUES (?,?,?,?,?)',
      ).run('s1', 'abs', '192.168.1.90:13378', config, '2026-10-16T00:00:00.000Z');

      const row = raw.prepare('SELECT * FROM sources').get()!;
      assert.equal(row.kind, 'abs');
      assert.equal(row.last_seen_at, null);
      const parsed = JSON.parse(row.config as string);
      assert.equal(parsed.absLibraryId, 'lib-1');

      // The whole row, read as text, must not contain anything that could
      // sign anyone in. This is the guard on "secrets never in SQLite".
      const dump = JSON.stringify(row);
      for (const secret of ['password', 'accessToken', 'refreshToken', 'apiKey']) {
        assert.equal(dump.includes(secret), false, `sources row must not carry a ${secret}`);
      }
    } finally {
      raw.close();
    }
  });

  it('unhooks a removed source from its books instead of deleting them', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      raw.exec(`
        INSERT INTO sources (id, kind, label, config, created_at)
          VALUES ('s1','abs','server','{}','2026-10-16T00:00:00.000Z');
        INSERT INTO books(id, folder_rel_path, raw_folder_name, title, source_id, remote_id, progress_sec)
          VALUES ('b1','','','Remote Book','s1','abs-123', 90);
      `);

      // What removeSource does, in the order it does it.
      raw.exec("UPDATE books SET source_id = NULL, remote_id = NULL WHERE source_id = 's1'");
      raw.exec("DELETE FROM sources WHERE id = 's1'");

      const book = raw.prepare('SELECT * FROM books').get()!;
      assert.equal(book.title, 'Remote Book');
      assert.equal(book.progress_sec, 90, "progress belongs to the listener and survives");
      assert.equal(book.source_id, null);
    } finally {
      raw.close();
    }
  });
});
