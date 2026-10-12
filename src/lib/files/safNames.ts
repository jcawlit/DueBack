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
export function safDisplayName(rawName: string): string {
  const lastSegment = rawName.slice(rawName.lastIndexOf('/') + 1);
  const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(lastSegment);
  if (!match) return lastSegment;
  const [, volume, rest] = match;
  // A bare `VOLUME:` is the drive's own root; show the volume id itself.
  return rest.length > 0 ? rest : volume;
}
