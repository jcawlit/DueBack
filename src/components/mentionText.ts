/**
 * Reading the names back out of what someone typed.
 *
 * A note is stored as the listener wrote it, `@Dorothea` and all, with the
 * ids kept alongside. Showing it means finding those names again, and
 * copying a note into a bio means taking them out — a biography that says
 * "@Dorothea is her sister" is quoting the input box rather than the book.
 */

import type { Character } from '@/data/notes';
import { namesFor } from '@/lib/notes/mentions';

export type Segment = { text: string; characterId?: string };

/**
 * Splits a note into plain text and the names written into it.
 *
 * The same rule `mentionedCharacterIds` matches by — longest name first, so
 * a name containing another is matched whole; case folded, because dictation
 * capitalises as it pleases; and the name must end where a word ends, or
 * `@Ann` would light up inside "@Anne".
 */
export function mentionSegments(text: string, characters: Character[]): Segment[] {
  const candidates: { id: string; name: string }[] = [];
  for (const character of characters) {
    for (const name of namesFor(character)) {
      candidates.push({ id: character.id, name: name.toLowerCase() });
    }
  }
  candidates.sort((a, b) => b.name.length - a.name.length);

  const lower = text.toLowerCase();
  const out: Segment[] = [];
  let plain = '';

  for (let i = 0; i < text.length; ) {
    const atStart = lower[i] === '@' && (i === 0 || /\s/.test(lower[i - 1]));
    const hit = atStart
      ? candidates.find((candidate) => {
          if (!lower.startsWith(candidate.name, i + 1)) return false;
          const after = lower[i + 1 + candidate.name.length];
          return after === undefined || !/[\w'-]/.test(after);
        })
      : undefined;

    if (!hit) {
      plain += text[i];
      i += 1;
      continue;
    }

    if (plain) {
      out.push({ text: plain });
      plain = '';
    }
    const end = i + 1 + hit.name.length;
    // Written without the @: the colour is what says it is a name now.
    out.push({ text: text.slice(i + 1, end), characterId: hit.id });
    i = end;
  }

  if (plain) out.push({ text: plain });
  return out;
}

/**
 * A note, rewritten as prose for somebody's biography.
 *
 * Whole mentions become the character's own name — the full one, not the
 * alias that happened to be typed, because a bio is read on its own later.
 * A half-finished `@Ros` that never matched anyone is dropped rather than
 * left in: it was a search that went nowhere, not something written.
 */
export function bioTextFrom(text: string, characters: Character[]): string {
  const byId = new Map(characters.map((c) => [c.id, c]));
  const joined = mentionSegments(text, characters)
    .map((segment) =>
      segment.characterId ? (byId.get(segment.characterId)?.name ?? segment.text) : segment.text,
    )
    .join('');

  // Anything still carrying an @ never resolved to anybody.
  return joined
    .replace(/(^|\s)@[\w'-]*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
