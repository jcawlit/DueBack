/**
 * Cover thumbnails.
 *
 * A real cover is 100 KB–2 MB. We write the full image out once, downscale it
 * to something a shelf can use, then delete the original. Nothing holds the
 * full-size bytes beyond the moment it takes to do that.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { coverUri, deleteCover, deleteCoversFor, writeCoverBytes } from './access';

/** Long side of the stored thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 400;

/**
 * Where the artwork came from. `remote` is a server's cover endpoint, which
 * arrives as bytes over an authenticated request and is cached here like any
 * other — the app never points an image at a URL it would have to put a
 * token in.
 */
export type CoverSource = 'folder-image' | 'embedded' | 'remote' | 'none';

export type StoredCover = {
  /** File name within the covers directory. */
  fileName: string;
  uri: string;
  source: CoverSource;
  bytes: number;
};

/**
 * A short signature of the artwork, which becomes part of the thumbnail's name.
 *
 * Covers used to be stored at one fixed path per book, and Android's image
 * pipeline caches by URI without consulting the file's timestamp — so a cover
 * that had been *corrected* went on rendering from the old bitmap for the rest
 * of the session. A name that changes with the artwork makes that impossible,
 * and one that changes *only* with the artwork means a rescan that finds the
 * same picture does not churn the file or the row.
 *
 * Sampled rather than hashed whole: a few hundred kilobytes per book across a
 * few hundred books is real time, and the cost of a collision here is a cover
 * that looks stale — exactly the thing that was already happening.
 */
function coverToken(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(bytes.length / 2048));
  for (let i = 0; i < bytes.length; i += step) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= bytes.length & 0xff;
  h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Picks a file extension the platform image decoder will recognise. */
function extensionFor(bytes: Uint8Array): string {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return 'jpg';
}

/**
 * Downscales and stores an image, returning the thumbnail's location.
 *
 * The raw bytes are written to a scratch file because the image manipulator
 * works from URIs; that scratch file is removed before returning, so only the
 * thumbnail survives.
 */
export async function storeCover(
  bookId: string,
  raw: Uint8Array,
  source: Exclude<CoverSource, 'none'>,
): Promise<StoredCover | null> {
  // The scratch file needs a real extension: Android's image decoder can refuse
  // a file whose name tells it nothing, which silently loses the artwork. Its
  // name deliberately does not begin with the book's id, so that sweeping a
  // book's old thumbnails cannot delete the file being worked on.
  const scratchName = `scratch-${bookId}.${extensionFor(raw)}`;
  const finalName = `${bookId}.${coverToken(raw)}.jpg`;

  const scratchUri = await writeCoverBytes(scratchName, raw);
  if (!scratchUri) return null;

  try {
    const context = ImageManipulator.manipulate(scratchUri);
    context.resize({ width: THUMBNAIL_SIZE });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: 0.8,
    });

    /*
     * Move the result to a stable name inside the covers directory. Awaited:
     * `move` returns a promise, and reading `target.size` before it resolved
     * recorded a cover of nothing.
     */
    const target = new File(coverUri(finalName));
    const produced = new File(saved.uri);
    await produced.move(target, { overwrite: true });
    // Anything this book used to look like is now dead weight.
    deleteCoversFor(bookId, finalName);

    return {
      fileName: finalName,
      uri: target.uri,
      source,
      bytes: target.size ?? 0,
    };
  } catch {
    // Resizing failed — keep the original rather than losing the artwork. A
    // full-size cover in the cache is wasteful but far better than a book with
    // no picture, and real covers top out around 2 MB.
    if (raw.length <= 3 * 1024 * 1024) {
      const kept = await writeCoverBytes(finalName, raw);
      if (kept) {
        deleteCoversFor(bookId, finalName);
        return { fileName: finalName, uri: kept, source, bytes: raw.length };
      }
    }
    return null;
  } finally {
    deleteCover(scratchName);
  }
}

export function removeCover(bookId: string) {
  deleteCoversFor(bookId);
}
