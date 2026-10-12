/**
 * Shared test helpers: a Node-backed ByteReader so the parser can be exercised
 * off-device, and the paths to the two fixture sets.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CachingReader, type ByteReader } from '../src/lib/metadata/reader.ts';

/** npm scripts always run from the package root. */
const ROOT = process.cwd();

/** Small synthetic files committed with the repo. */
export const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures');

/**
 * Real audiobooks. Copyrighted, git-ignored, and absent on most machines —
 * every test that needs them skips itself when the folder is not there.
 */
export const REAL_DIR = path.join(ROOT, 'audiobooks');

export const hasFixtures = fs.existsSync(FIXTURE_DIR);
export const hasRealBooks =
  fs.existsSync(REAL_DIR) && fs.readdirSync(REAL_DIR).some((e) => !e.startsWith('.'));

export const hasFfprobe = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export function nodeReader(file: string): ByteReader {
  const fd = fs.openSync(file, 'r');
  return new CachingReader({
    async size() {
      return fs.fstatSync(fd).size;
    },
    async read(offset: number, length: number) {
      const buf = Buffer.allocUnsafe(length);
      const n = fs.readSync(fd, buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, n);
    },
    async close() {
      fs.closeSync(fd);
    },
  });
}

/** Every file under `dir`, recursively, as absolute paths. */
export function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Reference metadata from ffprobe, for cross-checking the parser. */
export type Probe = {
  durationSec: number;
  title?: string;
  artist?: string;
  track?: string;
  chapters: { start: number; title: string }[];
  hasCover: boolean;
};

export function ffprobe(file: string): Probe | null {
  try {
    const raw = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_chapters', '-show_streams', '-of', 'json', file],
      { maxBuffer: 64 * 1024 * 1024 },
    ).toString();
    const parsed = JSON.parse(raw) as {
      format?: { duration?: string; tags?: Record<string, string> };
      chapters?: { start_time: string; tags?: { title?: string } }[];
      streams?: { codec_type?: string; disposition?: { attached_pic?: number } }[];
    };
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.format?.tags ?? {})) {
      tags[k.toLowerCase()] = String(v);
    }
    return {
      durationSec: Number(parsed.format?.duration ?? 0),
      title: tags.title,
      artist: tags.artist ?? tags.album_artist,
      track: tags.track,
      chapters: (parsed.chapters ?? []).map((c) => ({
        start: Number(c.start_time),
        title: String(c.tags?.title ?? ''),
      })),
      hasCover: (parsed.streams ?? []).some(
        (s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1,
      ),
    };
  } catch {
    return null;
  }
}
