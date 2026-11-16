/**
 * What a library root switch takes off the shelves, and what it must not.
 *
 * Switching folders used to mark every book missing and keep the rows, which
 * left a shelf of books that could not be opened and "Forget missing books"
 * standing over the lot. Pointing the picker at a folder that listed fine but
 * yielded no books — a cloud provider whose names carry no extension — did it
 * to a whole real library.
 *
 * The predicate is imported, not retyped, so this holds the one the app runs.
 * `src/db/scope.ts` exists for exactly that.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrate } from '../src/db/migrations.ts';
import { PLACEHOLDER_DRIVE_BOOKS } from '../src/db/scope.ts';

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

type BookSpec = {
  id: string;
  sourceId?: string | null;
  sourceKind?: string;
  onDrive?: number;
  /** One part per book, with or without a local copy. */
  localRelPath?: string | null;
};

function addBook(raw: DatabaseSync, spec: BookSpec) {
  raw
    .prepare(
      `INSERT INTO books (id, folder_rel_path, raw_folder_name, title, source_id, source_kind, on_drive)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      spec.id,
      `folder/${spec.id}`,
      spec.id,
      spec.id,
      spec.sourceId ?? null,
      spec.sourceKind ?? 'library',
      spec.onDrive ?? 1,
    );
  raw
    .prepare(
      `INSERT INTO parts (book_id, idx, rel_path, name, uri, size_bytes, local_rel_path)
       VALUES (?, 0, ?, ?, ?, 1000, ?)`,
    )
    .run(
      spec.id,
      `${spec.id}/01.mp3`,
      '01.mp3',
      `content://drive/${spec.id}/01.mp3`,
      spec.localRelPath ?? null,
    );
}

const dropped = (raw: DatabaseSync) =>
  raw
    .prepare(`SELECT id FROM books WHERE ${PLACEHOLDER_DRIVE_BOOKS} ORDER BY id`)
    .all()
    .map((r) => (r as { id: string }).id);

describe('what a root switch drops', () => {
  it('drops a drive book with no audio on the phone', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      addBook(raw, { id: 'shelf-only' });
      assert.deepEqual(dropped(raw), ['shelf-only']);
    } finally {
      raw.close();
    }
  });

  it('keeps a drive book that is checked out', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      addBook(raw, { id: 'in-my-bag', localRelPath: 'books/in-my-bag/01.mp3' });
      assert.deepEqual(dropped(raw), [], 'a book on the phone is not the drive to lose');
    } finally {
      raw.close();
    }
  });

  it('keeps an import that has never been pushed to a drive', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      // Belongs to no drive, so no drive's departure speaks for it. Excluded
      // by the source_kind guard even if its parts said nothing.
      addBook(raw, { id: 'from-my-phone', sourceKind: 'imported', onDrive: 0, localRelPath: null });
      assert.deepEqual(dropped(raw), []);
    } finally {
      raw.close();
    }
  });

  it('never touches a book from a server', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      raw
        .prepare(
          `INSERT INTO sources (id, kind, label, config, created_at)
           VALUES ('abs-1', 'audiobookshelf', 'Test', '{}', '2026-11-11T00:00:00Z')`,
        )
        .run();
      addBook(raw, { id: 'on-the-server', sourceId: 'abs-1' });
      assert.deepEqual(
        dropped(raw),
        [],
        'walking a USB drive says nothing about what is on a server',
      );
    } finally {
      raw.close();
    }
  });

  it('sorts a real mixture correctly', async () => {
    const { raw, db } = sqlite();
    try {
      await migrate(db as never);
      raw
        .prepare(
          `INSERT INTO sources (id, kind, label, config, created_at)
           VALUES ('abs-1', 'audiobookshelf', 'Test', '{}', '2026-11-11T00:00:00Z')`,
        )
        .run();
      addBook(raw, { id: 'a-placeholder' });
      addBook(raw, { id: 'b-placeholder' });
      addBook(raw, { id: 'c-checked-out', localRelPath: 'books/c/01.mp3' });
      addBook(raw, { id: 'd-imported', sourceKind: 'imported', onDrive: 0 });
      addBook(raw, { id: 'e-remote', sourceId: 'abs-1' });

      assert.deepEqual(dropped(raw), ['a-placeholder', 'b-placeholder']);
    } finally {
      raw.close();
    }
  });
});
