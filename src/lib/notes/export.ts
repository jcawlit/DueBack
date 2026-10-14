/**
 * The margins as something to keep: a plain-text page of everything written
 * about one book, for the share sheet.
 *
 * Markdown, because it reads perfectly well as plain text in a message and
 * turns into headings anywhere that understands it. Always free — this is the
 * listener's own writing and they can always have it back.
 */

import {
  charactersByFirstHeard,
  firstHeardSec,
  groupNotesByChapter,
  isBookmark,
  noteCountFor,
  type Character,
  type Note,
} from '../../data/notes.ts';
import { namesFor } from './mentions.ts';
import { timestamp } from '../format.ts';

export type ExportInput = {
  title: string;
  author: string;
  chapters: { title: string; startSec: number }[];
  notes: Note[];
  characters: Character[];
  /** Whether to include the Who's who section. */
  includeCharacters: boolean;
};

/** The names of the characters a note is tagged with, in the book's order. */
function tagsFor(note: Note, characters: Character[]): string[] {
  return characters.filter((c) => note.characterIds.includes(c.id)).map((c) => c.name);
}

export function exportNotes({
  title,
  author,
  chapters,
  notes,
  characters,
  includeCharacters,
}: ExportInput): string {
  const lines: string[] = [`# ${title}`];
  if (author.trim().length > 0) lines.push(author);

  const groups = groupNotesByChapter(notes, chapters, title);
  if (groups.length === 0) {
    lines.push('', '_No notes yet._');
  }

  for (const group of groups) {
    lines.push('', `## ${group.title}`, '');
    for (const note of group.notes) {
      const at = timestamp(note.positionSec);
      if (isBookmark(note)) {
        lines.push(`- **${at}** — bookmark`);
      } else {
        // Indented so a note running to several lines stays inside its bullet.
        const body = note.text.trim().split('\n').join('\n  ');
        lines.push(`- **${at}** — ${body}`);
      }
      const tags = tagsFor(note, characters);
      if (tags.length > 0) lines.push(`  _${tags.join(', ')}_`);
    }
  }

  if (includeCharacters && characters.length > 0) {
    lines.push('', "## Who's who");
    for (const character of charactersByFirstHeard(characters, notes)) {
      const aliases = namesFor(character).slice(1);
      lines.push('', `### ${character.name}`);
      if (aliases.length > 0) lines.push(`_also ${aliases.join(', ')}_`);

      const heard = firstHeardSec(character.id, notes);
      const count = noteCountFor(character.id, notes);
      const facts = [
        heard === null ? 'not heard yet' : `first heard ${timestamp(heard)}`,
        `${count} ${count === 1 ? 'note' : 'notes'}`,
      ];
      lines.push(facts.join(' · '));

      if (character.bio.trim().length > 0) lines.push('', character.bio.trim());
    }
  }

  return `${lines.join('\n')}\n`;
}
