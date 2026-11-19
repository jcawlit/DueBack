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

/**
 * The sources the app has. A removed one is tombstoned, not deleted, and must
 * never appear in the switcher, in Settings, or as something to refresh.
 */
export async function listSources(): Promise<Source[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    'SELECT * FROM sources WHERE removed_at IS NULL ORDER BY created_at',
  );
  return rows.map(toSource);
}

export async function getSource(id: string): Promise<Source | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Row>(
    'SELECT * FROM sources WHERE id = ? AND removed_at IS NULL',
    id,
  );
  return row ? toSource(row) : null;
}

/**
 * Adds a source and returns it, id and all — or brings back the one that was
 * removed.
 *
 * Signing into a server that was removed earlier **revives its row** rather
 * than making a new one, matched on the server and the account. That is what
 * makes removal recoverable: the books kept their `source_id`, so reviving the
 * row reattaches every one of them with its place, its notes and its card
 * history, and nothing is duplicated.
 *
 * Matched on `(kind, serverUrl, username)` rather than the label, which is
 * only a name and which the listener may have changed.
 */
export async function addSource(
  kind: SourceKind,
  label: string,
  config: AbsConfig,
): Promise<Source> {
  const db = await getDb();
  const createdAt = new Date().toISOString();

  const removed = await db.getFirstAsync<Row>(
    `SELECT * FROM sources
      WHERE removed_at IS NOT NULL AND kind = ?
        AND json_extract(config, '$.serverUrl') = ?
        AND json_extract(config, '$.username') = ?
      ORDER BY removed_at DESC`,
    kind, config.serverUrl, config.username,
  );

  if (removed) {
    // The label and config are whatever was just entered; the id, and so
    // every book pointing at it, is the one from before.
    await db.runAsync(
      'UPDATE sources SET removed_at = NULL, label = ?, config = ?, last_seen_at = NULL WHERE id = ?',
      label, JSON.stringify(config), removed.id,
    );
    return { id: removed.id, kind, label, config, createdAt: removed.created_at, lastSeenAt: null };
  }

  const id = newUuid();
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
 * Tombstones a source, keeping the books it brought attached to it.
 *
 * **This used to orphan them**, and it is worth knowing why that was wrong
 * because the reasoning behind it was right. Books holding a place or a note
 * were kept, because those are the listener's and outlive the server — but
 * they were kept with `source_id = NULL, remote_id = NULL, missing = 1`, and
 * `source_id IS NULL` **is** the definition of a book on the USB drive. So
 * every kept book turned into a drive book: it appeared on the drive's shelf,
 * the next scan stamped it "not on drive", and `forgetMissingBooks` — which
 * selects exactly `missing = 1 AND source_id IS NULL` — offered to delete it
 * beside genuinely missing books with no way to tell them apart. Clearing
 * `remote_id` then guaranteed a duplicate, because that was the only link by
 * which signing in again could have recognised the book.
 *
 * So the row is tombstoned instead and the books are left exactly as they
 * are. They belong to a source that is not currently signed into, which is a
 * different thing from a book missing off a drive, and `addSource` revives
 * the row when the same server is signed into again — at which point every
 * book comes back attached to it, with everything written against it.
 *
 * Books that hold nothing of the listener's are still deleted outright: there
 * is nothing in them to protect, and keeping them would mean a shelf of
 * unplayable entries for a server nobody is signed into.
 *
 * The caller is responsible for clearing the token — see `forgetToken`.
 */
export async function removeSource(id: string): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    /*
     * A book whose server has gone, and which holds nothing of the
     * listener's, is not worth keeping. It used to be kept — the row was
     * simply unhooked — and the result was a ghost: no source, no files,
     * no way to tell it from a book on the drive, sitting on the drive's
     * own shelf and refusing to play because it has no audio. Removing
     * and re-adding a server left one per book, and then a second copy of
     * every book beside it.
     */
    await txn.runAsync(
      `DELETE FROM books
        WHERE source_id = ?
          AND local_status = 'on-shelf'
          AND progress_sec = 0
          AND finished_at IS NULL
          AND id NOT IN (SELECT book_id FROM checkouts)
          AND id NOT IN (SELECT book_id FROM notes WHERE deleted_at IS NULL)
          AND id NOT IN (SELECT book_id FROM characters WHERE deleted_at IS NULL)`,
      id,
    );
    /*
     * Everything still here holds something of the listener's and keeps its
     * `source_id` and `remote_id` untouched. That is the whole fix: the books
     * stay out of the drive's business, and the link that lets them be
     * recognised on the way back in survives.
     */
    await txn.runAsync(
      'UPDATE sources SET removed_at = ? WHERE id = ?',
      new Date().toISOString(),
      id,
    );
  });
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
