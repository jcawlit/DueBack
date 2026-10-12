/**
 * Cover thumbnails.
 *
 * A real cover is 100 KB–2 MB. We write the full image out once, downscale it
 * to something a shelf can use, then delete the original. Nothing holds the
 * full-size bytes beyond the moment it takes to do that.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { coverUri, deleteCover, writeCoverBytes } from './access';

/** Long side of the stored thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 400;

export type CoverSource = 'folder-image' | 'embedded' | 'none';

export type StoredCover = {
  /** File name within the covers directory. */
  fileName: string;
  uri: string;
  source: CoverSource;
  bytes: number;
};

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
  // a file whose name tells it nothing, which silently loses the artwork.
  const scratchName = `${bookId}.src.${extensionFor(raw)}`;
  const finalName = `${bookId}.jpg`;

  const scratchUri = writeCoverBytes(scratchName, raw);
  if (!scratchUri) return null;

  try {
    const context = ImageManipulator.manipulate(scratchUri);
    context.resize({ width: THUMBNAIL_SIZE });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: 0.8,
    });

    // Move the result to a stable name inside the covers directory.
    const target = new File(coverUri(finalName));
    if (target.exists) target.delete();
    const produced = new File(saved.uri);
    produced.move(target);

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
      const kept = writeCoverBytes(finalName, raw);
      if (kept) {
        return { fileName: finalName, uri: kept, source, bytes: raw.length };
      }
    }
    return null;
  } finally {
    deleteCover(scratchName);
  }
}

export function removeCover(bookId: string) {
  deleteCover(`${bookId}.jpg`);
}
