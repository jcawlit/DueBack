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
