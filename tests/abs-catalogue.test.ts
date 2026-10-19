/**
 * The catalogue upsert and its refresh diff, against real SQLite.
 *
 * The identity rule is the thing under test: a remote book is its
 * `(source_id, remote_id)` pair, and everything the listener owns —
 * progress, notes, history — hangs off the local row that pair resolves to.
 * A refresh that mints a new row, or loses one, loses their writing.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS, migrate } from '../src/db/migrations.ts';
import { chooseProgress } from '../src/lib/abs/progress.ts';
import type { AbsCatalogueEntry } from '../src/lib/abs/map.ts';
import { DRIVE_BOOKS } from '../src/db/scope.ts';

/**
 * `upsertCatalogue` reaches for the app's database handle, which does not
 * exist off-device. The logic is re-stated here against node:sqlite rather
 * than mocked: what matters is that the SQL and the diff are right, and a
 * mock of the database would test neither.
 */
function makeStore(raw: DatabaseSync) {
  const run = (sql: string, ...args: SQLInputValue[]) => raw.prepare(sql).run(...args);
  let uuid = 0;
  const newUuid = () => `uuid-${(uuid += 1)}`;

  return function upsert(sourceId: string, entries: AbsCatalogueEntry[]) {
    const change = { added: 0, updated: 0, unchanged: 0, missing: 0, returned: 0, total: entries.length };
    const existing = raw
      .prepare('SELECT id, remote_id, remote_updated_at, missing FROM books WHERE source_id = ?')
      .all(sourceId) as { id: string; remote_id: string; remote_updated_at: number | null; missing: number }[];
    const byRemote = new Map(existing.map((r) => [r.remote_id, r]));
    const seen = new Set<string>();

    for (const entry of entries) {
      seen.add(entry.remoteId);
      const row = byRemote.get(entry.remoteId);
      const genres = entry.genres.length > 0 ? JSON.stringify(entry.genres) : null;
      if (!row) {
        run(
          `INSERT INTO books (
             id, folder_rel_path, raw_folder_name, title, author, narrator,
             title_source, author_source, duration_sec, size_bytes,
             series, genres, missing, source_id, remote_id, remote_updated_at, last_scanned_at
           ) VALUES (?,?,?,?,?,?,'server','server',?,?,?,?,?,?,?,?,?)`,
          newUuid(), entry.relPath, entry.relPath || entry.title, entry.title,
          entry.author || null, entry.narrator || null, entry.durationSec, entry.sizeBytes,
          entry.series || null, genres, entry.isMissing ? 1 : 0, sourceId, entry.remoteId,
          entry.updatedAt, 'now',
        );
        change.added += 1;
        continue;
      }
      const wasMissing = row.missing === 1;
      if (row.remote_updated_at === entry.updatedAt && wasMissing === entry.isMissing) {
        change.unchanged += 1;
        continue;
      }
      run(
        `UPDATE books SET folder_rel_path=?, title=?, author=?, narrator=?, duration_sec=?,
           size_bytes=?, series=?, genres=?, missing=?, remote_updated_at=?, last_scanned_at=?,
           remote_detail=NULL, remote_detail_at=NULL WHERE id=?`,
        entry.relPath, entry.title, entry.author || null, entry.narrator || null,
        entry.durationSec, entry.sizeBytes, entry.series || null, genres,
        entry.isMissing ? 1 : 0, entry.updatedAt, 'now', row.id,
      );
      if (wasMissing && !entry.isMissing) change.returned += 1;
      else change.updated += 1;
    }

    const vanished = existing.filter((r) => !seen.has(r.remote_id) && r.missing !== 1);
    for (const row of vanished) run('UPDATE books SET missing = 1 WHERE id = ?', row.id);
    change.missing = vanished.length;
    return change;
  };
}

function entry(over: Partial<AbsCatalogueEntry> & { remoteId: string }): AbsCatalogueEntry {
  return {
    relPath: over.remoteId,
    title: 'A Book',
    author: '',
    narrator: '',
    series: '',
    genres: [],
    durationSec: 100,
    sizeBytes: 1000,
    hasCover: false,
    updatedAt: 1000,
    isMissing: false,
    chapterCount: 0,
    trackCount: 1,
    ...over,
  };
}

let raw: DatabaseSync;
let upsert: ReturnType<typeof makeStore>;

beforeEach(async () => {
  raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF');
  const db = {
    async execAsync(sql: string) { raw.exec(sql); },
    async runAsync(sql: string, ...args: SQLInputValue[]) { return raw.prepare(sql).run(...args); },
    async getFirstAsync<T>(sql: string, ...a: SQLInputValue[]) { return (raw.prepare(sql).get(...a) as T) ?? null; },
    async getAllAsync<T>(sql: string, ...a: SQLInputValue[]) { return raw.prepare(sql).all(...a) as T[]; },
    async closeAsync() {},
  };
  await migrate(db as never);
  upsert = makeStore(raw);
});

describe('the first read of a catalogue', () => {
  it('adds every book, stamped with the source and the server id', () => {
    const change = upsert('s1', [
      entry({ remoteId: 'a', title: 'Alpha', author: 'One', series: 'S #1', genres: ['Fiction'] }),
      entry({ remoteId: 'b', title: 'Beta' }),
    ]);
    assert.deepEqual(change, { added: 2, updated: 0, unchanged: 0, missing: 0, returned: 0, total: 2 });

    const rows = raw.prepare('SELECT * FROM books ORDER BY title').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].title, 'Alpha');
    assert.equal(rows[0].source_id, 's1');
    assert.equal(rows[0].remote_id, 'a');
    assert.equal(rows[0].series, 'S #1');
    assert.deepEqual(JSON.parse(rows[0].genres as string), ['Fiction']);
    // A local uuid, not the server's id: the server's id is one half of the
    // identity, not the primary key.
    assert.notEqual(rows[0].id, 'a');
  });

  it('leaves books on the drive alone', () => {
    raw.exec(`INSERT INTO books(id, folder_rel_path, raw_folder_name, title)
              VALUES ('usb1','A','A','On The Drive')`);
    upsert('s1', [entry({ remoteId: 'a' })]);
    const usb = raw.prepare("SELECT * FROM books WHERE id = 'usb1'").get()!;
    assert.equal(usb.source_id, null);
    assert.equal(usb.missing, 0, 'a server refresh must not touch a drive book');
  });
});

describe('refreshing', () => {
  it('writes nothing for a book whose server stamp has not moved', () => {
    upsert('s1', [entry({ remoteId: 'a', updatedAt: 1000 })]);
    const change = upsert('s1', [entry({ remoteId: 'a', updatedAt: 1000 })]);
    assert.equal(change.unchanged, 1);
    assert.equal(change.updated, 0);
  });

  it('updates a book whose server stamp moved, keeping its identity', () => {
    upsert('s1', [entry({ remoteId: 'a', title: 'Old', updatedAt: 1000 })]);
    const before = raw.prepare('SELECT id FROM books').get()!.id;

    const change = upsert('s1', [entry({ remoteId: 'a', title: 'New', updatedAt: 2000 })]);
    assert.equal(change.updated, 1);

    const row = raw.prepare('SELECT * FROM books').get()!;
    assert.equal(row.id, before, 'the same row, so notes and progress stay attached');
    assert.equal(row.title, 'New');
    assert.equal(row.remote_updated_at, 2000);
  });

  it('drops the cached detail when the book changed, because it described the old one', () => {
    upsert('s1', [entry({ remoteId: 'a', updatedAt: 1000 })]);
    raw.exec("UPDATE books SET remote_detail = '{\"old\":true}', remote_detail_at = 'then'");
    upsert('s1', [entry({ remoteId: 'a', updatedAt: 2000 })]);
    const row = raw.prepare('SELECT * FROM books').get()!;
    assert.equal(row.remote_detail, null);
    assert.equal(row.remote_detail_at, null);
  });

  it('keeps what the listener wrote when the book changes on the server', () => {
    upsert('s1', [entry({ remoteId: 'a', updatedAt: 1000 })]);
    const id = raw.prepare('SELECT id FROM books').get()!.id as string;
    raw.prepare('UPDATE books SET progress_sec = ?, progress_updated_at = ? WHERE id = ?')
      .run(321, '2026-10-16T00:00:00.000Z', id);
    raw.prepare(`INSERT INTO notes (id, book_id, position_sec, chapter_index, text, created_at, updated_at)
                 VALUES ('n1', ?, 10, 0, 'mine', 'c', 'u')`).run(id);

    upsert('s1', [entry({ remoteId: 'a', title: 'Retitled', updatedAt: 9999 })]);

    const row = raw.prepare('SELECT * FROM books').get()!;
    assert.equal(row.progress_sec, 321, 'a refresh must never reset a position');
    assert.equal(row.progress_updated_at, '2026-10-16T00:00:00.000Z');
    assert.equal(raw.prepare('SELECT book_id FROM notes').get()!.book_id, id);
  });
});

describe('books that come and go', () => {
  it('marks a vanished book missing instead of deleting it', () => {
    upsert('s1', [entry({ remoteId: 'a' }), entry({ remoteId: 'b' })]);
    const change = upsert('s1', [entry({ remoteId: 'a' })]);
    assert.equal(change.missing, 1);

    const gone = raw.prepare("SELECT * FROM books WHERE remote_id = 'b'").get()!;
    assert.equal(gone.missing, 1, 'the row survives, carrying its history');
  });

  it('does not count the same book missing twice', () => {
    upsert('s1', [entry({ remoteId: 'a' }), entry({ remoteId: 'b' })]);
    upsert('s1', [entry({ remoteId: 'a' })]);
    const again = upsert('s1', [entry({ remoteId: 'a' })]);
    assert.equal(again.missing, 0);
  });

  it('brings a book back when the server has it again', () => {
    upsert('s1', [entry({ remoteId: 'a' }), entry({ remoteId: 'b' })]);
    upsert('s1', [entry({ remoteId: 'a' })]);
    const change = upsert('s1', [entry({ remoteId: 'a' }), entry({ remoteId: 'b' })]);
    assert.equal(change.returned, 1);
    assert.equal(raw.prepare("SELECT missing FROM books WHERE remote_id = 'b'").get()!.missing, 0);
  });

  it('honours isMissing from the server itself', () => {
    upsert('s1', [entry({ remoteId: 'a', isMissing: true })]);
    assert.equal(raw.prepare('SELECT missing FROM books').get()!.missing, 1);
  });

  it('keeps two sources apart, even sharing a server id', () => {
    upsert('s1', [entry({ remoteId: 'same', title: 'From One' })]);
    upsert('s2', [entry({ remoteId: 'same', title: 'From Two' })]);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM books').get()!.n, 2);
    // Refreshing one must not touch the other's book.
    const change = upsert('s1', [entry({ remoteId: 'same', title: 'From One' })]);
    assert.equal(change.unchanged, 1);
    assert.equal(change.missing, 0);
    assert.equal(raw.prepare("SELECT missing FROM books WHERE source_id = 's2'").get()!.missing, 0);
  });
});

describe('whose position is newer', () => {
  const server = (currentTime: number, lastUpdate: number) => ({ currentTime, lastUpdate });
  const local = (positionSec: number, updatedAt: string | null) => ({ positionSec, updatedAt });

  it('takes the server when it wrote last', () => {
    assert.deepEqual(
      chooseProgress(server(500, Date.parse('2026-10-17T10:00:00Z')), local(100, '2026-10-16T10:00:00Z')),
      { take: 'server', positionSec: 500 },
    );
  });

  it('keeps the local position when this phone wrote last', () => {
    assert.deepEqual(
      chooseProgress(server(500, Date.parse('2026-10-15T10:00:00Z')), local(100, '2026-10-16T10:00:00Z')),
      { take: 'local', positionSec: 100 },
    );
  });

  it('takes the server when this phone has never recorded a place', () => {
    assert.deepEqual(chooseProgress(server(500, 1), local(0, null)), { take: 'server', positionSec: 500 });
    assert.deepEqual(chooseProgress(server(500, 1), null), { take: 'server', positionSec: 500 });
  });

  it('keeps the local position when the server has no record at all', () => {
    assert.deepEqual(chooseProgress(null, local(42, '2026-10-16T10:00:00Z')), { take: 'local', positionSec: 42 });
    assert.deepEqual(chooseProgress(null, null), { take: 'local', positionSec: 0 });
  });

  it('does not treat an equal stamp as the server being newer', () => {
    const at = '2026-10-16T10:00:00.000Z';
    assert.deepEqual(
      chooseProgress(server(500, Date.parse(at)), local(100, at)),
      { take: 'local', positionSec: 100 },
    );
  });

  it('does not let an unreadable local stamp beat the server', () => {
    assert.deepEqual(
      chooseProgress(server(500, 1000), local(100, 'not a date')),
      { take: 'server', positionSec: 500 },
    );
  });
});

describe('a drive scan speaks only for the drive', () => {
  /*
   * The bug this guards against, found on the phone: a USB scan marked
   * every server book missing, and "Forget missing books" — the most
   * destructive write in the app — then deleted them, taking their
   * progress and notes with them.
   *
   * The predicate is imported, not copied, so dropping it from the real
   * queries fails here.
   */
  function seed() {
    raw.exec(`
      INSERT INTO books(id, folder_rel_path, raw_folder_name, title)
        VALUES ('usb1','A','A','On The Drive');
      INSERT INTO books(id, folder_rel_path, raw_folder_name, title, source_kind, on_drive)
        VALUES ('imp1','','','Imported','imported',0);
      INSERT INTO sources (id, kind, label, config, created_at)
        VALUES ('s1','abs','server','{}','2026-10-18T00:00:00.000Z');
      INSERT INTO books(id, folder_rel_path, raw_folder_name, title, source_id, remote_id, progress_sec)
        VALUES ('srv1','','','From The Server','s1','r1',321);
    `);
  }

  /** The sweep from markMissingExcept, with nothing found on the drive. */
  const sweep = () =>
    raw.exec(
      `UPDATE books SET missing = 1
        WHERE ${DRIVE_BOOKS}
          AND NOT (COALESCE(source_kind, 'library') = 'imported' AND COALESCE(on_drive, 1) = 0)`,
    );

  it('does not mark a server book missing', () => {
    seed();
    sweep();
    const row = (id: string) => raw.prepare('SELECT * FROM books WHERE id = ?').get(id)!;
    assert.equal(row('usb1').missing, 1, 'a drive book that vanished is missing');
    assert.equal(row('imp1').missing, 0, 'an import never on the drive is not');
    assert.equal(row('srv1').missing, 0, 'and a server book is none of its business');
  });

  it('does not count or forget a server book', () => {
    seed();
    sweep();
    // Both server and drive books flagged, however they got that way.
    raw.exec("UPDATE books SET missing = 1 WHERE id = 'srv1'");

    const count = raw
      .prepare(`SELECT COUNT(*) AS n FROM books WHERE missing = 1 AND ${DRIVE_BOOKS}`)
      .get()!.n;
    assert.equal(count, 1, 'only the drive book is offered up');

    const doomed = raw
      .prepare(`SELECT id FROM books WHERE missing = 1 AND ${DRIVE_BOOKS}`)
      .all()
      .map((r) => r.id);
    assert.deepEqual(doomed, ['usb1']);

    for (const id of doomed) raw.prepare('DELETE FROM books WHERE id = ?').run(id);
    const survivor = raw.prepare("SELECT * FROM books WHERE id = 'srv1'").get()!;
    assert.equal(survivor.progress_sec, 321, 'the server book and its place survive');
  });
});

describe('removing a server', () => {
  /*
   * The bug this guards against, found on the phone: removing a source
   * unhooked its books instead of accounting for them. Each became a row
   * with no source, no files and nothing to tell it from a book on the
   * drive — so it sat on the drive's shelf refusing to play, and re-adding
   * the server inserted a second copy of every one.
   */
  function removeSource(id: string) {
    raw.exec(`
      DELETE FROM books
        WHERE source_id = '${id}'
          AND local_status = 'on-shelf'
          AND progress_sec = 0
          AND finished_at IS NULL
          AND id NOT IN (SELECT book_id FROM checkouts)
          AND id NOT IN (SELECT book_id FROM notes WHERE deleted_at IS NULL)
          AND id NOT IN (SELECT book_id FROM characters WHERE deleted_at IS NULL);
      UPDATE books SET source_id = NULL, remote_id = NULL, missing = 1
        WHERE source_id = '${id}';
      DELETE FROM sources WHERE id = '${id}';
    `);
  }

  beforeEach(() => {
    raw.exec(`INSERT INTO sources (id, kind, label, config, created_at)
              VALUES ('s1','abs','server','{}','2026-10-19T00:00:00.000Z')`);
  });

  it('deletes a book that held nothing of the listener’s', () => {
    upsert('s1', [entry({ remoteId: 'a', title: 'Untouched' })]);
    removeSource('s1');
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM books').get()!.n, 0);
  });

  it('keeps a book with a place in it, and marks it missing', () => {
    upsert('s1', [entry({ remoteId: 'a', title: 'Half read' })]);
    const id = raw.prepare('SELECT id FROM books').get()!.id as string;
    raw.prepare('UPDATE books SET progress_sec = ? WHERE id = ?').run(640, id);

    removeSource('s1');

    const row = raw.prepare('SELECT * FROM books').get()!;
    assert.equal(row.progress_sec, 640, 'the place is the listener’s');
    assert.equal(row.source_id, null, 'nothing points at a source that is gone');
    assert.equal(row.missing, 1, 'and it must not pose as a playable drive book');
  });

  it('keeps a book somebody wrote a note on', () => {
    upsert('s1', [entry({ remoteId: 'a' })]);
    const id = raw.prepare('SELECT id FROM books').get()!.id as string;
    raw.prepare(`INSERT INTO notes (id, book_id, position_sec, chapter_index, text, created_at, updated_at)
                 VALUES ('n1', ?, 10, 0, 'mine', 'c', 'u')`).run(id);

    removeSource('s1');

    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM books').get()!.n, 1);
    assert.equal(raw.prepare('SELECT text FROM notes').get()!.text, 'mine');
  });

  it('keeps a book that is downloaded, rather than orphaning its files', () => {
    upsert('s1', [entry({ remoteId: 'a' })]);
    raw.exec("UPDATE books SET local_status = 'checked-out', local_path = 'books/x'");
    removeSource('s1');
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM books').get()!.n, 1);
  });

  it('leaves books from another source untouched', () => {
    raw.exec(`INSERT INTO sources (id, kind, label, config, created_at)
              VALUES ('s2','abs','other','{}','2026-10-19T00:00:00.000Z')`);
    upsert('s1', [entry({ remoteId: 'a' })]);
    upsert('s2', [entry({ remoteId: 'b' })]);
    removeSource('s1');
    const left = raw.prepare('SELECT * FROM books').all();
    assert.equal(left.length, 1);
    assert.equal(left[0].source_id, 's2');
    assert.equal(left[0].missing, 0);
  });
});

describe('the sweep for ghosts left by the old removal', () => {
  it('marks an orphaned server book missing, and nothing else', async () => {
    const fresh = new DatabaseSync(':memory:');
    fresh.exec('PRAGMA foreign_keys = OFF');
    const db = {
      async execAsync(sql: string) { fresh.exec(sql); },
      async runAsync(sql: string, ...a: SQLInputValue[]) { return fresh.prepare(sql).run(...a); },
      async getFirstAsync<T>(sql: string, ...a: SQLInputValue[]) { return (fresh.prepare(sql).get(...a) as T) ?? null; },
      async getAllAsync<T>(sql: string, ...a: SQLInputValue[]) { return fresh.prepare(sql).all(...a) as T[]; },
      async closeAsync() {},
    };
    try {
      // Migrate to just before the sweep, then plant what the old code left.
      for (const migration of MIGRATIONS.slice(0, MIGRATIONS.length - 1)) {
        await migration(db as never);
      }
      fresh.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1};
        INSERT INTO books(id, folder_rel_path, raw_folder_name, title, title_source)
          VALUES ('ghost','','','Orphaned Server Book','server');
        INSERT INTO books(id, folder_rel_path, raw_folder_name, title, title_source)
          VALUES ('usb','A','A','A Drive Book','tags');`);

      await migrate(db as never);

      assert.equal(fresh.prepare("SELECT missing FROM books WHERE id = 'ghost'").get()!.missing, 1);
      assert.equal(
        fresh.prepare("SELECT missing FROM books WHERE id = 'usb'").get()!.missing,
        0,
        'only the catalogue writes title_source = server, so a drive book is safe',
      );
    } finally {
      fresh.close();
    }
  });
});
