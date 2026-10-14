/**
 * Where a book is, and who it is.
 *
 * These two were the same thing once: a book's id was a hash of its path, so
 * the row followed the folder. Renaming the folder made a stranger of a book
 * someone was halfway through. Identity is now a uuid — see
 * `src/lib/library/identity.ts` — and what remains here is the **path key**:
 * the thing a scan uses to find the row for a folder it has just walked.
 *
 * Titles are still never used for either. They change when tags are edited,
 * and two books can share one.
 */

/** FNV-1a, 32-bit, rendered as hex. Stable across runs and platforms. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The key a scan looks a book up by: where it was found.
 *
 * A folder holding one book is keyed by its path alone, so re-tagging the
 * audio inside does not orphan the row. When the album-tag rule has split one
 * folder into several books, the first file's name is mixed in to tell them
 * apart.
 *
 * This is a lookup, not an identity. A folder that has been renamed has a new
 * key and no row; finding the book it used to hold is `planReconnection`.
 */
export function pathKeyFor(
  folderRelPath: string,
  files: { relPath: string }[],
  options: { split?: boolean } = {},
): string {
  const base = folderRelPath || '.';
  if (!options.split) return fnv1a(base);
  const first = [...files].map((f) => f.relPath).sort()[0] ?? '';
  return fnv1a(`${base}\u0000${first}`);
}

/**
 * A fresh identity, for a book or a library.
 *
 * Not `crypto.randomUUID`: Hermes does not provide it. Random enough that two
 * devices writing to the same drive will not collide, which is the only
 * uniqueness this has to guarantee.
 */
export function newUuid(): string {
  const chunk = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${Date.now().toString(36)}-${chunk()}-${chunk()}-${chunk()}`;
}

/** A short, human-checkable form for the dev screen. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
