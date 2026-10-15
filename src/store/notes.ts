/**
 * The margins for the book currently open.
 *
 * Held per book and reloaded when another is opened, because a note sheet and
 * a character index only ever concern one book at a time, and keeping the
 * whole library's notes in memory would be a lot of someone's writing for no
 * reason.
 *
 * Typing autosaves. The debounce exists so a sentence is not written to SQLite
 * once per keystroke, not to decide *whether* it is saved — every way out of
 * the sheet flushes, including the app going to the background, because a note
 * taken while walking is exactly the one most likely to be interrupted.
 */

import { readingDataChanged } from '@/lib/sync/changes';
import { create } from 'zustand';
import {
  bioWith,
  bookmarkPositionFor,
  chapterIndexFor,
  type Character,
  type Note,
} from '@/data/notes';
import {
  countMarginsFor,
  insertCharacter,
  insertNote,
  loadCharacters,
  loadNotes,
  newId,
  restoreNote,
  saveCharacter,
  saveNoteText,
  softDeleteCharacter,
  softDeleteNote,
} from '@/db/notes';
import { createAutosave } from '@/lib/notes/autosave';
import { mentionedCharacterIds, normaliseName } from '@/lib/notes/mentions';

/** Long enough that a sentence is one write, short enough to feel safe. */
const AUTOSAVE_MS = 700;

type NotesState = {
  /** The book these notes belong to, or null before anything is loaded. */
  bookId: string | null;
  notes: Note[];
  characters: Character[];
  loading: boolean;
  /** The last note deleted, kept so it can be put back. */
  undoable: Note | null;

  load: (bookId: string) => Promise<void>;
  /** Drops what is held, for a book that has gone. */
  forget: (bookId: string) => void;

  /** Saves a bookmark at the given position and returns it. */
  addBookmark: (
    bookId: string,
    positionSec: number,
    chapters: { startSec: number }[],
  ) => Promise<Note | null>;

  /** Records typing. Saved after a pause, or on the next `flush`. */
  setNoteText: (noteId: string, text: string) => void;
  /** Writes anything still pending, now. */
  flush: () => Promise<void>;

  deleteNote: (noteId: string) => Promise<void>;
  undoDelete: () => Promise<void>;
  clearUndo: () => void;

  addCharacter: (bookId: string, name: string, bio?: string) => Promise<Character | null>;
  updateCharacter: (
    characterId: string,
    fields: { name: string; aliases: string; bio: string },
  ) => Promise<void>;
  deleteCharacter: (characterId: string) => Promise<void>;
  /** Appends a note's words to a character's bio. */
  addToBio: (characterId: string, text: string) => Promise<void>;
};

export const useNotes = create<NotesState>((set, get) => {
  const revisions = new Map<string, number>();
  /** Writes one note's pending text, with the tags read back out of it. */
  const writeNote = async (noteId: string, text: string) => {
    const characterIds = mentionedCharacterIds(text, get().characters);
    const at = await saveNoteText(noteId, text, characterIds);
    set((s) => ({
      notes: s.notes.map((n) =>
        n.id === noteId && n.text === text ? { ...n, characterIds, updatedAt: at } : n,
      ),
    }));
  };

  const autosave = createAutosave(writeNote, AUTOSAVE_MS, (err) =>
    console.warn('[dueback] a note could not be saved:', err),
  );

  const flushPending = () => autosave.flush();

  return {
    bookId: null,
    notes: [],
    characters: [],
    loading: false,
    undoable: null,

    load: async (bookId) => {
      // Whatever is half-typed belongs to the book being left, not the one
      // being opened.
      await flushPending();
      const sameBook = get().bookId === bookId;
      const atLoad = new Map(revisions);
      set({ bookId, loading: true, ...(sameBook ? {} : { undoable: null }) });
      try {
        const [notes, characters] = await Promise.all([
          loadNotes(bookId),
          loadCharacters(bookId),
        ]);
        // Another book may have been opened while this was reading.
        if (get().bookId !== bookId) return;
        const current = new Map(get().notes.map((n) => [n.id, n]));
        set({ notes: notes.map((n) => revisions.get(n.id) !== atLoad.get(n.id) ? current.get(n.id) ?? n : n), characters, loading: false });
      } catch (err) {
        if (get().bookId === bookId) set({ loading: false });
        console.warn('[dueback] the margins could not be read:', err);
      }
    },

    forget: (bookId) => {
      if (get().bookId !== bookId) return;
      set({ bookId: null, notes: [], characters: [], undoable: null });
    },

    addBookmark: async (bookId, positionSec, chapters) => {
      const at = bookmarkPositionFor(positionSec);
      try {
        const note = await insertNote({
          id: newId(),
          bookId,
          positionSec: at,
          chapterIndex: chapterIndexFor(chapters, at),
          text: '',
        });
        if (get().bookId === bookId) {
          set((s) => ({
            notes: [...s.notes, note].sort((x, y) => x.positionSec - y.positionSec),
          }));
        }
        return note;
      } catch (err) {
        console.warn('[dueback] the bookmark could not be saved:', err);
        return null;
      }
    },

    setNoteText: (noteId, text) => {
      revisions.set(noteId, (revisions.get(noteId) ?? 0) + 1);
      readingDataChanged();
      // On screen at once; on disk shortly. The note in the list is the one
      // the sheet renders from, so this cannot wait for SQLite.
      set((s) => ({ notes: s.notes.map((n) => (n.id === noteId ? { ...n, text } : n)) }));
      autosave.queue(noteId, text);
    },

    flush: flushPending,

    deleteNote: async (noteId) => {
      await flushPending();
      const note = get().notes.find((n) => n.id === noteId);
      if (!note) return;
      set((s) => ({ notes: s.notes.filter((n) => n.id !== noteId), undoable: note }));
      try {
        await softDeleteNote(noteId);
      } catch (err) {
        set((s) => ({
          notes: [...s.notes, note].sort((x, y) => x.positionSec - y.positionSec),
          undoable: null,
        }));
        console.warn('[dueback] the note could not be deleted:', err);
      }
    },

    undoDelete: async () => {
      const note = get().undoable;
      if (!note) return;
      set((s) => ({
        notes: [...s.notes, note].sort((x, y) => x.positionSec - y.positionSec),
        undoable: null,
      }));
      try {
        await restoreNote(note.id);
      } catch (err) {
        console.warn('[dueback] the note could not be put back:', err);
      }
    },

    clearUndo: () => set({ undoable: null }),

    addCharacter: async (bookId, name, bio) => {
      const clean = normaliseName(name);
      if (clean.length === 0) return null;
      try {
        const character = await insertCharacter({ id: newId(), bookId, name: clean, bio });
        if (get().bookId === bookId) {
          set((s) => ({
            characters: [...s.characters, character].sort((a, b) =>
              a.name.localeCompare(b.name),
            ),
          }));
        }
        return character;
      } catch (err) {
        console.warn('[dueback] the character could not be saved:', err);
        return null;
      }
    },

    updateCharacter: async (characterId, fields) => {
      const clean = { ...fields, name: normaliseName(fields.name) };
      if (clean.name.length === 0) return;
      set((s) => ({
        characters: s.characters
          .map((c) => (c.id === characterId ? { ...c, ...clean } : c))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }));
      try {
        await saveCharacter(characterId, clean);
      } catch (err) {
        console.warn('[dueback] the character could not be saved:', err);
      }
    },

    deleteCharacter: async (characterId) => {
      // The notes stay. Only the tags pointing at this person go, which is why
      // the note list is rewritten rather than filtered.
      set((s) => ({
        characters: s.characters.filter((c) => c.id !== characterId),
        notes: s.notes.map((n) =>
          n.characterIds.includes(characterId)
            ? { ...n, characterIds: n.characterIds.filter((id) => id !== characterId) }
            : n,
        ),
      }));
      try {
        await softDeleteCharacter(characterId);
      } catch (err) {
        console.warn('[dueback] the character could not be removed:', err);
      }
    },

    addToBio: async (characterId, text) => {
      const character = get().characters.find((c) => c.id === characterId);
      if (!character) return;
      const bio = bioWith(character.bio, text);
      if (bio === character.bio) return;
      await get().updateCharacter(characterId, {
        name: character.name,
        aliases: character.aliases,
        bio,
      });
    },
  };
});

/** How much writing a set of books holds, for the warning before forgetting them. */
export { countMarginsFor };
