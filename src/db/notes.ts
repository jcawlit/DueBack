/**
 * Reading and writing the margins.
 *
 * Everything here soft-deletes. These rows are the only part of the database
 * the listener authored — every other table can be rebuilt by rescanning the
 * drive — so a row that goes away has to leave a tombstone behind for a later
 * sync to carry, and for "undo" to have something to bring back.
 */

import type { Character, Note } from '@/data/notes';
import { withLockRetry } from './books';
import { getDb } from './schema';

/** A note's tags are rewritten from its text on every save; see `mentions.ts`. */
type NoteRow = {
  id: string;
  book_id: string;
  position_sec: number;
  chapter_index: number;
  text: string;
  created_at: string;
  updated_at: string;
};

type CharacterRow = {
  id: string;
  book_id: string;
  name: string;
  aliases: string;
  bio: string;
  created_at: string;
  updated_at: string;
};

/**
 * Ids are generated here rather than by the database, because a sync needs
 * them to be unique across devices and `rowid` is not.
 */
export function newId(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand()}${rand()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Every note on a book, in story order, with the characters each one tags. */
export async function loadNotes(bookId: string): Promise<Note[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<NoteRow>(
    `SELECT id, book_id, position_sec, chapter_index, text, created_at, updated_at
       FROM notes WHERE book_id = ? AND deleted_at IS NULL
      ORDER BY position_sec ASC, created_at ASC`,
    bookId,
  );
  const tags = await db.getAllAsync<{ note_id: string; character_id: string }>(
    `SELECT nc.note_id, nc.character_id
       FROM note_characters nc
       JOIN notes n ON n.id = nc.note_id
      WHERE n.book_id = ? AND nc.deleted_at IS NULL AND n.deleted_at IS NULL`,
    bookId,
  );
  const byNote = new Map<string, string[]>();
  for (const tag of tags) {
    const list = byNote.get(tag.note_id);
    if (list) list.push(tag.character_id);
    else byNote.set(tag.note_id, [tag.character_id]);
  }
  return rows.map((row) => ({
    id: row.id,
    bookId: row.book_id,
    positionSec: row.position_sec,
    chapterIndex: row.chapter_index,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    characterIds: byNote.get(row.id) ?? [],
  }));
}

export async function loadCharacters(bookId: string): Promise<Character[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CharacterRow>(
    `SELECT id, book_id, name, aliases, bio, created_at, updated_at
       FROM characters WHERE book_id = ? AND deleted_at IS NULL
      ORDER BY name ASC`,
    bookId,
  );
  return rows.map((row) => ({
    id: row.id,
    bookId: row.book_id,
    name: row.name,
    aliases: row.aliases,
    bio: row.bio,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function insertNote(note: {
  id: string;
  bookId: string;
  positionSec: number;
  chapterIndex: number;
  text: string;
}): Promise<Note> {
  const db = await getDb();
  const at = nowIso();
  await withLockRetry(() =>
    db.runAsync(
      `INSERT INTO notes (id, book_id, position_sec, chapter_index, text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      note.id, note.bookId, note.positionSec, note.chapterIndex, note.text, at, at,
    ),
  );
  return { ...note, createdAt: at, updatedAt: at, characterIds: [] };
}

/**
 * Saves a note's text and the people it mentions together.
 *
 * Tags are replaced wholesale rather than diffed: the text is the record of
 * who a note is about, so anything no longer mentioned is tombstoned and
 * anything mentioned again is revived.
 */
export async function saveNoteText(
  noteId: string,
  text: string,
  characterIds: string[],
): Promise<string> {
  const db = await getDb();
  const at = nowIso();
  await withLockRetry(() =>
    db.withTransactionAsync(async () => {
      await db.runAsync('UPDATE notes SET text = ?, updated_at = ? WHERE id = ?', text, at, noteId);
      await db.runAsync(
        'UPDATE note_characters SET deleted_at = ?, updated_at = ? WHERE note_id = ? AND deleted_at IS NULL',
        at, at, noteId,
      );
      for (const characterId of characterIds) {
        await db.runAsync(
          `INSERT INTO note_characters (note_id, character_id, updated_at, deleted_at)
           VALUES (?, ?, ?, NULL)
           ON CONFLICT(note_id, character_id)
             DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at`,
          noteId, characterId, at,
        );
      }
    }),
  );
  return at;
}

export async function softDeleteNote(noteId: string): Promise<void> {
  const db = await getDb();
  const at = nowIso();
  await withLockRetry(() =>
    db.runAsync('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?', at, at, noteId),
  );
}

/** Brings a note back exactly as it was; its tags were never touched. */
export async function restoreNote(noteId: string): Promise<void> {
  const db = await getDb();
  const at = nowIso();
  await withLockRetry(() =>
    db.runAsync('UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ?', at, noteId),
  );
}

export async function insertCharacter(character: {
  id: string;
  bookId: string;
  name: string;
  aliases?: string;
  bio?: string;
}): Promise<Character> {
  const db = await getDb();
  const at = nowIso();
  const row = {
    aliases: character.aliases ?? '',
    bio: character.bio ?? '',
  };
  await withLockRetry(() =>
    db.runAsync(
      `INSERT INTO characters (id, book_id, name, aliases, bio, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      character.id, character.bookId, character.name, row.aliases, row.bio, at, at,
    ),
  );
  return { ...character, ...row, createdAt: at, updatedAt: at };
}

export async function saveCharacter(
  characterId: string,
  fields: { name: string; aliases: string; bio: string },
): Promise<void> {
  const db = await getDb();
  const at = nowIso();
  await withLockRetry(() =>
    db.runAsync(
      'UPDATE characters SET name = ?, aliases = ?, bio = ?, updated_at = ? WHERE id = ?',
      fields.name, fields.aliases, fields.bio, at, characterId,
    ),
  );
}

/**
 * Removes a character and every tag pointing at it — but not the notes.
 *
 * A note is a thing the listener wrote; the tag is only an index into it.
 * Deleting the index must never take the writing with it.
 */
export async function softDeleteCharacter(characterId: string): Promise<void> {
  const db = await getDb();
  const at = nowIso();
  await withLockRetry(() =>
    db.withTransactionAsync(async () => {
      await db.runAsync(
        'UPDATE characters SET deleted_at = ?, updated_at = ? WHERE id = ?',
        at, at, characterId,
      );
      await db.runAsync(
        'UPDATE note_characters SET deleted_at = ?, updated_at = ? WHERE character_id = ? AND deleted_at IS NULL',
        at, at, characterId,
      );
    }),
  );
}

/** How much a book would lose if it were forgotten. */
export type MarginCounts = { notes: number; characters: number };

export async function countMarginsFor(bookIds: string[]): Promise<MarginCounts> {
  if (bookIds.length === 0) return { notes: 0, characters: 0 };
  const db = await getDb();
  const holes = bookIds.map(() => '?').join(',');
  const notes = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL AND book_id IN (${holes})`,
    ...bookIds,
  );
  const characters = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM characters WHERE deleted_at IS NULL AND book_id IN (${holes})`,
    ...bookIds,
  );
  return { notes: notes?.n ?? 0, characters: characters?.n ?? 0 };
}
