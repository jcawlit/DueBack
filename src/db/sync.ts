/**
 * The database side of the drive backup: everything a person made, out, and
 * a merged set back in.
 *
 * Only authored data travels. Titles, durations, covers and part lists are
 * all rebuildable by rescanning the drive the backup sits on, so carrying
 * them would be carrying a worse copy of something already there. What cannot
 * be rebuilt is where someone is in a book, when they had it out, and what
 * they wrote — and that is exactly the promise restore makes.
 */

import {
  type BookIdentityRecord,
  type CharacterRecord,
  type HistoryRecord,
  type NoteRecord,
  type ProgressRecord,
  type ShelfBookRecord,
  type ShelfRecord,
  type SyncPayload,
  type TagRecord,
} from '@/lib/sync/records';
import { getDb } from './schema';
import { withLockRetry } from './books';
import { ensureDeviceId } from './identity';

/** A write's identity, stamped on every record it touches. */
export type Writer = { device: string; at: string };

export async function writerNow(): Promise<Writer> {
  return { device: await ensureDeviceId(), at: new Date().toISOString() };
}

/** Everything this phone would put on the drive. */
async function collectAllPayload(): Promise<SyncPayload> {
  const db = await getDb();
  const device = await ensureDeviceId();

  /*
   * A record written before syncing existed has no stamp. Rather than
   * rewriting the database to add one, the gaps are filled as it is read:
   * this device is as good a claim as any to having written it, and the row's
   * own `updated_at` is when.
   */
  const notes = await db.getAllAsync<{
    id: string; book_id: string; position_sec: number; chapter_index: number;
    text: string; created_at: string; updated_at: string; deleted_at: string | null;
    mutation_id: string | null; writer_device: string | null;
    base_updated_at: string | null; conflict_of: string | null;
  }>(
    `SELECT id, book_id, position_sec, chapter_index, text, created_at, updated_at,
            deleted_at, mutation_id, writer_device, base_updated_at, conflict_of
       FROM notes`,
  );

  const characters = await db.getAllAsync<{
    id: string; book_id: string; name: string; aliases: string; bio: string;
    created_at: string; updated_at: string; deleted_at: string | null;
    mutation_id: string | null; writer_device: string | null; base_updated_at: string | null;
  }>(
    `SELECT id, book_id, name, aliases, bio, created_at, updated_at, deleted_at,
            mutation_id, writer_device, base_updated_at
       FROM characters`,
  );

  const tags = await db.getAllAsync<{
    note_id: string; character_id: string; updated_at: string; deleted_at: string | null;
    mutation_id: string | null; writer_device: string | null;
  }>(
    `SELECT note_id, character_id, updated_at, deleted_at, mutation_id, writer_device
       FROM note_characters`,
  );

  const progress = await db.getAllAsync<{
    id: string; progress_sec: number; finished_at: string | null;
    progress_updated_at: string | null; progress_mutation_id: string | null;
    progress_writer_device: string | null; last_played_at: string | null;
  }>(
    `SELECT id, progress_sec, finished_at, progress_updated_at, progress_mutation_id,
            progress_writer_device, last_played_at
       FROM books
      WHERE progress_updated_at IS NOT NULL OR progress_sec > 0 OR finished_at IS NOT NULL`,
  );

  const identity = await db.getAllAsync<{
    id: string; path_key: string | null; title: string; author: string | null;
    size_bytes: number; duration_sec: number; part_sizes: string | null;
    sample_hash: string | null; last_scanned_at: string | null;
  }>(
    `SELECT id, path_key, title, author, size_bytes, duration_sec, part_sizes,
            sample_hash, last_scanned_at
       FROM books WHERE path_key IS NOT NULL`,
  );

  const history = await db.getAllAsync<{
    uuid: string | null; book_id: string; out_at: string; back_at: string | null;
    updated_at: string | null; deleted_at: string | null;
    mutation_id: string | null; writer_device: string | null;
  }>(
    `SELECT uuid, book_id, out_at, back_at, updated_at, deleted_at, mutation_id, writer_device
       FROM checkouts WHERE uuid IS NOT NULL`,
  );

  const shelfRows = await db.getAllAsync<{
    id: string; source_id: string | null; name: string; position: number;
    created_at: string; updated_at: string; deleted_at: string | null;
    mutation_id: string | null; writer_device: string | null;
    base_updated_at: string | null;
  }>(
    `SELECT id, source_id, name, position, created_at, updated_at, deleted_at,
            mutation_id, writer_device, base_updated_at
       FROM shelves`,
  );

  const shelfBookRows = await db.getAllAsync<{
    book_id: string; shelf_id: string; position: number;
    updated_at: string; deleted_at: string | null;
    mutation_id: string | null; writer_device: string | null;
    base_updated_at: string | null;
  }>(
    `SELECT book_id, shelf_id, position, updated_at, deleted_at,
            mutation_id, writer_device, base_updated_at
       FROM shelf_books`,
  );

  return {
    identity: identity.map<BookIdentityRecord>((r) => {
      let partSizes: number[] = [];
      try {
        const parsed = r.part_sizes ? JSON.parse(r.part_sizes) : [];
        if (Array.isArray(parsed)) partSizes = parsed.filter((n) => typeof n === 'number');
      } catch {
        partSizes = [];
      }
      // Dated by when the book was last read off the drive: identity only
      // changes when a scan changes it, so that is exactly its age.
      const at = r.last_scanned_at ?? '1970-01-01T00:00:00.000Z';
      return {
        id: r.id,
        pathKey: r.path_key!,
        title: r.title,
        author: r.author ?? '',
        sizeBytes: r.size_bytes,
        durationSec: r.duration_sec,
        partSizes,
        sampleHash: r.sample_hash,
        updatedAt: at,
        mutationId: at,
        writerDevice: device,
      };
    }),
    notes: notes.map<NoteRecord>((r) => ({
      id: r.id,
      bookId: r.book_id,
      positionSec: r.position_sec,
      chapterIndex: r.chapter_index,
      text: r.text,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
      mutationId: r.mutation_id ?? r.updated_at,
      writerDevice: r.writer_device ?? device,
      baseUpdatedAt: r.base_updated_at,
      conflictOf: r.conflict_of,
    })),
    characters: characters.map<CharacterRecord>((r) => ({
      id: r.id,
      bookId: r.book_id,
      name: r.name,
      aliases: r.aliases,
      bio: r.bio,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
      mutationId: r.mutation_id ?? r.updated_at,
      writerDevice: r.writer_device ?? device,
      baseUpdatedAt: r.base_updated_at,
    })),
    tags: tags.map<TagRecord>((r) => ({
      noteId: r.note_id,
      characterId: r.character_id,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
      mutationId: r.mutation_id ?? r.updated_at,
      writerDevice: r.writer_device ?? device,
    })),
    progress: progress.map<ProgressRecord>((r) => ({
      bookId: r.id,
      positionSec: r.progress_sec,
      finishedAt: r.finished_at,
      // A position saved before syncing existed is dated by when it was last
      // played, which is the closest thing to the truth available.
      updatedAt: r.progress_updated_at ?? r.last_played_at ?? '1970-01-01T00:00:00.000Z',
      mutationId: r.progress_mutation_id ?? r.progress_updated_at ?? r.id,
      writerDevice: r.progress_writer_device ?? device,
    })),
    history: history.map<HistoryRecord>((r) => ({
      id: r.uuid!,
      bookId: r.book_id,
      outAt: r.out_at,
      backAt: r.back_at,
      updatedAt: r.updated_at ?? r.back_at ?? r.out_at,
      deletedAt: r.deleted_at,
      mutationId: r.mutation_id ?? r.out_at,
      writerDevice: r.writer_device ?? device,
    })),
    shelves: shelfRows.map<ShelfRecord>((r) => ({
      id: r.id,
      sourceId: r.source_id,
      name: r.name,
      position: r.position,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
      mutationId: r.mutation_id ?? r.updated_at,
      writerDevice: r.writer_device ?? device,
      baseUpdatedAt: r.base_updated_at,
    })),
    shelfBooks: shelfBookRows.map<ShelfBookRecord>((r) => ({
      bookId: r.book_id,
      shelfId: r.shelf_id,
      position: r.position,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
      mutationId: r.mutation_id ?? r.updated_at,
      writerDevice: r.writer_device ?? device,
      baseUpdatedAt: r.base_updated_at,
    })),
  };
}

/** What changed on this phone as a result of taking the merged set in. */
export type ApplyReport = {
  notes: number;
  characters: number;
  tags: number;
  progress: number;
  history: number;
  shelves: number;
  shelfBooks: number;
};

/**
 * Writes a merged set back.
 *
 * Only records whose books this phone knows about are applied. A drive can
 * hold the margins of books that were deleted from it, or that this phone has
 * not scanned yet, and writing those in would put notes on nothing — they
 * stay on the drive, and arrive if the book ever does.
 *
 * One transaction, so a merge is all-or-nothing: half a merge applied is a
 * state neither side ever had.
 */
export async function applyPayload(payload: SyncPayload): Promise<ApplyReport> {
  const db = await getDb();
  const known = new Set(
    (await db.getAllAsync<{ id: string }>('SELECT id FROM books')).map((r) => r.id),
  );
  const report: ApplyReport = {
    notes: 0, characters: 0, tags: 0, progress: 0, history: 0, shelves: 0, shelfBooks: 0,
  };

  await withLockRetry(() =>
    db.withTransactionAsync(async () => {
      for (const note of payload.notes) {
        if (!known.has(note.bookId)) continue;
        await db.runAsync(
          `INSERT INTO notes (id, book_id, position_sec, chapter_index, text, created_at,
                              updated_at, deleted_at, mutation_id, writer_device,
                              base_updated_at, conflict_of)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             position_sec = excluded.position_sec,
             chapter_index = excluded.chapter_index,
             text = excluded.text,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             mutation_id = excluded.mutation_id,
             writer_device = excluded.writer_device,
             base_updated_at = excluded.base_updated_at,
             conflict_of = excluded.conflict_of
           WHERE (excluded.updated_at, excluded.writer_device, excluded.mutation_id) >= (notes.updated_at, COALESCE(notes.writer_device, ''), COALESCE(notes.mutation_id, ''))`,
          note.id, note.bookId, note.positionSec, note.chapterIndex, note.text,
          note.createdAt, note.updatedAt, note.deletedAt ?? null, note.mutationId,
          note.writerDevice, note.baseUpdatedAt ?? null, note.conflictOf ?? null,
        );
        report.notes += 1;
      }

      for (const character of payload.characters) {
        if (!known.has(character.bookId)) continue;
        await db.runAsync(
          `INSERT INTO characters (id, book_id, name, aliases, bio, created_at,
                                   updated_at, deleted_at, mutation_id, writer_device,
                                   base_updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             aliases = excluded.aliases,
             bio = excluded.bio,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             mutation_id = excluded.mutation_id,
             writer_device = excluded.writer_device,
             base_updated_at = excluded.base_updated_at
           WHERE (excluded.updated_at, excluded.writer_device, excluded.mutation_id) >= (characters.updated_at, COALESCE(characters.writer_device, ''), COALESCE(characters.mutation_id, ''))`,
          character.id, character.bookId, character.name, character.aliases, character.bio,
          character.createdAt, character.updatedAt, character.deletedAt ?? null,
          character.mutationId, character.writerDevice, character.baseUpdatedAt ?? null,
        );
        report.characters += 1;
      }

      for (const tag of payload.tags) {
        await db.runAsync(
          `INSERT INTO note_characters (note_id, character_id, updated_at, deleted_at,
                                        mutation_id, writer_device)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(note_id, character_id) DO UPDATE SET
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             mutation_id = excluded.mutation_id,
             writer_device = excluded.writer_device
           WHERE (excluded.updated_at, excluded.writer_device, excluded.mutation_id) >= (note_characters.updated_at, COALESCE(note_characters.writer_device, ''), COALESCE(note_characters.mutation_id, ''))`,
          tag.noteId, tag.characterId, tag.updatedAt, tag.deletedAt ?? null,
          tag.mutationId, tag.writerDevice,
        );
        report.tags += 1;
      }

      for (const entry of payload.progress) {
        if (!known.has(entry.bookId)) continue;
        await db.runAsync(
          `UPDATE books SET
             progress_sec = ?, finished_at = ?,
             progress_updated_at = ?, progress_mutation_id = ?, progress_writer_device = ?
           WHERE id = ? AND (progress_updated_at IS NULL OR
             (progress_updated_at, COALESCE(progress_writer_device, ''), COALESCE(progress_mutation_id, '')) <= (?, ?, ?))`,
          entry.positionSec, entry.finishedAt ?? null, entry.updatedAt,
          entry.mutationId, entry.writerDevice, entry.bookId, entry.updatedAt, entry.writerDevice, entry.mutationId,
        );
        report.progress += 1;
      }

      for (const event of payload.history) {
        if (!known.has(event.bookId)) continue;
        await db.runAsync(
          `INSERT INTO checkouts (uuid, book_id, out_at, back_at, updated_at, deleted_at,
                                  mutation_id, writer_device)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(uuid) DO UPDATE SET
             out_at = excluded.out_at,
             back_at = excluded.back_at,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             mutation_id = excluded.mutation_id,
             writer_device = excluded.writer_device
           WHERE (excluded.updated_at, excluded.writer_device, excluded.mutation_id) >= (checkouts.updated_at, COALESCE(checkouts.writer_device, ''), COALESCE(checkouts.mutation_id, ''))`,
          event.id, event.bookId, event.outAt, event.backAt ?? null,
          event.updatedAt, event.deletedAt ?? null, event.mutationId, event.writerDevice,
        );
        report.history += 1;
      }

      /*
       * Shelves are not filtered by `known`, unlike everything above.
       *
       * A note needs its book, or it is a note about nothing. A shelf is a
       * name and an order, and it is perfectly sensible to receive
       * "Re-reads" before the scan that finds the books belonging on it —
       * which is exactly the order a fresh install does things in. An empty
       * shelf that fills up later beats a shelf thrown away for arriving
       * early.
       */
      for (const shelf of payload.shelves) {
        await db.runAsync(
          `INSERT INTO shelves (id, source_id, name, position, created_at,
                                updated_at, deleted_at, mutation_id, writer_device,
                                base_updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             source_id = excluded.source_id,
             name = excluded.name,
             position = excluded.position,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             mutation_id = excluded.mutation_id,
             writer_device = excluded.writer_device,
             base_updated_at = excluded.base_updated_at
           WHERE (excluded.updated_at, excluded.writer_device, excluded.mutation_id) >= (shelves.updated_at, COALESCE(shelves.writer_device, ''), COALESCE(shelves.mutation_id, ''))`,
          shelf.id, shelf.sourceId, shelf.name, shelf.position, shelf.createdAt,
          shelf.updatedAt, shelf.deletedAt ?? null, shelf.mutationId,
          shelf.writerDevice, shelf.baseUpdatedAt ?? null,
        );
        report.shelves += 1;
      }

      // An assignment does need its book: it says where that book goes.
      for (const placed of payload.shelfBooks) {
        if (!known.has(placed.bookId)) continue;
        await db.runAsync(
          `INSERT INTO shelf_books (book_id, shelf_id, position, updated_at,
                                    deleted_at, mutation_id, writer_device,
                                    base_updated_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(book_id) DO UPDATE SET
             shelf_id = excluded.shelf_id,
             position = excluded.position,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             mutation_id = excluded.mutation_id,
             writer_device = excluded.writer_device,
             base_updated_at = excluded.base_updated_at
           WHERE (excluded.updated_at, excluded.writer_device, excluded.mutation_id) >= (shelf_books.updated_at, COALESCE(shelf_books.writer_device, ''), COALESCE(shelf_books.mutation_id, ''))`,
          placed.bookId, placed.shelfId, placed.position, placed.updatedAt,
          placed.deletedAt ?? null, placed.mutationId, placed.writerDevice,
          placed.baseUpdatedAt ?? null,
        );
        report.shelfBooks += 1;
      }
    }),
  );

  return report;
}

/**
 * Records that the drive and this phone now agree, for every record written.
 *
 * This is what makes a two-sided edit detectable later: without a remembered
 * agreement there is no way to tell "both of us changed this" from "one of us
 * is behind", and the app would either lose writing or litter the margins
 * with copies.
 */
export async function markSynced(payload: SyncPayload): Promise<void> {
  const db = await getDb();
  await withLockRetry(() =>
    db.withTransactionAsync(async () => {
      for (const note of payload.notes) {
        await db.runAsync(
          'UPDATE notes SET base_updated_at = ? WHERE id = ? AND updated_at = ? AND mutation_id = ?',
          note.updatedAt, note.id, note.updatedAt, note.mutationId,
        );
      }
      for (const character of payload.characters) {
        await db.runAsync(
          'UPDATE characters SET base_updated_at = ? WHERE id = ? AND updated_at = ? AND mutation_id = ?',
          character.updatedAt, character.id, character.updatedAt, character.mutationId,
        );
      }
    }),
  );
}

/**
 * Whether anything written since the last backup is still only on the phone.
 *
 * Computed rather than tracked. A flag set on every write is one more thing
 * to get wrong — missed on a path nobody thought about, or left true by a
 * crash — whereas comparing timestamps is self-correcting and costs one
 * query at the moment the answer is actually wanted.
 */
export async function isBackupPending(lastBackupAt: string | null): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ newest: string | null }>(
    `SELECT MAX(at) AS newest FROM (
       SELECT MAX(updated_at) AS at FROM notes
       UNION ALL SELECT MAX(updated_at) FROM characters
       UNION ALL SELECT MAX(updated_at) FROM note_characters
       UNION ALL SELECT MAX(updated_at) FROM checkouts
       UNION ALL SELECT MAX(progress_updated_at) FROM books
     )`,
  );
  const newest = row?.newest ?? null;
  if (!newest) return false;
  if (!lastBackupAt) return true;
  return newest > lastBackupAt;
}

/** A backup belongs to one library, even when the phone remembers several drives. */
export async function collectPayload(libraryId?: string): Promise<SyncPayload> {
  const payload = await collectAllPayload();
  if (!libraryId) return payload;
  const db = await getDb();
  const ids = new Set((await db.getAllAsync<{ id: string }>('SELECT id FROM books WHERE library_id = ?', libraryId)).map((b) => b.id));
  const notes = payload.notes.filter((n) => ids.has(n.bookId));
  const characters = payload.characters.filter((c) => ids.has(c.bookId));
  const noteIds = new Set(notes.map((n) => n.id));
  const characterIds = new Set(characters.map((c) => c.id));
  return { identity: payload.identity.filter((b) => ids.has(b.id)), notes, characters,
    tags: payload.tags.filter((t) => noteIds.has(t.noteId) && characterIds.has(t.characterId)),
    progress: payload.progress.filter((p) => ids.has(p.bookId)),
    history: payload.history.filter((h) => ids.has(h.bookId)),
    /*
     * Shelves travel whole; their assignments are scoped like everything
     * else.
     *
     * A shelf belongs to a *source*, and a source can be an Audiobookshelf
     * server, which has no drive and no `library_id`. The drive is the only
     * durable store this app has, so a server's shelves ride in the drive's
     * backup or they are lost on reinstall — and losing them is the thing
     * syncing them was for.
     *
     * The assignments are filtered by book, so a shelf whose books are not
     * in this library simply arrives empty rather than arriving wrong. The
     * wrinkle that leaves: with two drives, each backup carries the other's
     * shelf names, so an empty shelf could surface in the wrong library.
     * One phone and one drive is the only arrangement that has ever existed
     * here, and an empty shelf is a tidier failure than a lost one.
     */
    shelves: payload.shelves,
    shelfBooks: payload.shelfBooks.filter((sb) => ids.has(sb.bookId)) };
}
