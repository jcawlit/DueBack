/**
 * Removing a server, and signing back into it.
 *
 * This went wrong in the field and the shape of the bug is worth keeping,
 * because the reasoning behind it was sound. Books holding a place or a note
 * were kept when their server was removed — those are the listener's and
 * outlive the server — but they were kept like this:
 *
 *   UPDATE books SET source_id = NULL, remote_id = NULL, missing = 1
 *
 * and `source_id IS NULL` **is** the definition of a book on the USB drive.
 * Every kept book became a drive book: it turned up on the drive's shelf,
 * the next scan stamped it "not on drive", and `forgetMissingBooks` — which
 * selects exactly `missing = 1 AND source_id IS NULL` — offered to delete it
 * beside genuinely missing books. Clearing `remote_id` guaranteed a duplicate
 * on the way back in, because that was the only link by which the book could
 * have been recognised.
 *
 * Real SQLite through `node:sqlite`, so the production migrations and every
 * production statement run for real.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { deregisterDriveHooks, installFakeDatabase } from './fakeDrive.ts';

let raw: DatabaseSync;
let sources: typeof import('../src/db/sources.ts');
let books: typeof import('../src/db/books.ts');
let schema: typeof import('../src/db/schema.ts');

before(async () => {
  raw = installFakeDatabase();
  schema = await import('../src/db/schema.ts');
  const migrations = await import('../src/db/migrations.ts');
  await migrations.migrate((await schema.getDb()) as never);
  sources = await import('../src/db/sources.ts');
  books = await import('../src/db/books.ts');
});

after(() => {
  deregisterDriveHooks();
  raw.close();
});

beforeEach(() => {
  for (const table of ['books', 'parts', 'chapters', 'checkouts', 'notes', 'sources']) {
    raw.exec(`DELETE FROM ${table}`);
  }
});

const SERVER = { serverUrl: 'http://192.168.1.90:13378', username: 'jay' };

/** A book as the catalogue writes one: owned by a source, with a remote id. */
const remoteBook = (
  sourceId: string,
  id: string,
  over: { progress?: number; status?: string } = {},
) => {
  raw
    .prepare(
      `INSERT INTO books (id, folder_rel_path, raw_folder_name, title, source_id, remote_id,
                          remote_updated_at, progress_sec, local_status, missing)
       VALUES (?, '', '', ?, ?, ?, 1700000000, ?, ?, 0)`,
    )
    .run(id, id, sourceId, `remote-${id}`, over.progress ?? 0, over.status ?? 'on-shelf');
};

const bookRow = (id: string) =>
  raw.prepare('SELECT source_id, remote_id, missing FROM books WHERE id = ?').get(id) as
    | { source_id: string | null; remote_id: string | null; missing: number }
    | undefined;

const driveBookCount = () =>
  (raw.prepare('SELECT COUNT(*) AS n FROM books WHERE source_id IS NULL').get() as { n: number }).n;

describe('removing a server', () => {
  it('never turns its books into books on the drive', async () => {
    /*
     * The regression, stated as plainly as it can be. Everything else in this
     * file follows from it.
     */
    const source = await sources.addSource('abs', 'Home', SERVER);
    remoteBook(source.id, 'kept', { progress: 120 });

    await sources.removeSource(source.id);

    assert.equal(driveBookCount(), 0, 'no server book may become a drive book');
    const row = bookRow('kept')!;
    assert.equal(row.source_id, source.id, 'still owned by the source it came from');
    assert.equal(row.remote_id, 'remote-kept', 'and still linked to the server');
  });

  it('keeps a book that holds a place, a note, or a card history', async () => {
    const source = await sources.addSource('abs', 'Home', SERVER);
    remoteBook(source.id, 'has-progress', { progress: 90 });
    remoteBook(source.id, 'has-note');
    remoteBook(source.id, 'has-checkout');
    remoteBook(source.id, 'checked-out', { status: 'checked-out' });
    raw
      .prepare(
        `INSERT INTO notes (id, book_id, position_sec, chapter_index, text, created_at, updated_at)
         VALUES ('n1', 'has-note', 10, 0, 'words', 'c', 'u')`,
      )
      .run();
    raw.prepare("INSERT INTO checkouts (book_id, out_at) VALUES ('has-checkout', 'then')").run();

    await sources.removeSource(source.id);

    for (const id of ['has-progress', 'has-note', 'has-checkout', 'checked-out']) {
      assert.ok(bookRow(id), `${id} should survive`);
      assert.equal(bookRow(id)!.source_id, source.id, `${id} keeps its source`);
    }
  });

  it('deletes a book that holds nothing of the listener’s', async () => {
    // Nothing in it to protect, and keeping it would mean a shelf of
    // unplayable entries for a server nobody is signed into.
    const source = await sources.addSource('abs', 'Home', SERVER);
    remoteBook(source.id, 'empty');

    await sources.removeSource(source.id);
    assert.equal(bookRow('empty'), undefined);
  });

  it('does not mark anything missing', async () => {
    // A book whose source is not signed into is not a book missing off a
    // drive. Conflating the two is what put them in reach of the sweep.
    const source = await sources.addSource('abs', 'Home', SERVER);
    remoteBook(source.id, 'kept', { progress: 1 });

    await sources.removeSource(source.id);
    assert.equal(bookRow('kept')!.missing, 0);
  });

  it('takes the source out of the switcher without erasing it', async () => {
    const source = await sources.addSource('abs', 'Home', SERVER);
    await sources.removeSource(source.id);

    assert.deepEqual(await sources.listSources(), [], 'gone from the app');
    assert.equal(await sources.getSource(source.id), null);
    const tombstone = raw
      .prepare('SELECT removed_at FROM sources WHERE id = ?')
      .get(source.id) as { removed_at: string | null };
    assert.ok(tombstone.removed_at, 'but remembered, so its books still have an owner');
  });

  it('puts its books beyond the reach of "Forget missing books"', async () => {
    /*
     * The consequence that made this expensive. One button offered to delete
     * a removed server's books alongside genuinely missing drive books, and
     * nothing on screen distinguished them.
     */
    const source = await sources.addSource('abs', 'Home', SERVER);
    remoteBook(source.id, 'kept', { progress: 60 });
    // A real drive book that really has gone.
    raw
      .prepare(
        `INSERT INTO books (id, folder_rel_path, raw_folder_name, title, missing)
         VALUES ('drive-gone', 'A', 'A', 'A', 1)`,
      )
      .run();

    await sources.removeSource(source.id);
    const forgotten = await books.forgetMissingBooks();

    assert.deepEqual(forgotten, ['drive-gone'], 'only the drive book is forgotten');
    assert.ok(bookRow('kept'), 'the server book survives');
  });
});

describe('signing back into a server that was removed', () => {
  it('revives the same source, so its books come back attached to it', async () => {
    /*
     * The payoff. Books kept their `source_id`, so reviving the row
     * reattaches every one of them with its place, its notes and its card
     * history — and nothing is duplicated, because no second row was ever
     * made.
     */
    const first = await sources.addSource('abs', 'Home', SERVER);
    remoteBook(first.id, 'kept', { progress: 300 });
    await sources.removeSource(first.id);

    const again = await sources.addSource('abs', 'Home again', SERVER);

    assert.equal(again.id, first.id, 'the same source id');
    assert.equal(again.label, 'Home again', 'with whatever was just typed');
    assert.equal(bookRow('kept')!.source_id, again.id, 'the book is its again');
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number };
    assert.equal(rows.n, 1, 'one source row, not two');
  });

  it('matches on the server and account, not the label', async () => {
    const first = await sources.addSource('abs', 'Whatever', SERVER);
    await sources.removeSource(first.id);
    const again = await sources.addSource('abs', 'A Totally Different Name', SERVER);
    assert.equal(again.id, first.id);
  });

  it('gives a different account on the same server its own source', async () => {
    const mine = await sources.addSource('abs', 'Home', SERVER);
    await sources.removeSource(mine.id);
    const theirs = await sources.addSource('abs', 'Home', { ...SERVER, username: 'someone-else' });
    assert.notEqual(theirs.id, mine.id, 'another person’s books are not mine');
  });

  it('gives a different server its own source', async () => {
    const mine = await sources.addSource('abs', 'Home', SERVER);
    await sources.removeSource(mine.id);
    const other = await sources.addSource('abs', 'Elsewhere', {
      ...SERVER,
      serverUrl: 'https://books.example.com',
    });
    assert.notEqual(other.id, mine.id);
  });

  it('leaves a live source alone rather than reviving over it', async () => {
    const live = await sources.addSource('abs', 'Home', SERVER);
    const second = await sources.addSource('abs', 'Home', SERVER);
    assert.notEqual(second.id, live.id, 'nothing was removed, so nothing is revived');
  });
});

describe('cleaning up the books the old code orphaned', () => {
  /*
   * The repair, run as migration 19. The signature has to be exact, because
   * it deletes: a drive scan never writes `remote_updated_at`, so
   * `source_id IS NULL` together with one means a book that was once a
   * server's and was cut loose.
   */
  /** Runs migrations `[from, to)`, so the repair can be run on its own. */
  const runMigrations = async (from: number, to: number, db: unknown) => {
    const { MIGRATIONS } = await import('../src/db/migrations.ts');
    for (const migration of MIGRATIONS.slice(from, to)) await migration(db as never);
  };

  it('deletes the orphans and leaves real drive books alone', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const fresh = new DatabaseSync(':memory:');
    fresh.exec('PRAGMA foreign_keys = OFF');
    const db = {
      async execAsync(sql: string) {
        fresh.exec(sql);
      },
      async runAsync(sql: string, ...a: unknown[]) {
        return fresh.prepare(sql).run(...(a as never[]));
      },
      async getFirstAsync(sql: string, ...a: unknown[]) {
        return fresh.prepare(sql).get(...(a as never[])) ?? null;
      },
      async getAllAsync(sql: string, ...a: unknown[]) {
        return fresh.prepare(sql).all(...(a as never[]));
      },
      async closeAsync() {},
    };

    try {
      // Everything before the repair.
      await runMigrations(0, 18, db);

      // An orphan, exactly as the old statement left it.
      fresh
        .prepare(
          `INSERT INTO books (id, folder_rel_path, raw_folder_name, title, source_id, remote_id,
                              remote_updated_at, missing, progress_sec)
           VALUES ('ghost', '', '', 'Hyperion', NULL, NULL, 1700000000, 1, 400)`,
        )
        .run();
      fresh
        .prepare(
          `INSERT INTO parts (book_id, idx, rel_path, name, uri)
           VALUES ('ghost', 0, 'a', 'a', 'u')`,
        )
        .run();
      fresh.prepare("INSERT INTO checkouts (book_id, out_at) VALUES ('ghost', 'then')").run();
      fresh
        .prepare(
          `INSERT INTO notes (id, book_id, position_sec, chapter_index, text, created_at, updated_at)
           VALUES ('n1', 'ghost', 5, 0, 'kept', 'c', 'u')`,
        )
        .run();

      // A real book off the drive, which must be untouched.
      fresh
        .prepare(
          `INSERT INTO books (id, folder_rel_path, raw_folder_name, title, missing)
           VALUES ('real', 'Gorky Park', 'Gorky Park', 'Gorky Park', 1)`,
        )
        .run();
      // And a live server book, likewise.
      fresh
        .prepare(
          `INSERT INTO books (id, folder_rel_path, raw_folder_name, title, source_id, remote_id,
                              remote_updated_at)
           VALUES ('live', '', '', 'Live', 'src-1', 'r1', 1700000000)`,
        )
        .run();

      // The repair, and only the repair.
      await runMigrations(18, 19, db);

      const left = (
        fresh.prepare('SELECT id FROM books ORDER BY id').all() as { id: string }[]
      ).map((b) => b.id);
      assert.deepEqual(left, ['live', 'real'], 'the ghost goes; the other two stay');

      const parts = fresh.prepare('SELECT COUNT(*) AS n FROM parts').get() as { n: number };
      assert.equal(parts.n, 0, 'and its parts with it');
      const checkouts = fresh.prepare('SELECT COUNT(*) AS n FROM checkouts').get() as { n: number };
      assert.equal(checkouts.n, 0);

      /*
       * Notes are deliberately kept, exactly as `forgetMissingBooks` keeps
       * them: they are the only thing here a listener authored, and an
       * orphaned note costs nothing while a deleted one cannot come back.
       */
      const notes = fresh.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number };
      assert.equal(notes.n, 1, 'a note is never deleted by housekeeping');
    } finally {
      fresh.close();
    }
  });
});
