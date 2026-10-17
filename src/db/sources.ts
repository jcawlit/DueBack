/**
 * The places a library can come from.
 *
 * The USB drive is not one of these rows. It is the implicit source: a book
 * with no `source_id` is a book on the drive, which is what every row written
 * before this table existed already says. `USB_SOURCE` is a stand-in object
 * so the switcher has something to list, not a record.
 *
 * Nothing secret is stored here. `config` holds the server address, the
 * username and which library was chosen — all of it readable from a stolen
 * phone, none of it enough to sign in. The token lives in SecureStore
 * (`src/lib/abs/tokens.ts`); the password is never written anywhere.
 */

import { getDb } from './schema';
import { newUuid } from '@/lib/library/ids';

export type SourceKind = 'usb' | 'abs';

/** What an Audiobookshelf source needs to remember between launches. */
export type AbsConfig = {
  serverUrl: string;
  username: string;
  /** Which of the server's libraries to show. Absent until one is picked. */
  absLibraryId?: string;
  /** Its name, so the UI can say which one without a round trip. */
  absLibraryName?: string;
  /** Last version string the server reported, for the connected summary. */
  serverVersion?: string;
  /**
   * True once a token refresh has failed. The source then asks to be signed
   * into again and stops trying on its own — there is no stored password to
   * retry with, and a loop against a server that keeps saying no is how an
   * account gets locked.
   */
  needsSignIn?: boolean;
};

export type Source = {
  id: string;
  kind: SourceKind;
  label: string;
  config: AbsConfig;
  createdAt: string;
  lastSeenAt: string | null;
};

/**
 * The drive, as the switcher sees it.
 *
 * A constant rather than a row, and its id is never written to `books`.
 */
export const USB_SOURCE_ID = 'usb';

type Row = {
  id: string;
  kind: string;
  label: string;
  config: string;
  created_at: string;
  last_seen_at: string | null;
};

function toSource(row: Row): Source {
  let config: AbsConfig = { serverUrl: '', username: '' };
  try {
    // A row written by a newer version, or half-written by a crash, must not
    // take the whole settings screen down with it.
    config = { ...config, ...(JSON.parse(row.config) as AbsConfig) };
  } catch {
    console.warn(`[sources] unreadable config on ${row.id}`);
  }
  return {
    id: row.id,
    kind: row.kind === 'abs' ? 'abs' : 'usb',
    label: row.label,
    config,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export async function listSources(): Promise<Source[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>('SELECT * FROM sources ORDER BY created_at');
  return rows.map(toSource);
}

export async function getSource(id: string): Promise<Source | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Row>('SELECT * FROM sources WHERE id = ?', id);
  return row ? toSource(row) : null;
}

/** Adds a source and returns it, id and all. */
export async function addSource(
  kind: SourceKind,
  label: string,
  config: AbsConfig,
): Promise<Source> {
  const db = await getDb();
  const id = newUuid();
  const createdAt = new Date().toISOString();
  await db.runAsync(
    'INSERT INTO sources (id, kind, label, config, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL)',
    id, kind, label, JSON.stringify(config), createdAt,
  );
  return { id, kind, label, config, createdAt, lastSeenAt: null };
}

/** Merges into the stored config rather than replacing it. */
export async function updateSourceConfig(
  id: string,
  patch: Partial<AbsConfig>,
): Promise<Source | null> {
  const current = await getSource(id);
  if (!current) return null;
  const config = { ...current.config, ...patch };
  const db = await getDb();
  await db.runAsync('UPDATE sources SET config = ? WHERE id = ?', JSON.stringify(config), id);
  return { ...current, config };
}

export async function renameSource(id: string, label: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE sources SET label = ? WHERE id = ?', label, id);
}

/** Stamps a source as reachable, now. */
export async function touchSource(id: string): Promise<string> {
  const at = new Date().toISOString();
  const db = await getDb();
  await db.runAsync('UPDATE sources SET last_seen_at = ? WHERE id = ?', at, id);
  return at;
}

/**
 * Drops a source and unhooks its books.
 *
 * A hard delete, unlike notes and characters: a source is this phone's own
 * configuration, not something the listener wrote, so there is no other copy
 * of it that a tombstone would have to stop coming back. The books it
 * brought are left in place with their link cleared rather than deleted,
 * because their progress and notes are the listener's and outlive the server
 * they were read from.
 *
 * The caller is responsible for clearing the token — see `forgetToken`.
 */
export async function removeSource(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE books SET source_id = NULL, remote_id = NULL WHERE source_id = ?', id);
  await db.runAsync('DELETE FROM sources WHERE id = ?', id);
}

/** How many books have arrived from a source. Zero until step 2 brings any. */
export async function countBooksFor(id: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM books WHERE source_id = ?',
    id,
  );
  return row?.n ?? 0;
}
