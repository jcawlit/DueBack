/**
 * One entry point for reading a file's metadata, dispatching on extension.
 *
 * v1 supports `.m4b`, `.m4a` and `.mp3` only. Other audio extensions are
 * counted and skipped by the scanner rather than half-parsed.
 */

import type { ByteReader } from './reader.ts';
import { readMp4Metadata, type ParsedChapter, type ReadOptions } from './mp4.ts';
import { readMp3Metadata } from './mp3.ts';

export type { ParsedChapter, ReadOptions };

/** Extensions the scanner will index. */
export const SUPPORTED_EXTENSIONS = ['.m4b', '.m4a', '.mp3'] as const;

/**
 * Audio we recognise but deliberately do not support in v1, so the scanner can
 * report "12 files skipped" rather than silently ignoring them.
 */
export const UNSUPPORTED_AUDIO_EXTENSIONS = [
  '.aac', '.ogg', '.opus', '.flac', '.wav', '.wma', '.alac', '.m4p',
] as const;

/** Audible's own containers, which are encrypted and cannot be played. */
export const DRM_EXTENSIONS = ['.aa', '.aax'] as const;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function isSupportedAudio(name: string) {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

export function isUnsupportedAudio(name: string) {
  return (UNSUPPORTED_AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

export function isDrmContainer(name: string) {
  return (DRM_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/** Everything a scan needs to know about one audio file. */
export type FileMetadata = {
  title?: string;
  author?: string;
  narrator?: string;
  album?: string;
  year?: string;
  trackNumber?: number;
  durationSec: number;
  chapters: ParsedChapter[];
  chapterSource: string;
  cover?: { bytes: Uint8Array; mime: string };
  drm?: boolean;
};

export async function readMetadata(
  r: ByteReader,
  fileName: string,
  options: ReadOptions = {},
): Promise<FileMetadata> {
  if (isDrmContainer(fileName)) {
    // There is nothing readable inside an .aa/.aax without the account key.
    return { durationSec: 0, chapters: [], chapterSource: 'none', drm: true };
  }
  if (extensionOf(fileName) === '.mp3') {
    return readMp3Metadata(r, options);
  }
  return readMp4Metadata(r, options);
}
