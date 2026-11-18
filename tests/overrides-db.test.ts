/**
 * The corrections table, against real SQLite.
 *
 * `src/db/overrides.ts` and the apply half of `src/db/sync.ts` reach
 * expo-sqlite and cannot load off a phone, so the statements are run here as
 * those files run them: the same DDL from the migration, the same upsert, and
 * the same `WHERE` clause that decides whether an incoming write is allowed to
 * land.
 *
 * That clause is the reason this file exists. It is three columns compared as
 * a tuple, it is what stops an older generation walking back a newer
 * correction, and nothing else in the suite would notice if it were wrong.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrate } from '../src/db/migrations.ts';
import { OVERRIDE_FIELDS } from '../src/lib/library/overrides.ts';

type Row = Record<string, string | null>;

describe('the corrections table', () => {
  let raw: DatabaseSync;

  before(async () => {
    raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = OFF');
    const db = {
      async execAsync(sql: string) {
        raw.exec(sql);
      },
      async runAsync(sql: string, ...a: SQLInputValue[]) {
        return raw.prepare(sql).run(...a);
      },
      async getFirstAsync<T>(sql: string, ...a: SQLInputValue[]) {
        return (raw.prepare(sql).get(...a) as T) ?? null;
      },
      async getAllAsync<T>(sql: string, ...a: SQLInputValue[]) {
        return raw.prepare(sql).all(...a) as T[];
      },
      async closeAsync() {},
    };
    await migrate(db as never);
  });

  beforeEach(() => {
    raw.exec('DELETE FROM book_overrides');
  });

  /** `saveOverride`'s statement, and the one `applyPayload` uses to take one in. */
  const put = (over: Partial<Row> & { book_id: string; updated_at: string }) => {
    const r = {
      title: null,
      author: null,
      narrator: null,
      series: null,
      series_index: null,
      cover_file: null,
      writer_device: 'phone-a',
      mutation_id: 'm1',
      deleted_at: null,
      base_updated_at: null,
      ...over,
    };
    raw
      .prepare(
        `INSERT INTO book_overrides (book_id, title, author, narrator, series,
                                     series_index, cover_file, updated_at,
                                     writer_device, mutation_id, deleted_at,
                                     base_updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(book_id) DO UPDATE SET
           title = excluded.title,
           author = excluded.author,
           narrator = excluded.narrator,
           series = excluded.series,
           series_index = excluded.series_index,
           cover_file = excluded.cover_file,
           updated_at = excluded.updated_at,
           writer_device = excluded.writer_device,
           mutation_id = excluded.mutation_id,
           deleted_at = excluded.deleted_at,
           base_updated_at = excluded.base_updated_at
         WHERE (excluded.updated_at, excluded.writer_device, excluded.mutation_id) >= (book_overrides.updated_at, book_overrides.writer_device, book_overrides.mutation_id)`,
      )
      .run(
        r.book_id, r.title, r.author, r.narrator, r.series, r.series_index,
        r.cover_file, r.updated_at, r.writer_device, r.mutation_id, r.deleted_at,
        r.base_updated_at,
      );
  };

  const get = (bookId: string) =>
    raw.prepare('SELECT * FROM book_overrides WHERE book_id = ?').get(bookId) as Row | undefined;

  it('exists after the migration, with a column per editable field', () => {
    const columns = new Set(
      (raw.prepare('PRAGMA table_info(book_overrides)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    // `seriesIndex` and `coverFile` are snake_case in the schema; the rest
    // are spelled the same on both sides.
    for (const field of OVERRIDE_FIELDS) {
      const column = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      assert.ok(columns.has(column), `no column for ${field}`);
    }
    for (const stamp of ['updated_at', 'writer_device', 'mutation_id', 'deleted_at']) {
      assert.ok(columns.has(stamp), `no ${stamp}`);
    }
  });

  it('keeps null and empty apart, which is the whole design', () => {
    /*
     * `null` is "not corrected" and `''` is "corrected to nothing". A column
     * type or a COALESCE that flattened the two would make the one field
     * people most want to clear — a bogus author — the one field they
     * cannot.
     */
    put({ book_id: 'b1', author: '', updated_at: '2026-01-01T00:00:00.000Z' });
    const row = get('b1')!;
    assert.equal(row.author, '');
    assert.equal(row.title, null);
    assert.notEqual(row.author, row.title);
  });

  it('stores a series index as text, so "none" is sayable', () => {
    put({ book_id: 'b1', series_index: '', updated_at: '2026-01-01T00:00:00.000Z' });
    assert.equal(get('b1')!.series_index, '');
    put({ book_id: 'b2', series_index: '2.5', updated_at: '2026-01-01T00:00:00.000Z' });
    assert.equal(get('b2')!.series_index, '2.5');
  });

  it('lets a newer write land', () => {
    put({ book_id: 'b1', author: 'First', updated_at: '2026-01-01T00:00:00.000Z' });
    put({
      book_id: 'b1',
      author: 'Second',
      updated_at: '2026-02-01T00:00:00.000Z',
      mutation_id: 'm2',
    });
    assert.equal(get('b1')!.author, 'Second');
  });

  it('refuses an older write, so an old generation cannot undo a fix', () => {
    /*
     * The failure this guards: plugging in a drive whose backup predates the
     * correction, and watching the bogus author come back.
     */
    put({ book_id: 'b1', author: 'Current', updated_at: '2026-02-01T00:00:00.000Z' });
    put({
      book_id: 'b1',
      author: 'Stale',
      updated_at: '2026-01-01T00:00:00.000Z',
      mutation_id: 'm0',
    });
    assert.equal(get('b1')!.author, 'Current');
  });

  it('is idempotent: taking the same backup in twice changes nothing', () => {
    const write = {
      book_id: 'b1',
      author: 'Dan Simmons',
      updated_at: '2026-02-01T00:00:00.000Z',
    } as const;
    put(write);
    const first = get('b1')!;
    put(write);
    assert.deepEqual(get('b1'), first);
  });

  it('breaks a same-millisecond tie the same way every time', () => {
    // Two phones can genuinely write in one millisecond. The tie is broken on
    // the writer and then the mutation: arbitrary, but arbitrary in a way both
    // sides compute identically, which is the whole requirement.
    const at = '2026-02-01T00:00:00.000Z';
    put({ book_id: 'b1', author: 'A', updated_at: at, writer_device: 'phone-a' });
    put({ book_id: 'b1', author: 'B', updated_at: at, writer_device: 'phone-b' });
    assert.equal(get('b1')!.author, 'B', 'phone-b sorts later');

    raw.exec('DELETE FROM book_overrides');
    put({ book_id: 'b1', author: 'B', updated_at: at, writer_device: 'phone-b' });
    put({ book_id: 'b1', author: 'A', updated_at: at, writer_device: 'phone-a' });
    assert.equal(get('b1')!.author, 'B', 'and the same answer in the other order');
  });

  it('carries a revert as a tombstone rather than an absent row', () => {
    put({ book_id: 'b1', author: 'Dan Simmons', updated_at: '2026-01-01T00:00:00.000Z' });
    put({
      book_id: 'b1',
      updated_at: '2026-02-01T00:00:00.000Z',
      mutation_id: 'm2',
      deleted_at: '2026-02-01T00:00:00.000Z',
    });
    const row = get('b1')!;
    assert.ok(row.deleted_at, 'the row stays, as a tombstone');
    assert.equal(row.author, null);
  });

  it('counts a pending correction as a pending backup', () => {
    // `isBackupPending` compares the newest authored write against the last
    // backup. A correction that did not appear in that union would sit on one
    // phone until something else happened to need a backup.
    put({ book_id: 'b1', title: 'Hyperion', updated_at: '2026-03-01T00:00:00.000Z' });
    const row = raw
      .prepare('SELECT MAX(updated_at) AS newest FROM book_overrides')
      .get() as { newest: string | null };
    assert.equal(row.newest, '2026-03-01T00:00:00.000Z');
  });
});
