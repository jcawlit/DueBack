/**
 * Book identity.
 *
 * An id is derived from the book's path relative to the library root, so a
 * rescan updates the existing row rather than creating a duplicate. Titles are
 * never used: they change when tags are edited, and two books can share one.
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
 * The id for a book found at `folderRelPath`.
 *
 * A folder that holds exactly one book is identified by its path alone, so
 * renaming or re-tagging the audio inside does not orphan the row. When
 * filename grouping has split one folder into several books, the first file's
 * name is mixed in to tell them apart.
 */
export function bookIdFor(
  folderRelPath: string,
  files: { relPath: string }[],
  options: { split?: boolean } = {},
): string {
  const base = folderRelPath || '.';
  if (!options.split) return fnv1a(base);
  const first = [...files].map((f) => f.relPath).sort()[0] ?? '';
  return fnv1a(`${base}\u0000${first}`);
}

/** A short, human-checkable form for the dev screen. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
