/**
 * Builds a synthetic 400-book library for performance testing.
 *
 * The files are real and valid: correct tags, chapter marks, and embedded
 * cover art at the sizes real audiobooks carry (100 KB–1 MB), because the
 * point is to exercise scanning and thumbnailing honestly. The audio itself
 * is a few seconds of near-silence, so the whole library is a couple of
 * hundred megabytes rather than a couple of hundred gigabytes.
 *
 *   npm run make:testlib
 *
 * Writes to testlib/ (git-ignored). Copy that folder onto the USB drive.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = path.join(process.cwd(), 'testlib');
const TOTAL_BOOKS = 400;
/** Every nth book is split into parts, like a ripped CD set. */
const MULTI_PART_EVERY = 11;

const FIRST = [
  'The Silent', 'A Distant', 'The Last', 'Shadows of', 'The Glass', 'Winter in',
  'The Burning', 'Letters from', 'The Hollow', 'Echoes of', 'The Amber', 'Salt and',
  'The Quiet', 'Tales of', 'The Iron', 'Dreams of', 'The Crimson', 'North of',
  'The Lantern', 'Songs for',
];
const SECOND = [
  'Harbour', 'Mountain', 'Kingdom', 'Winter', 'Garden', 'Machine', 'Orchard',
  'Lighthouse', 'Cathedral', 'Meridian', 'Compass', 'Wolves', 'Archive', 'Tide',
  'Bell', 'Hour', 'Frontier', 'Chapel', 'River', 'Sparrow',
];
const AUTHORS = [
  'Eleanor Vance', 'Марина Орлова', 'Tomás Herrera', 'Ada Whitfield', 'Jonas Bergström',
  'Priya Raghavan', 'Clementine Fox', 'Hugo Lambert', 'Niamh O’Donnell', 'Mei-Lin Chen',
  'Rafael Duarte', 'Agnes Thornbury', 'Karim Haddad', 'Sofia Lindqvist', 'Desmond Ward',
];
const NARRATORS = [
  'Steven Pacey', 'Juliet Stevenson', 'Michael Kramer', 'Kate Reading', 'Alan Cumming',
  'Rosamund Pike', 'Hugh Laurie', 'Thandiwe Newton',
];

/** Deterministic, so a rebuild produces the same library. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe' });
}

/**
 * A JPEG of roughly `targetKb`. Noise is used deliberately: a flat colour
 * compresses to nothing, and a 2 KB "cover" would not test thumbnailing.
 */
function makeCover(file: string, targetKb: number, seed: number) {
  // A JPEG of noise at this quality runs near one byte per pixel, so the
  // pixel count is roughly the target byte count.
  const size = Math.max(300, Math.min(1400, Math.round(Math.sqrt(targetKb * 1024))));
  ffmpeg([
    '-f', 'lavfi',
    '-i', `nullsrc=s=${size}x${size},geq=random(${seed})*255:128:128`,
    '-frames:v', '1',
    '-q:v', '4',
    file,
  ]);
}

function writeMetadata(file: string, fields: Record<string, string>, chapters: number, ms: number) {
  const lines = [';FFMETADATA1'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}=${v.replace(/\n/g, ' ')}`);
  const per = Math.floor(ms / Math.max(1, chapters));
  for (let i = 0; i < chapters; i += 1) {
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${i * per}`, `END=${(i + 1) * per}`,
      `title=Chapter ${i + 1}`);
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });

  const rand = rng(20261011);
  let totalBytes = 0;

  for (let i = 0; i < TOTAL_BOOKS; i += 1) {
    const title = `${FIRST[i % FIRST.length]} ${SECOND[Math.floor(i / FIRST.length) % SECOND.length]}`;
    const unique = `${title} ${String(i + 1).padStart(3, '0')}`;
    const author = AUTHORS[i % AUTHORS.length];
    const narrator = NARRATORS[i % NARRATORS.length];
    const multiPart = i % MULTI_PART_EVERY === 0;

    // A spread of cover sizes, like a real shelf: mostly modest, some large.
    const coverKb = Math.round(80 + rand() * 900);
    const folder = path.join(OUT, unique.replace(/[\\/:*?"<>|]/g, ' '));
    fs.mkdirSync(folder, { recursive: true });

    const cover = path.join(tmp, `cover-${i}.jpg`);
    makeCover(cover, multiPart ? Math.round(coverKb / 3) : coverKb, i + 1);

    if (multiPart) {
      // A handful of parts, no embedded chapters — the one-chapter-per-part case.
      const parts = 3 + Math.floor(rand() * 5);
      for (let p = 0; p < parts; p += 1) {
        const meta = path.join(tmp, `m-${i}-${p}.txt`);
        writeMetadata(meta, {
          title: `Part ${p + 1}`,
          artist: author,
          album: unique,
          composer: narrator,
          track: `${p + 1}/${parts}`,
        }, 0, 0);
        ffmpeg([
          '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink:r=11025',
          '-i', meta, '-i', cover,
          '-map', '0:a', '-map', '2:v', '-map_metadata', '1',
          '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '24k',
          '-id3v2_version', '3',
          path.join(folder, `${unique} - Part ${String(p + 1).padStart(2, '0')}.mp3`),
        ]);
      }
    } else {
      const chapters = 8 + Math.floor(rand() * 40);
      const meta = path.join(tmp, `m-${i}.txt`);
      writeMetadata(meta, {
        title: unique,
        artist: author,
        album: unique,
        composer: narrator,
      }, chapters, 20000);
      ffmpeg([
        '-f', 'lavfi', '-i', 'anoisesrc=d=20:c=pink:r=11025',
        '-i', meta, '-i', cover,
        '-map', '0:a', '-map', '2:v', '-map_metadata', '1',
        '-ac', '1', '-c:a', 'aac', '-b:a', '16k',
        '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
        '-f', 'mp4',
        path.join(folder, `${unique}.m4b`),
      ]);
    }

    for (const f of fs.readdirSync(folder)) {
      totalBytes += fs.statSync(path.join(folder, f)).size;
    }
    if ((i + 1) % 25 === 0) {
      process.stdout.write(`  ${i + 1}/${TOTAL_BOOKS} books · ${(totalBytes / 1024 ** 2).toFixed(0)} MB\n`);
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\ntestlib/ ready: ${TOTAL_BOOKS} books, ${(totalBytes / 1024 ** 2).toFixed(0)} MB`);
  console.log('Copy the whole testlib folder onto the USB drive.');
}

main();
