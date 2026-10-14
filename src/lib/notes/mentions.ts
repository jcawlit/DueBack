/**
 * Tagging people in a note by typing `@`.
 *
 * The text is the only record of who a note is about. The `note_characters`
 * rows are derived from it on every save, which is what makes "delete the
 * @mention and the tag goes" true without a second gesture to learn — and why
 * nothing here needs to track an insertion and a deletion separately.
 *
 * Names have spaces in them, so a mention cannot be read as "@ up to the next
 * space". Matching is done against the names this book already knows, longest
 * first, so `@Logen Ninefingers` beats `@Logen` when both exist.
 */

import type { Character } from '@/data/notes';

/** A name typed after `@`, or a name picked from the list, as it is stored. */
export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Every name a character answers to: their own, then any aliases. */
export function namesFor(character: Pick<Character, 'name' | 'aliases'>): string[] {
  const aliases = character.aliases
    .split(',')
    .map((a) => normaliseName(a))
    .filter((a) => a.length > 0);
  return [normaliseName(character.name), ...aliases].filter((n) => n.length > 0);
}

/**
 * The partial mention the cursor is sitting in, if any.
 *
 * Only an `@` that starts a word counts, so an email address in a note is not
 * mistaken for a tag. The query runs to the cursor and may contain spaces,
 * because so do names — but it stops at a line break, and gives up after
 * enough characters that it is plainly not a name being typed.
 */
const MAX_QUERY_LENGTH = 40;

export function mentionQueryAt(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const upto = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  // Must begin a word: the start of the text, or after whitespace.
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (query.includes('\n') || query.length > MAX_QUERY_LENGTH) return null;
  return { start: at, query };
}

/** The characters worth offering for what has been typed so far. */
export function suggestCharacters(query: string, characters: Character[]): Character[] {
  const needle = normaliseName(query).toLowerCase();
  const matches = characters.filter((character) =>
    needle.length === 0
      ? true
      : namesFor(character).some((name) => name.toLowerCase().includes(needle)),
  );
  return matches.sort((a, b) => {
    // A name that starts with what was typed is what was meant.
    const aStarts = a.name.toLowerCase().startsWith(needle);
    const bStarts = b.name.toLowerCase().startsWith(needle);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Replaces the partial mention at the cursor with a whole name, and says
 * where the cursor should land.
 */
export function insertMention(
  text: string,
  cursor: number,
  name: string,
): { text: string; cursor: number } {
  const found = mentionQueryAt(text, cursor);
  const clean = normaliseName(name);
  const start = found ? found.start : Math.max(0, Math.min(cursor, text.length));
  const after = text.slice(found ? cursor : start);
  const inserted = `@${clean} `;
  return {
    text: `${text.slice(0, start)}${inserted}${after}`,
    cursor: start + inserted.length,
  };
}

/**
 * Who a note is about, read back out of what was typed.
 *
 * Longest name first, so a character whose name contains another's is matched
 * whole. Comparison folds case, because dictation capitalises as it pleases.
 */
export function mentionedCharacterIds(text: string, characters: Character[]): string[] {
  const candidates: { id: string; name: string }[] = [];
  for (const character of characters) {
    for (const name of namesFor(character)) {
      candidates.push({ id: character.id, name: name.toLowerCase() });
    }
  }
  candidates.sort((a, b) => b.name.length - a.name.length);

  const haystack = text.toLowerCase();
  const found: string[] = [];
  for (let i = 0; i < haystack.length; i += 1) {
    if (haystack[i] !== '@') continue;
    if (i > 0 && !/\s/.test(haystack[i - 1])) continue;
    for (const candidate of candidates) {
      if (!haystack.startsWith(candidate.name, i + 1)) continue;
      // The name has to end where a word ends, or `@Ann` would match "@Anne".
      const after = haystack[i + 1 + candidate.name.length];
      if (after !== undefined && /[\w'-]/.test(after)) continue;
      if (!found.includes(candidate.id)) found.push(candidate.id);
      break;
    }
  }
  return found;
}
