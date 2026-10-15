/**
 * A name for a file we are about to create inside app storage.
 *
 * Numbered, and deliberately stripped of whatever the file was called on the
 * drive: a local path goes through `java.net.URI`, which rejects non-ASCII and
 * much of the punctuation real audiobook filenames carry. `npm run kb ascii`.
 *
 * Nothing reads these names — part order and every displayed name live in the
 * database, and the drive keeps the originals.
 */

export function safeLocalName(index: number, sourceName: string): string {
  const match = /[.]([A-Za-z0-9]{1,8})$/.exec(sourceName);
  const extension = match ? match[1].toLowerCase() : 'bin';
  return `${String(index).padStart(4, '0')}.${extension}`;
}

/** A migrated book keeps its existing directory; UUIDs are not filesystem addresses. */
export function localFolderId(path: string, root: 'books' | 'imported'): string | null {
  const parts = path.split('/');
  return parts[0] === root && /^[a-zA-Z0-9_-]+$/.test(parts[1] ?? '') ? parts[1] : null;
}
