/**
 * The expo-file-system adapter for the metadata parser's `ByteReader`.
 *
 * `FileHandle` is seekable (`offset` has a setter) and works over SAF
 * `content://` URIs, so the same parser that runs on Node in the spike runs
 * unchanged on the device — no native module, and the same code path on iOS.
 */

import { File, FileMode } from 'expo-file-system';
import { CachingReader, DEFAULT_BLOCK_SIZE, type ByteReader } from './reader.ts';

/**
 * Opens a seekable reader over a file. `uri` may be a `file://` path or an
 * Android SAF `content://` URI from the directory picker.
 */
export function openReader(uri: string, blockSize = DEFAULT_BLOCK_SIZE): ByteReader {
  const file = new File(uri);
  // SAF content:// URIs reject ReadWrite, and scanning never writes.
  const handle = file.open(FileMode.ReadOnly);

  return new CachingReader(
    {
      async size() {
        return handle.size ?? file.size ?? 0;
      },
      async read(offset: number, length: number) {
        handle.offset = offset;
        return handle.readBytes(length);
      },
      async close() {
        handle.close();
      },
    },
    blockSize,
  );
}

/** Audio extensions we index. Deliberately no ebook formats. */
export const AUDIO_EXTENSIONS = ['.m4b', '.m4a', '.mp3', '.aac', '.ogg', '.opus', '.flac'];

export function isAudioFile(name: string) {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
