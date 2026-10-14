/**
 * The margins: notes the listener writes while a book plays, and the people
 * those notes are about.
 *
 * A note with empty text is a bookmark. There is deliberately no second type
 * and no flag — a bookmark that gets typed into becomes a note, and a note
 * emptied back out becomes a bookmark again, with no state to migrate between
 * the two.
 */

export type Note = {
  id: string;
  bookId: string;
  /** Where in the book it was taken, in seconds. */
  positionSec: number;
  /** Derived from `positionSec` when the note is made, and kept. */
  chapterIndex: number;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** Ids of the characters this note is tagged with. */
  characterIds: string[];
};

export type Character = {
  id: string;
  bookId: string;
  name: string;
  /** Other names the same person goes by, comma separated. */
  aliases: string;
  bio: string;
  createdAt: string;
  updatedAt: string;
};

/** A note with nothing written in it is a bookmark. */
export function isBookmark(note: Pick<Note, 'text'>): boolean {
  return note.text.trim().length === 0;
}

/**
 * How far back a bookmark lands from where the tap happened.
 *
 * By the time someone reaches for the button, the thing worth marking has
 * already been said.
 */
export const BOOKMARK_LOOKBACK_SEC = 10;

/** Where a bookmark tapped at `positionSec` should actually be recorded. */
export function bookmarkPositionFor(positionSec: number): number {
  return Math.max(0, positionSec - BOOKMARK_LOOKBACK_SEC);
}

/**
 * Which chapter a position falls in.
 *
 * The same rule as `chapterAt`, over a bare chapter list, so it can be used
 * without a whole book — and so it can be tested without building one. A book
 * with no chapter marks is one chapter, which is what the listener has.
 */
export function chapterIndexFor(
  chapters: { startSec: number }[],
  positionSec: number,
): number {
  if (chapters.length === 0) return 0;
  let index = 0;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].startSec <= positionSec) index = i;
    else break;
  }
  return index;
}

/**
 * The earliest position among the notes tagging a character — "first heard".
 *
 * Null when the character has no notes yet, which sorts them last rather than
 * pretending they turn up at the start.
 */
export function firstHeardSec(characterId: string, notes: Note[]): number | null {
  let earliest: number | null = null;
  for (const note of notes) {
    if (!note.characterIds.includes(characterId)) continue;
    if (earliest === null || note.positionSec < earliest) earliest = note.positionSec;
  }
  return earliest;
}

/** How many notes tag a character. */
export function noteCountFor(characterId: string, notes: Note[]): number {
  return notes.filter((n) => n.characterIds.includes(characterId)).length;
}

/**
 * Characters in the order the listener met them, with the ones they have not
 * written about yet at the end.
 */
export function charactersByFirstHeard(characters: Character[], notes: Note[]): Character[] {
  return [...characters].sort((a, b) => {
    const left = firstHeardSec(a.id, notes);
    const right = firstHeardSec(b.id, notes);
    if (left === null && right === null) return a.name.localeCompare(b.name);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left !== right) return left - right;
    return a.name.localeCompare(b.name);
  });
}

/** The notes tagging a character, in the order they happen in the book. */
export function notesForCharacter(characterId: string, notes: Note[]): Note[] {
  return notes
    .filter((n) => n.characterIds.includes(characterId))
    .sort((a, b) => a.positionSec - b.positionSec);
}

export type ChapterGroup = {
  chapterIndex: number;
  title: string;
  notes: Note[];
};

/**
 * Notes gathered under their chapter, in story order, skipping chapters
 * nothing was written in.
 */
export function groupNotesByChapter(
  notes: Note[],
  chapters: { title: string; startSec: number }[],
  bookTitle: string,
): ChapterGroup[] {
  const groups = new Map<number, Note[]>();
  for (const note of notes) {
    const list = groups.get(note.chapterIndex);
    if (list) list.push(note);
    else groups.set(note.chapterIndex, [note]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chapterIndex, list]) => ({
      chapterIndex,
      title: chapters[chapterIndex]?.title ?? bookTitle,
      notes: [...list].sort((a, b) => a.positionSec - b.positionSec),
    }));
}

/**
 * Appending a note to a bio, as the character card's "add to bio" does.
 *
 * Separated by a blank line, and a bio that already contains the sentence is
 * left alone — tapping twice is the easiest mistake to make on a small card.
 */
export function bioWith(bio: string, addition: string): string {
  const add = addition.trim();
  if (add.length === 0) return bio;
  const existing = bio.trim();
  if (existing.length === 0) return add;
  if (existing.includes(add)) return existing;
  return `${existing}\n\n${add}`;
}
