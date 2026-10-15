import type * as SQLite from 'expo-sqlite';
import { rewriteBookIdsToUuids } from './identityMigration.ts';
import { newUuid } from '../lib/library/ids.ts';

export const MIGRATIONS: ((db: SQLite.SQLiteDatabase) => Promise<void>)[] = [
  async (db) => {
    await db.execAsync(`


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
  async (db) => {
    /*
     * Books stop being their path.
     *
     * `path_key` is where a book was found — the old id, which was a hash of
     * exactly that — and `id` becomes a uuid that survives the folder being
     * renamed, moved, or reached through a different mount.
     *
     * The shape columns are what narrows a vanished book to candidates
     * without reading any audio; `sample_hash` is what proves one of them.
     * `library_id` keeps books attached to the library they came from, so a
     * drive recognised at a new path brings its books with it.
     */
    await db.execAsync(`
      ALTER TABLE books ADD COLUMN path_key TEXT;
      ALTER TABLE books ADD COLUMN library_id TEXT;
      ALTER TABLE books ADD COLUMN part_sizes TEXT;
      ALTER TABLE books ADD COLUMN sample_hash TEXT;
      ALTER TABLE books ADD COLUMN sample_version INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_books_path_key ON books(library_id, path_key);
    `);
    await rewriteBookIdsToUuids(db);
  },
  async (db) => {
    /*
     * What a record needs to be merged with another copy of itself.
     *
     * `updated_at` decides; `writer_device` and `mutation_id` break a tie the
     * clock cannot, so two phones reach the same answer without negotiating.
     * `base_updated_at` is the last state both sides agreed on, which is the
     * only way to tell a two-sided edit from one side being behind.
     *
     * Checkouts get a uuid of their own. They were keyed by an autoincrement
     * rowid, which two phones would assign to different events — so every
     * existing row is given one here, and a book's whole history survives a
     * merge instead of collapsing to whichever side had more.
     */
    await db.execAsync(`
      ALTER TABLE notes ADD COLUMN mutation_id TEXT;
      ALTER TABLE notes ADD COLUMN writer_device TEXT;
      ALTER TABLE notes ADD COLUMN base_updated_at TEXT;
      ALTER TABLE notes ADD COLUMN conflict_of TEXT;

      ALTER TABLE characters ADD COLUMN mutation_id TEXT;
      ALTER TABLE characters ADD COLUMN writer_device TEXT;
      ALTER TABLE characters ADD COLUMN base_updated_at TEXT;

      ALTER TABLE note_characters ADD COLUMN mutation_id TEXT;
      ALTER TABLE note_characters ADD COLUMN writer_device TEXT;

      ALTER TABLE books ADD COLUMN progress_updated_at TEXT;
      ALTER TABLE books ADD COLUMN progress_mutation_id TEXT;
      ALTER TABLE books ADD COLUMN progress_writer_device TEXT;

      ALTER TABLE checkouts ADD COLUMN uuid TEXT;
      ALTER TABLE checkouts ADD COLUMN updated_at TEXT;
      ALTER TABLE checkouts ADD COLUMN deleted_at TEXT;
      ALTER TABLE checkouts ADD COLUMN mutation_id TEXT;
      ALTER TABLE checkouts ADD COLUMN writer_device TEXT;
    `);

    const checkouts = await db.getAllAsync<{ id: number }>(
      'SELECT id FROM checkouts WHERE uuid IS NULL',
    );
    for (const row of checkouts) {
      await db.runAsync('UPDATE checkouts SET uuid = ? WHERE id = ?', newUuid(), row.id);
    }
    await db.execAsync(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_checkouts_uuid ON checkouts(uuid)',
    );
  },
  async (db) => {
    /*
     * How a book should sound.
     *
     * One row per book, plus one with an empty id for the all-books default.
     * "Use all-books default" is the **absence** of a row rather than a flag:
     * with a third state meaning "inheriting", changing the default would
     * have to find and update every book claiming to follow it, and anything
     * that got out of step would be silently wrong.
     */
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS sound_settings (
        book_id TEXT PRIMARY KEY NOT NULL,
        preset  TEXT NOT NULL,
        boost   INTEGER NOT NULL DEFAULT 0,
        clarity INTEGER NOT NULL DEFAULT 0,
        warmth  INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
  async (db) => {
    // Bind pre-identity rows to their original configured root exactly once.
    const root = await db.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'library.root.uri'");
    if (!root?.value) return;
    const saved = await db.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'library.id'");
    const id = saved?.value ?? newUuid();
    await db.runAsync("INSERT OR REPLACE INTO settings VALUES ('library.id', ?)", id);
    await db.runAsync('INSERT OR IGNORE INTO settings VALUES (?, ?)', `library.rootIdentity.${root.value}`, id);
    await db.runAsync('UPDATE books SET library_id = ? WHERE library_id IS NULL', id);
  },
];

export async function migrate(db: SQLite.SQLiteDatabase) {
  await db.execAsync('PRAGMA journal_mode = WAL');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  for (let i = row?.user_version ?? 0; i < MIGRATIONS.length; i += 1) {
    // Bootstrap owns this connection. DDL, references and version commit together.
    await db.execAsync('BEGIN IMMEDIATE');
    try {
      await MIGRATIONS[i](db);
      await db.execAsync(`PRAGMA user_version = ${i + 1}`);
      await db.execAsync('COMMIT');
    } catch (error) {
      await db.execAsync('ROLLBACK');
      throw error;
    }
  }
}
