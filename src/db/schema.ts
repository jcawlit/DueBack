/**
 * The database. Every per-book fact lives here and nowhere else — cover path,
 * USB location, parts, chapters, local copy state and playback progress are all
 * columns, so there is never a second place to reconcile.
 */

import * as SQLite from 'expo-sqlite';

export const DB_NAME = 'dueback.db';

/**
 * The in-flight open, memoised as a *promise* rather than a handle.
 *
 * Callers routinely ask for the database concurrently. Caching the resolved
 * handle lets every one of those see `null`, open its own connection and run
 * the migration — which SQLite answers with a null-pointer failure.
 */
let opening: Promise<SQLite.SQLiteDatabase> | null = null;

/** Opens the database, creating or migrating the schema on first use. */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!opening) {
    opening = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      // Without a busy timeout a locked database fails on the spot rather than
      // waiting its turn. `withExclusiveTransactionAsync` runs on its own
      // connection, so the moment two writers overlap — a scan indexing books
      // while a check-out records where it put the files — one of them was
      // dying with "database is locked" instead of pausing for a few
      // milliseconds.
      await db.execAsync('PRAGMA busy_timeout = 8000');
      await migrate(db);
      return db;
    })().catch((err) => {
      // A failed open must not be cached, or the app can never recover.
      opening = null;
      throw err;
    });
  }
  return opening;
}

/** For tests and "forget this library" — drops the connection. */
export async function closeDb() {
  const current = opening;
  opening = null;
  if (!current) return;
  const db = await current.catch(() => null);
  await db?.closeAsync();
}

const MIGRATIONS: ((db: SQLite.SQLiteDatabase) => Promise<void>)[] = [
  async (db) => {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS books (
        id                TEXT PRIMARY KEY NOT NULL,
        folder_rel_path   TEXT NOT NULL,
        raw_folder_name   TEXT NOT NULL,
        title             TEXT NOT NULL,
        author            TEXT,
        narrator          TEXT,
        title_source      TEXT,
        author_source     TEXT,
        duration_sec      REAL NOT NULL DEFAULT 0,
        size_bytes        INTEGER NOT NULL DEFAULT 0,
        cover_file        TEXT,
        cover_source      TEXT,
        dominant_color    TEXT,
        -- Playback and checkout state.
        progress_sec      REAL NOT NULL DEFAULT 0,
        finished_at       TEXT,
        last_played_at    TEXT,
        local_status      TEXT NOT NULL DEFAULT 'on-shelf',
        local_path        TEXT,
        hold_since        TEXT,
        -- Scan bookkeeping.
        missing           INTEGER NOT NULL DEFAULT 0,
        drm               INTEGER NOT NULL DEFAULT 0,
        warnings          TEXT,
        skipped_files     INTEGER NOT NULL DEFAULT 0,
        last_scanned_at   TEXT,
        scan_ms           INTEGER NOT NULL DEFAULT 0,
        bytes_read        INTEGER NOT NULL DEFAULT 0,
        read_count        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS parts (
        book_id       TEXT NOT NULL,
        idx           INTEGER NOT NULL,
        rel_path      TEXT NOT NULL,
        name          TEXT NOT NULL,
        uri           TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        modified_ms   INTEGER NOT NULL DEFAULT 0,
        duration_sec  REAL NOT NULL DEFAULT 0,
        start_sec     REAL NOT NULL DEFAULT 0,
        track_number  INTEGER,
        error         TEXT,
        PRIMARY KEY (book_id, idx),
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chapters (
        book_id    TEXT NOT NULL,
        idx        INTEGER NOT NULL,
        title      TEXT NOT NULL,
        start_sec  REAL NOT NULL,
        PRIMARY KEY (book_id, idx),
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS checkouts (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id  TEXT NOT NULL,
        out_at   TEXT NOT NULL,
        back_at  TEXT,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_parts_book ON parts(book_id);
      CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
      CREATE INDEX IF NOT EXISTS idx_checkouts_book ON checkouts(book_id);
      CREATE INDEX IF NOT EXISTS idx_books_folder ON books(folder_rel_path);
    `);
  },
  async (db) => {
    // Where each part's local copy lives, relative to the documents directory.
    // A book's local files are only valid when every part has one.
    await db.execAsync(`ALTER TABLE parts ADD COLUMN local_rel_path TEXT`);
  },
  async (db) => {
    // Books can now come from the phone as well as the library folder.
    // `on_drive` is 0 for an imported book until it has been copied across,
    // which is the state that makes the phone hold the only copy.
    await db.execAsync(`
      ALTER TABLE books ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'library';
      ALTER TABLE books ADD COLUMN on_drive INTEGER NOT NULL DEFAULT 1;
    `);
  },
  async (db) => {
    // Whether a book's chapters are real chapters or the one-per-part
    // fallback. The lock screen says "Part 3 of 127" for the latter rather
    // than showing a file name as though it were a chapter title.
    await db.execAsync(
      `ALTER TABLE books ADD COLUMN chapters_from_parts INTEGER NOT NULL DEFAULT 0`,
    );
  },
  async (db) => {
    // The folder an imported book was copied into on the drive.
    //
    // A book's identity is a hash of its path, so a folder the app itself
    // created would be read back as a new book. This column tells the scan
    // that the folder it has found is already a book it knows.
    await db.execAsync(`ALTER TABLE books ADD COLUMN drive_rel_path TEXT`);
  },
  async (db) => {
    /*
     * The margins: what the listener writes down, and who they write about.
     *
     * Soft deletes throughout. These rows are the only thing in the database
     * the user authored — everything else can be rebuilt by a rescan — so a
     * later sync needs to know that a row was removed rather than never
     * existing, and `deleted_at` is what tells it apart.
     *
     * A note with empty text is a bookmark. There is no second concept and no
     * flag: a bookmark the listener types into becomes a note, and a note they
     * empty becomes a bookmark again.
     */
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS notes (
        id            TEXT PRIMARY KEY NOT NULL,
        book_id       TEXT NOT NULL,
        position_sec  REAL NOT NULL,
        chapter_index INTEGER NOT NULL DEFAULT 0,
        text          TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        deleted_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_id, position_sec);

      CREATE TABLE IF NOT EXISTS characters (
        id         TEXT PRIMARY KEY NOT NULL,
        book_id    TEXT NOT NULL,
        name       TEXT NOT NULL,
        aliases    TEXT NOT NULL DEFAULT '',
        bio        TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_characters_book ON characters(book_id, name);

      CREATE TABLE IF NOT EXISTS note_characters (
        note_id      TEXT NOT NULL,
        character_id TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        deleted_at   TEXT,
        PRIMARY KEY (note_id, character_id)
      );
      CREATE INDEX IF NOT EXISTS idx_note_characters_character
        ON note_characters(character_id);
    `);
  },
];

async function migrate(db: SQLite.SQLiteDatabase) {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    await MIGRATIONS[i](db);
    version = i + 1;
  }
  await db.execAsync(`PRAGMA user_version = ${version}`);
}

/** Simple key/value settings: library root, budget, last scan time. */
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string | null }>(
    'SELECT value FROM settings WHERE key = ?',
    key,
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string | null) {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export const SETTING_KEYS = {
  libraryRootUri: 'library.root.uri',
  libraryRootName: 'library.root.name',
  lastSeenAt: 'library.lastSeenAt',
  lastScanAt: 'library.lastScanAt',
  budgetBytes: 'bag.budgetBytes',
  /** The book to reopen on launch, so the app comes back where it was left. */
  lastBookId: 'player.lastBookId',
  /** Whether notes and bios are shown in the handwriting face. */
  handwrittenNotes: 'notes.handwritten',
} as const;
