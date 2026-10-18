/**
 * Books that live on a server.
 *
 * A remote book **is** its `(source_id, remote_id)` pair. The local `id` is a
 * uuid minted the first time the book is seen and never changes after that,
 * which is what lets progress, notes, characters and checkout history attach
 * to it exactly as they do for a book on the drive — the same tables, the
 * same columns, no second concept of a note.
 *
 * The refresh diff is the server's own `updatedAt`, kept verbatim in its own
 * milliseconds. Comparing our mapped fields instead would mean trusting that
 * we mapped all of them, which is the one assumption a diff must not make.
 */

import type { Chapter } from '@/data/types';
import type { AbsCatalogueEntry, AbsDetail } from '@/lib/abs/map';
import { getDb } from './schema';
import { newUuid } from '@/lib/library/ids';

/*
 * Re-exported so a caller that already has this module does not need to know
 * the rule lives elsewhere. It lives elsewhere because it is pure, and
 * reaching it should not mean loading expo-sqlite — which is exactly what
 * importing this file does.
 */
export { chooseProgress } from '@/lib/abs/progress';

export type CatalogueChange = {
  added: number;
  updated: number;
  unchanged: number;
  /** On the server before, gone from it now, and kept here as missing. */
  missing: number;
  /** Was missing, and the server has it again. */
  returned: number;
  total: number;
};

type ExistingRow = {
  id: string;
  remote_id: string;
  remote_updated_at: number | null;
  missing: number;
};

/**
 * Writes a whole catalogue for one source.
 *
 * `entries` is the complete list as the server gave it: anything absent from
 * it is treated as gone. A partial list would mark the rest of the library
 * missing, so a caller that could not finish reading every page must not
 * call this at all.
 */
export async function upsertCatalogue(
  sourceId: string,
  entries: AbsCatalogueEntry[],
): Promise<CatalogueChange> {
  const db = await getDb();
  const change: CatalogueChange = {
    added: 0, updated: 0, unchanged: 0, missing: 0, returned: 0, total: entries.length,
  };

  await db.withExclusiveTransactionAsync(async (txn) => {
    const existing = await txn.getAllAsync<ExistingRow>(
      'SELECT id, remote_id, remote_updated_at, missing FROM books WHERE source_id = ?',
      sourceId,
    );
    const byRemote = new Map(existing.map((row) => [row.remote_id, row]));
    const seen = new Set<string>();

    for (const entry of entries) {
      seen.add(entry.remoteId);
      const row = byRemote.get(entry.remoteId);
      const genres = entry.genres.length > 0 ? JSON.stringify(entry.genres) : null;

      if (!row) {
        await txn.runAsync(
          `INSERT INTO books (
             id, folder_rel_path, raw_folder_name, title, author, narrator,
             title_source, author_source, duration_sec, size_bytes,
             series, genres, missing, source_id, remote_id, remote_updated_at,
             last_scanned_at
           ) VALUES (?,?,?,?,?,?,'server','server',?,?,?,?,?,?,?,?,?)`,
          newUuid(),
          entry.relPath,
          entry.relPath || entry.title,
          entry.title,
          entry.author || null,
          entry.narrator || null,
          entry.durationSec,
          entry.sizeBytes,
          entry.series || null,
          genres,
          entry.isMissing ? 1 : 0,
          sourceId,
          entry.remoteId,
          entry.updatedAt,
          new Date().toISOString(),
        );
        change.added += 1;
        continue;
      }

      const wasMissing = row.missing === 1;
      const nowMissing = entry.isMissing;
      // The server's stamp has not moved and the book is in the same state,
      // so there is nothing to write. On a library of several hundred books
      // re-read often, this is almost every book.
      if (row.remote_updated_at === entry.updatedAt && wasMissing === nowMissing) {
        change.unchanged += 1;
        continue;
      }

      await txn.runAsync(
        `UPDATE books SET
           folder_rel_path   = ?,
           title             = ?,
           author            = ?,
           narrator          = ?,
           duration_sec      = ?,
           size_bytes        = ?,
           series            = ?,
           genres            = ?,
           missing           = ?,
           remote_updated_at = ?,
           last_scanned_at   = ?,
           -- The cached detail described the previous version of this book.
           remote_detail     = NULL,
           remote_detail_at  = NULL
         WHERE id = ?`,
        entry.relPath,
        entry.title,
        entry.author || null,
        entry.narrator || null,
        entry.durationSec,
        entry.sizeBytes,
        entry.series || null,
        genres,
        nowMissing ? 1 : 0,
        entry.updatedAt,
        new Date().toISOString(),
        row.id,
      );
      if (wasMissing && !nowMissing) change.returned += 1;
      else change.updated += 1;
    }

    /*
     * Gone from the server: marked, never deleted.
     *
     * This mirrors what a USB scan does with a book that has left the drive.
     * The row carries the listener's progress, notes and history, none of
     * which the server ever had, so removing it would throw away the only
     * copy of the part that was theirs.
     */
    const vanished = existing.filter((row) => !seen.has(row.remote_id) && row.missing !== 1);
    for (const row of vanished) {
      await txn.runAsync('UPDATE books SET missing = 1 WHERE id = ?', row.id);
    }
    change.missing = vanished.length;
  });

  return change;
}

/** The local row for a book on a server, by the pair that identifies it. */
export async function findRemoteBook(
  sourceId: string,
  remoteId: string,
): Promise<{ id: string } | null> {
  const db = await getDb();
  return db.getFirstAsync<{ id: string }>(
    'SELECT id FROM books WHERE source_id = ? AND remote_id = ?',
    sourceId,
    remoteId,
  );
}

/** The expanded record as it last arrived, for a book opened offline. */
export async function loadRemoteDetail(
  bookId: string,
): Promise<{ json: string; at: string } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ remote_detail: string | null; remote_detail_at: string | null }>(
    'SELECT remote_detail, remote_detail_at FROM books WHERE id = ?',
    bookId,
  );
  if (!row?.remote_detail) return null;
  return { json: row.remote_detail, at: row.remote_detail_at ?? '' };
}

/**
 * Stores what an expanded fetch found: the chapters, the sizes, and the
 * record itself for the next time the server cannot be reached.
 */
export async function saveRemoteDetail(
  bookId: string,
  detail: AbsDetail,
  raw: unknown,
): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `UPDATE books SET
         remote_detail       = ?,
         remote_detail_at    = ?,
         chapters_from_parts = ?,
         duration_sec        = CASE WHEN ? > 0 THEN ? ELSE duration_sec END,
         size_bytes          = CASE WHEN ? > 0 THEN ? ELSE size_bytes END
       WHERE id = ?`,
      JSON.stringify(raw),
      new Date().toISOString(),
      detail.chaptersFromParts ? 1 : 0,
      detail.durationSec, detail.durationSec,
      detail.sizeBytes, detail.sizeBytes,
      bookId,
    );
    await writeChapters(txn, bookId, detail.chapters);
  });
}

type Runner = { runAsync: (sql: string, ...args: (string | number | null)[]) => Promise<unknown> };

/** Replaces a book's chapters wholesale — they are derived, never authored. */
async function writeChapters(txn: Runner, bookId: string, chapters: Chapter[]) {
  await txn.runAsync('DELETE FROM chapters WHERE book_id = ?', bookId);
  for (let i = 0; i < chapters.length; i += 1) {
    await txn.runAsync(
      'INSERT INTO chapters (book_id, idx, title, start_sec) VALUES (?,?,?,?)',
      bookId, i, chapters[i].title, chapters[i].startSec,
    );
  }
}

/** Points a book at a cover file already written to the local cache. */
export async function setRemoteCover(bookId: string, fileName: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE books SET cover_file = ?, cover_source = 'remote' WHERE id = ?",
    fileName,
    bookId,
  );
}

/** Books from a source that have no cover cached yet. */
export async function remoteBooksNeedingCovers(
  sourceId: string,
): Promise<{ id: string; remote_id: string }[]> {
  const db = await getDb();
  return db.getAllAsync<{ id: string; remote_id: string }>(
    'SELECT id, remote_id FROM books WHERE source_id = ? AND cover_file IS NULL AND missing = 0',
    sourceId,
  );
}

/**
 * Takes the server's position, because it is the newer of the two.
 *
 * `progress_updated_at` is stamped with the server's own `lastUpdate`
 * translated to ISO, not with now. Stamping it with now would make this
 * phone look like the most recent writer to the next device that compared,
 * and the two would hand the position back and forth for ever.
 */
export async function adoptServerProgress(
  bookId: string,
  positionSec: number,
  serverLastUpdateMs: number,
  isFinished: boolean,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE books SET
       progress_sec         = ?,
       progress_updated_at  = ?,
       finished_at          = CASE WHEN ? = 1 THEN COALESCE(finished_at, ?) ELSE finished_at END
     WHERE id = ?`,
    positionSec,
    new Date(serverLastUpdateMs).toISOString(),
    isFinished ? 1 : 0,
    new Date(serverLastUpdateMs).toISOString(),
    bookId,
  );
}

/** What this phone last recorded for a book, for deciding which side wins. */
export async function localProgress(
  bookId: string,
): Promise<{ positionSec: number; updatedAt: string | null } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ progress_sec: number; progress_updated_at: string | null }>(
    'SELECT progress_sec, progress_updated_at FROM books WHERE id = ?',
    bookId,
  );
  if (!row) return null;
  return { positionSec: row.progress_sec, updatedAt: row.progress_updated_at };
}

/**
 * Writes the audio files of a remote book as `parts` rows.
 *
 * A book from a server has no parts until it is checked out: the catalogue
 * knows how long it is, not what it is made of. These rows are what the
 * player reads, so they have to exist before playback and have to carry the
 * same columns a scanned book's parts do.
 *
 * `uri` is deliberately not a fetchable address. For a book on the drive it
 * is where the audio lives; for this one the audio lives at a URL whose ino
 * changes under us, and a stored one would be a trap for exactly the code
 * that must never reuse it. The local path is what plays.
 */
export async function setRemoteParts(
  bookId: string,
  remoteId: string,
  parts: {
    name: string;
    sizeBytes: number;
    durationSec: number;
    startSec: number;
    trackNumber?: number;
    localRelPath: string;
  }[],
): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM parts WHERE book_id = ?', bookId);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      await txn.runAsync(
        `INSERT INTO parts
           (book_id, idx, rel_path, name, uri, size_bytes, modified_ms,
            duration_sec, start_sec, track_number, local_rel_path)
         VALUES (?,?,?,?,?,?,0,?,?,?,?)`,
        bookId,
        i,
        part.name,
        part.name,
        `abs:${remoteId}#${i}`,
        part.sizeBytes,
        part.durationSec,
        part.startSec,
        part.trackNumber ?? i + 1,
        part.localRelPath,
      );
    }
  });
}

/** What the progress pusher needs to know about a book, in one read. */
export async function remotePlace(bookId: string): Promise<{
  remoteId: string;
  sourceId: string;
  positionSec: number;
  updatedAt: string | null;
  durationSec: number;
  isFinished: boolean;
} | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    remote_id: string | null;
    source_id: string | null;
    progress_sec: number;
    progress_updated_at: string | null;
    duration_sec: number;
    finished_at: string | null;
  }>(
    `SELECT remote_id, source_id, progress_sec, progress_updated_at, duration_sec, finished_at
       FROM books WHERE id = ?`,
    bookId,
  );
  if (!row?.remote_id || !row.source_id) return null;
  return {
    remoteId: row.remote_id,
    sourceId: row.source_id,
    positionSec: row.progress_sec,
    updatedAt: row.progress_updated_at,
    durationSec: row.duration_sec,
    isFinished: row.finished_at !== null,
  };
}
