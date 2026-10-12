/**
 * A name for a file we are about to create inside app storage.
 *
 * Numbered so playback order survives on disk, and deliberately stripped of
 * whatever the file was called on the drive. `expo-file-system` builds every
 * local file as `File(URI.create(uri))`, and `java.net.URI` is the strict
 * RFC 2396 parser: it rejects any non-ASCII character and the whole
 * ``[ ] { } | ^ ` " < >`` set, while the JS side only percent-encodes spaces,
 * `%`, `?`, `#` and the control characters. An accented letter or a curly
 * apostrophe in a filename — both commonplace in real audiobooks — therefore
 * failed the entire copy with "Illegal character in path at index N".
 *
 * Nothing reads these names. Part order and every displayed name live in the
 * database, and the drive keeps the originals.
 */

export function safeLocalName(index: number, sourceName: string): string {
  const match = /[.]([A-Za-z0-9]{1,8})$/.exec(sourceName);
  const extension = match ? match[1].toLowerCase() : 'bin';
  return `${String(index).padStart(4, '0')}.${extension}`;
}
