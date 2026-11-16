/**
 * Turning Storage Access Framework document ids into names a person can read.
 *
 * SAF's `name` is the document id, not a display name. On a USB volume that is
 * `BC72-B058:Some Folder`, and nested it is `BC72-B058:Some Folder/Disc 1`. On
 * primary storage the prefix is followed by a path, so splitting on `/` alone
 * hides the problem — which is why it only shows up on a real removable drive.
 *
 * Kept free of imports so it can be unit tested outside React Native.
 */

/**
 * Takes the last path segment, then drops a leading `volume:` prefix. A volume
 * id is `primary`, `home`, or a serial like `BC72-B058`; `:` cannot appear in a
 * file name on the filesystems these drives use, so this is unambiguous.
 */
/**
 * Whether a library root lives on the phone's own storage rather than on
 * something that can be unplugged.
 *
 * This decides whether the library needs checking out at all. A library the
 * phone always has is just a library: copying each book into app storage to
 * play it would store every file twice, which is the opposite of what this app
 * is for.
 *
 * Only built-in storage counts. A memory card is usually left in, but it is
 * still removable, and a library on one is a drive in every sense that
 * matters here.
 */
export function isDeviceStorage(rootUri: string): boolean {
  const uri = decodeURIComponent(rootUri);

  // SAF tree URIs carry the volume as a prefix: `primary:Audiobooks` is
  // built-in storage, `BC72-B058:Audiobooks` is a card or a stick.
  const tree = /\/tree\/([^/:]+):/.exec(uri);
  if (tree) return tree[1].toLowerCase() === 'primary';

  if (uri.startsWith('file://')) {
    const path = uri.slice('file://'.length);
    return (
      path.startsWith('/data/') ||
      path.startsWith('/storage/emulated/') ||
      path.startsWith('/storage/self/')
    );
  }
  return false;
}

/**
 * Where a folder sits inside its volume — `Audiobooks/Fiction`.
 *
 * `safDisplayName` gives the last segment, which is what a header wants. This
 * gives the path, which is what someone being told where all their books are
 * kept wants: "in Fiction" could be anywhere, and a tree URI's own text is a
 * volume id and percent-escapes.
 *
 * Empty when the URI carries no volume to read, so a caller falls back to the
 * name the picker gave.
 */
export function safFolderPath(rootUri: string): string {
  const uri = decodeURIComponent(rootUri);
  const tree = /\/tree\/([^/]+?):([^?]*)/.exec(uri);
  if (!tree) return '';
  const [, volume, path] = tree;
  const trimmed = path.replace(/\/+$/, '');
  // A bare `VOLUME:` is the volume's own root, and has no path below it.
  return trimmed || volume;
}

export function safDisplayName(rawName: string): string {
  const lastSegment = rawName.slice(rawName.lastIndexOf('/') + 1);
  const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(lastSegment);
  if (!match) return lastSegment;
  const [, volume, rest] = match;
  // A bare `VOLUME:` is the drive's own root; show the volume id itself.
  return rest.length > 0 ? rest : volume;
}
