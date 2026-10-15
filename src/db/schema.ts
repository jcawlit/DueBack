/**
 * The database. Every per-book fact lives here and nowhere else — cover path,
 * USB location, parts, chapters, local copy state and playback progress are all
 * columns, so there is never a second place to reconcile.
 */

import * as SQLite from 'expo-sqlite';
import { migrate } from './migrations';
import { newUuid } from '@/lib/library/ids';

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
      try { await migrate(db); } catch (error) { await db.closeAsync(); throw error; }
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

/**
 * This library's identity, minted on first use.
 *
 * Kept in settings rather than derived from the root's URI, because the URI
 * is exactly the thing that changes when a drive is remounted or re-picked.
 */
export async function ensureLibraryId(): Promise<string> {
  const existing = await getSetting(SETTING_KEYS.libraryId);
  if (existing) return existing;
  const id = newUuid();
  await setSetting(SETTING_KEYS.libraryId, id);
  return id;
}

/** Adopts a library id found on a drive, so both sides agree who it is. */
export async function adoptLibraryId(id: string): Promise<void> {
  await setSetting(SETTING_KEYS.libraryId, id);
}

/**
 * This phone, for settling which of two writers was later.
 *
 * Lives here, with the other settings, so that neither `books.ts` nor
 * `identity.ts` has to import the other to stamp a record.
 */
export async function ensureDeviceId(): Promise<string> {
  const existing = await getSetting(SETTING_KEYS.deviceId);
  if (existing) return existing;
  const id = newUuid();
  await setSetting(SETTING_KEYS.deviceId, id);
  return id;
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
  /** This library's identity, which outlives the path it is reached through. */
  libraryId: 'library.id',
  /** This phone, for deciding who wrote a record when two devices disagree. */
  deviceId: 'device.id',
  /** Whether reading data is copied to the drive. */
  backupEnabled: 'backup.enabled',
  /** When the drive last took a complete copy. */
  backupAt: 'backup.at',
} as const;
