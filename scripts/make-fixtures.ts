/**
 * Builds the F1–F20 test fixture library used by the device test plan.
 *
 * Unlike `make-testlib.ts`, which generates a large, uniform library for
 * performance work, this produces a small set of deliberately awkward books:
 * messy names, unsupported formats, a zero-length file, a corrupt file, a
 * truncated container, a DRM-flagged file, duplicates, non-ASCII paths and a
 * book deep enough to probe the scan depth limit.
 *
 *   npm run make:fixtures          # ~150 MB "Big" book
 *   BIG_MB=400 npm run make:fixtures
 *
 * Writes to fixtures/Audiobooks/ (git-ignored) and emits manifest.json beside
 * it, so tests assert against generated facts rather than numbers copied by
 * hand into a test file.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT = path.join(process.cwd(), 'fixtures', 'Audiobooks');
const TMP = path.join(process.cwd(), 'fixtures', '.tmp');
const BIG_MB = Number(process.env.BIG_MB ?? 150);

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe' });
}

function dir(...parts: string[]): string {
  const d = path.join(OUT, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A chapter written verbatim, for the fixtures that need deliberately bad ones. */
type RawChapter = { startMs: number; endMs: number; title: string };

/** FFMETADATA with optional chapters, written to a scratch file. */
function metaFile(
  name: string,
  fields: Record<string, string>,
  chapters: { count: number; totalMs: number } | null,
  rawChapters?: RawChapter[],
): string {
  const lines = [';FFMETADATA1'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}=${v.replace(/\n/g, ' ')}`);

  const write = (startMs: number, endMs: number, title: string) =>
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${startMs}`, `END=${endMs}`, `title=${title}`);

  if (rawChapters) {
    for (const c of rawChapters) write(c.startMs, c.endMs, c.title);
  } else if (chapters && chapters.count > 0) {
    const per = Math.floor(chapters.totalMs / chapters.count);
    for (let i = 0; i < chapters.count; i += 1) {
      write(i * per, (i + 1) * per, `Chapter ${i + 1}`);
    }
  }
  const file = path.join(TMP, `${name}.ffmeta`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

const ROMAN: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function roman(n: number): string {
  let out = '';
  let left = n;
  for (const [value, numeral] of ROMAN) {
    while (left >= value) {
      out += numeral;
      left -= value;
    }
  }
  return out;
}

/** A JPEG of noise at roughly the requested size; flat colour compresses away. */
function cover(file: string, w: number, h: number, seed: number) {
  ffmpeg([
    '-f', 'lavfi',
    '-i', `nullsrc=s=${w}x${h},geq=random(${seed})*255:128:128`,
    '-frames:v', '1', '-q:v', '4', file,
  ]);
}

type AudioOptions = {
  seconds: number;
  fields?: Record<string, string>;
  chapters?: number;
  coverPath?: string;
  /** Bitrate, e.g. '16k'. Ignored when `lossless` is set. */
  bitrate?: string;
  /**
   * Encode as ALAC at CD-ish quality instead of low-bitrate AAC.
   *
   * AAC refuses to go above roughly 500 kbps, so asking it for a large file
   * silently produced a small one. Lossless on incompressible noise gives a
   * size that is predictable from the duration, which is what the copy and
   * free-space tests actually need.
   */
  lossless?: boolean;
  /** Chapters written verbatim, for deliberately malformed chapter data. */
  rawChapters?: RawChapter[];
  /** Strip every tag, for the self-recorded fixtures that have none. */
  noTags?: boolean;
  /** Variable bitrate with no Xing/Info header, so duration must be estimated. */
  vbrNoHeader?: boolean;
  /** Silence rather than noise: encodes far faster for very long files. */
  silent?: boolean;
};

function makeM4b(target: string, o: AudioOptions) {
  const meta = metaFile(
    path.basename(target),
    o.fields ?? {},
    o.chapters ? { count: o.chapters, totalMs: o.seconds * 1000 } : null,
    o.rawChapters,
  );
  const rate = o.lossless ? 48000 : 22050;
  const channels = o.lossless ? '2' : '1';
  const args = [
    '-f', 'lavfi', '-i', o.silent
      ? `anullsrc=r=${rate}:cl=mono:d=${o.seconds}`
      : `anoisesrc=d=${o.seconds}:c=pink:r=${rate}`,
    '-i', meta,
  ];
  if (o.coverPath) args.push('-i', o.coverPath);
  args.push('-map', '0:a');
  if (o.coverPath) args.push('-map', '2:v');
  args.push('-map_metadata', o.noTags ? '-1' : '1', '-ac', channels);
  if (o.lossless) args.push('-c:a', 'alac');
  else args.push('-c:a', 'aac', '-b:a', o.bitrate ?? '16k');
  if (o.coverPath) args.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  // No +faststart: the moov stays at the end, which is both what real
  // audiobooks look like and what the truncation fixture needs.
  args.push('-f', 'mp4', target);
  ffmpeg(args);
}

function makeMp3(target: string, o: AudioOptions) {
  const meta = metaFile(
    path.basename(target),
    o.fields ?? {},
    o.chapters ? { count: o.chapters, totalMs: o.seconds * 1000 } : null,
    o.rawChapters,
  );
  const args = [
    '-f', 'lavfi', '-i', o.silent
      ? `anullsrc=r=22050:cl=mono:d=${o.seconds}`
      : `anoisesrc=d=${o.seconds}:c=pink:r=22050`,
    '-i', meta,
  ];
  if (o.coverPath) args.push('-i', o.coverPath);
  args.push('-map', '0:a');
  if (o.coverPath) args.push('-map', '2:v');
  args.push('-map_metadata', o.noTags ? '-1' : '1', '-ac', '1', '-c:a', 'libmp3lame');
  if (o.vbrNoHeader) {
    // `-write_xing 0` removes the header a player would normally use to learn
    // the duration of a variable-bitrate file, which is the point of X12.
    args.push('-q:a', '5', '-write_xing', '0');
  } else {
    args.push('-b:a', o.bitrate ?? '24k');
  }
  args.push('-id3v2_version', '3', target);
  ffmpeg(args);
}

/**
 * Rewrites the audio sample entry in `stsd` from `mp4a` to `drms`, which is
 * what a FairPlay-protected book carries.
 *
 * Scoped to a window after the `stsd` atom rather than replacing every `mp4a`
 * in the file: the four bytes also appear in `ftyp` as a brand, and corrupting
 * that would make the file unreadable for a different reason than the one
 * under test.
 */
function markAsDrm(file: string) {
  const buf = fs.readFileSync(file);
  const stsd = buf.indexOf('stsd');
  if (stsd < 0) throw new Error(`no stsd atom in ${file}`);
  const mp4a = buf.indexOf('mp4a', stsd);
  if (mp4a < 0 || mp4a - stsd > 64) throw new Error(`no mp4a sample entry near stsd in ${file}`);
  buf.write('drms', mp4a, 'ascii');
  fs.writeFileSync(file, buf);
}

function main() {
  fs.rmSync(path.join(process.cwd(), 'fixtures'), { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const art = path.join(TMP, 'art.jpg');
  cover(art, 800, 1200, 7);
  const sideArt = path.join(TMP, 'side.jpg');
  cover(sideArt, 800, 1200, 11);
  const backArt = path.join(TMP, 'back.png');
  cover(backArt, 600, 900, 13);

  /** Books the scan is expected to produce, for the manifest. */
  const expected: { id: string; folder: string; parts: number; note: string }[] = [];
  const add = (id: string, folder: string, parts: number, note: string) =>
    expected.push({ id, folder, parts, note });

  // F1 — baseline single file, cover image beside the audio, 5 chapters.
  {
    const d = dir('Hyperion - Dan Simmons');
    makeM4b(path.join(d, 'book.m4b'), {
      seconds: 30,
      chapters: 5,
      fields: { title: 'Hyperion', artist: 'Dan Simmons', album: 'Hyperion' },
    });
    fs.copyFileSync(sideArt, path.join(d, 'cover.jpg'));
    add('F1', 'Hyperion - Dan Simmons', 1, 'image beside audio beats embedded');
  }

  // F2 — multi-part, track tags in order, messy folder name, no chapters.
  {
    const folder = 'The Long Way (Unabridged) [MP3] 64kbps';
    const d = dir(folder);
    for (let i = 1; i <= 12; i += 1) {
      makeMp3(path.join(d, `Part ${i}.mp3`), {
        seconds: 6,
        fields: { title: `Part ${i}`, album: 'The Long Way', track: `${i}/12` },
      });
    }
    add('F2', folder, 12, 'one chapter per part');
  }

  // F3 — natural filename sort with no track tags: 1, 2, 10.
  {
    const d = dir('Natural Sort');
    for (const n of [1, 2, 10]) {
      makeMp3(path.join(d, `Part ${n}.mp3`), { seconds: 6, fields: {} });
    }
    add('F3', 'Natural Sort', 3, 'order must be 1, 2, 10');
  }

  // F4 — track tags must beat filenames.
  {
    const d = dir('Tag Wins');
    const order: [string, number][] = [['a.mp3', 3], ['b.mp3', 1], ['c.mp3', 2]];
    for (const [name, track] of order) {
      makeMp3(path.join(d, name), { seconds: 6, fields: { track: `${track}/3` } });
    }
    add('F4', 'Tag Wins', 3, 'order must be b, c, a');
  }

  // F5 — embedded artwork only.
  {
    const d = dir('Embedded Only');
    makeM4b(path.join(d, 'book.m4b'), {
      seconds: 20,
      chapters: 3,
      coverPath: art,
      fields: { title: 'Embedded Only', artist: 'A N Other' },
    });
    add('F5', 'Embedded Only', 1, 'embedded cover');
  }

  // F6 — no tags, no art: generated cover, title from the folder.
  {
    const d = dir('No Art');
    makeMp3(path.join(d, 'book.mp3'), { seconds: 20, fields: {} });
    add('F6', 'No Art', 1, 'generated cover, no chapters');
  }

  // F7 — a colon is not an author separator.
  {
    const folder = 'Title_ A Subtitle';
    const d = dir(folder);
    makeM4b(path.join(d, 'book.m4b'), { seconds: 20, fields: {} });
    add('F7', folder, 1, 'colon handling (underscore on Windows hosts)');
  }

  // F8 — non-audio files in the folder must be ignored, back.png used as art.
  {
    const d = dir('Mixed');
    makeM4b(path.join(d, 'book.m4b'), { seconds: 20, fields: { title: 'Mixed' } });
    fs.writeFileSync(path.join(d, 'book.mobi'), Buffer.alloc(4096, 1));
    fs.writeFileSync(path.join(d, 'notes.txt'), 'not audio\n');
    fs.copyFileSync(backArt, path.join(d, 'back.png'));
    add('F8', 'Mixed', 1, 'one part; .mobi and .txt ignored');
  }

  // F9 — recognised but unsupported audio: counted as skipped, no book.
  {
    const d = dir('Unsupported');
    ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=d=5:r=22050', '-ac', '1',
      path.join(d, 'book.flac')]);
    ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=d=5:r=22050', '-ac', '1', '-c:a', 'libvorbis',
      path.join(d, 'book.ogg')]);
  }

  // F10 — no audio at all: no book, and no warning worth showing.
  {
    const d = dir('No Audio');
    fs.writeFileSync(path.join(d, 'readme.txt'), 'nothing here\n');
    fs.copyFileSync(sideArt, path.join(d, 'cover.jpg'));
  }

  // F11 — zero-length file.
  {
    const d = dir('Zero');
    fs.writeFileSync(path.join(d, 'empty.m4b'), Buffer.alloc(0));
    add('F11', 'Zero', 0, 'empty file: a flagged book with no playable parts');
  }

  // F12 — a megabyte of random bytes with an audio extension.
  {
    const d = dir('Corrupt');
    const noise = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) & 0xff;
    fs.writeFileSync(path.join(d, 'garbage.mp3'), noise);
    add('F12', 'Corrupt', 0, 'unparseable: a flagged book with no playable parts');
  }

  // F13 — a valid m4b truncated to half, so the trailing moov is gone.
  {
    const d = dir('Truncated');
    const whole = path.join(TMP, 'whole.m4b');
    makeM4b(whole, { seconds: 40, chapters: 4, fields: { title: 'Truncated' } });
    const buf = fs.readFileSync(whole);
    fs.writeFileSync(path.join(d, 'book.m4b'), buf.subarray(0, Math.floor(buf.length / 2)));
    add('F13', 'Truncated', 0, 'moov missing: a flagged book with no playable parts');
  }

  // F14 — DRM-flagged sample entry.
  {
    const d = dir('DRM');
    const target = path.join(d, 'book.m4b');
    makeM4b(target, { seconds: 20, chapters: 2, fields: { title: 'Protected' } });
    markAsDrm(target);
    add('F14', 'DRM', 1, 'must be refused as DRM');
  }

  // F15 — the same book in two folders, byte for byte.
  {
    const a = dir('Dup A');
    const b = dir('Dup B');
    const src = path.join(TMP, 'dup.m4b');
    makeM4b(src, { seconds: 20, chapters: 2, fields: { title: 'Twice Over', artist: 'Ditto' } });
    fs.copyFileSync(src, path.join(a, 'book.m4b'));
    fs.copyFileSync(src, path.join(b, 'book.m4b'));
    add('F15a', 'Dup A', 1, 'separate identity from Dup B');
    add('F15b', 'Dup B', 1, 'separate identity from Dup A');
  }

  // F16 — characters that java.net.URI rejects outright.
  //
  // Windows forbids ? : * " < > | in a filename, so those cannot be generated
  // here. What is left still covers the failure that mattered — non-ASCII, an
  // em dash and brackets all break `URI.create` — and `make-fixtures` prints
  // an adb snippet for the Windows-illegal names, which ext4 accepts happily.
  {
    const folder = 'Weird #1 %20 &= [v2]';
    const d = dir(folder);
    makeM4b(path.join(d, 'Ünïcødé — 東京 #2.m4b'), {
      seconds: 20,
      fields: { title: 'Weird Names' },
    });
    add('F16', folder, 1, 'URI-hostile path must still check out');
  }

  // F17 — non-ASCII metadata that must round-trip exactly.
  {
    const folder = 'Война и мир - Лев Толстой';
    const d = dir(folder);
    makeM4b(path.join(d, 'книга.m4b'), {
      seconds: 20,
      chapters: 3,
      fields: { title: 'Война и мир', artist: 'Лев Толстой' },
    });
    add('F17', folder, 1, 'Cyrillic tags and path');
  }

  // F18 — the scan walks to depth 8 and stops: one book in, one book out.
  {
    const okParts = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'Deep Ok'];
    makeMp3(path.join(dir(...okParts), 'book.mp3'), { seconds: 6, fields: {} });
    add('F18', okParts.join('/'), 1, 'depth 8, indexed');

    const tooDeep = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'Too Deep'];
    makeMp3(path.join(dir(...tooDeep), 'book.mp3'), { seconds: 6, fields: {} });
  }

  // F19 — large enough for progress, cancel and free-space work.
  {
    const d = dir('Big');
    // Lossless 48 kHz stereo of noise lands near PCM: 192 KB per second. The
    // duration is derived from the target size rather than the other way round.
    const seconds = Math.round((BIG_MB * 1024) / 192);
    makeM4b(path.join(d, 'book.m4b'), {
      seconds,
      chapters: 6,
      fields: { title: 'Big', artist: 'Bandwidth' },
      lossless: true,
    });
    add('F19', 'Big', 1, `~${BIG_MB} MB for copy tests`);
  }

  // F20 — more chapters than Nero's 255-entry ceiling can carry.
  {
    const d = dir('Chapters QT');
    makeM4b(path.join(d, 'book.m4b'), {
      seconds: 600,
      chapters: 300,
      fields: { title: 'Three Hundred' },
    });
    add('F20', 'Chapters QT', 1, '300 chapters; Nero chpl cannot hold them all');
  }

  // ----------------------------------------------------------------------
  // X1–X20: the shapes real libraries actually arrive in. Rips from five
  // different tools, tags copied from the wrong book, and the litter every
  // operating system leaves on a USB drive.
  // ----------------------------------------------------------------------

  // X1 — a CD rip split across disc folders, track numbers restarting on each
  // disc and the filenames colliding between them.
  {
    for (const [disc, n] of [['CD 1', 5], ['CD 2', 5]] as const) {
      const d = dir('Dune', disc);
      for (let t = 1; t <= n; t += 1) {
        makeMp3(path.join(d, `${String(t).padStart(2, '0')}.mp3`), {
          seconds: 4,
          fields: { album: `Dune, ${disc}`, artist: 'Frank Herbert', track: `${t}/${n}` },
        });
      }
    }
    fs.copyFileSync(sideArt, path.join(OUT, 'Dune', 'cover.jpg'));
    add('X1', 'Dune', 10, 'two disc folders must merge into one book');
  }

  // X2 — the same, but with disc tags and no space in the folder name.
  {
    for (const [disc, label] of [['Disc1', '1/2'], ['Disc2', '2/2']] as const) {
      const d = dir('Foundation', disc);
      for (let t = 1; t <= 4; t += 1) {
        makeMp3(path.join(d, `Track${String(t).padStart(2, '0')}.mp3`), {
          seconds: 4,
          fields: { album: 'Foundation', artist: 'Isaac Asimov', track: `${t}/4`, disc: label },
        });
      }
    }
    add('X2', 'Foundation', 8, 'disc tags present');
  }

  // X3 — self-recorded, no tags at all, filenames that give no ordering.
  {
    const d = dir('My Memoir (self recorded)');
    for (const name of [
      'recording 2023-01-05.m4a',
      'recording 2023-01-12.m4a',
      'New Recording 3.m4a',
      'final final.m4a',
    ]) {
      makeM4b(path.join(d, name), { seconds: 5, noTags: true });
    }
    add('X3', 'My Memoir (self recorded)', 4, 'untagged, natural filename order');
  }

  // X4 — one folder, several short works, each fully tagged as its own album.
  {
    const d = dir('Kids Stories');
    const titles = ['Gruffalo', 'Room on the Broom', 'Stick Man'];
    for (const title of titles) {
      makeMp3(path.join(d, `${title}.mp3`), {
        seconds: 5,
        fields: { title, album: title, artist: 'Julia Donaldson' },
      });
    }
    titles.forEach((t) =>
      add(`X4:${t}`, 'Kids Stories', 1, 'album tags split one folder into three books'),
    );
  }

  // X5 — track tags in three different formats, and two files both claiming 7.
  {
    const d = dir('Odyssey');
    for (let i = 1; i <= 24; i += 1) {
      // 1/24, 02/24 and bare 3 must all parse; 7 is deliberately duplicated.
      const track = i === 8 ? '7' : i === 2 ? '02/24' : i === 3 ? '3' : `${i}/24`;
      makeMp3(path.join(d, `${String(i).padStart(2, '0')} - Book ${roman(i)}.mp3`), {
        seconds: 3,
        fields: { album: 'Odyssey', artist: 'Homer', track },
      });
    }
    add('X5', 'Odyssey', 24, 'inconsistent and duplicate track tags');
  }

  // X6 — tags copied from entirely the wrong source.
  {
    const d = dir('Wrong Tags');
    for (let i = 1; i <= 3; i += 1) {
      makeMp3(path.join(d, `part${i}.mp3`), {
        seconds: 4,
        fields: {
          title: 'Harry Potter 1',
          album: 'Greatest Hits',
          artist: 'Various Artists',
          track: `${i}/3`,
        },
      });
    }
    add('X6', 'Wrong Tags', 3, 'placeholder author must be ignored');
  }

  // X7 — one book whose parts are not all the same format.
  {
    const d = dir('Mixed Formats');
    makeMp3(path.join(d, '01.mp3'), { seconds: 4, fields: { album: 'Mixed Formats', track: '1/3' } });
    makeM4b(path.join(d, '02.m4a'), { seconds: 4, fields: { album: 'Mixed Formats', track: '2/3' } });
    makeMp3(path.join(d, '03.mp3'), { seconds: 4, fields: { album: 'Mixed Formats', track: '3/3' } });
    add('X7', 'Mixed Formats', 3, 'mp3 and m4a in one book');
  }

  // X8 — audio sitting loose in the library root, belonging to no folder.
  // Deliberately untagged, which is the case the plan expects to split into
  // two books and the current grouping rules may well not.
  {
    makeM4b(path.join(OUT, 'Some Book.m4b'), { seconds: 6, noTags: true });
    makeMp3(path.join(OUT, 'Another.mp3'), { seconds: 6, noTags: true });
    add('X8a', '', 1, 'loose root file is its own book');
    add('X8b', '', 1, 'loose root file is its own book');
  }

  // X9 — a series folder with one cover shared by the books inside it.
  {
    for (const book of ['Book 1', 'Book 2']) {
      const d = dir('Author', 'Series', book);
      makeMp3(path.join(d, 'book.mp3'), { seconds: 5, fields: { album: book } });
      add(`X9:${book}`, `Author/Series/${book}`, 1, 'nested series, parent cover');
    }
    fs.copyFileSync(backArt, path.join(OUT, 'Author', 'Series', 'cover.jpg'));
  }

  // X10 — the litter a drive picks up from a Mac and a Windows box.
  {
    const d = dir('Mac Junk');
    makeM4b(path.join(d, 'book.m4b'), { seconds: 8, fields: { title: 'Mac Junk' } });
    fs.writeFileSync(path.join(d, '._book.m4b'), Buffer.alloc(4096, 0));
    fs.writeFileSync(path.join(d, '.DS_Store'), Buffer.alloc(6148, 0));
    fs.writeFileSync(path.join(d, 'Thumbs.db'), Buffer.alloc(8192, 0));
    fs.writeFileSync(path.join(d, 'desktop.ini'), '[.ShellClassInfo]\n');
    // Larger than the real cover on purpose: junk must never win the pick.
    fs.writeFileSync(path.join(d, '._cover.jpg'), Buffer.alloc(99999, 0));
    fs.copyFileSync(sideArt, path.join(d, 'cover.jpg'));
    add('X10', 'Mac Junk', 1, 'junk ignored entirely, real cover still found');
  }

  // X11 — extensions in capitals.
  {
    makeMp3(path.join(dir('UPPER'), 'BOOK.MP3'), { seconds: 5, fields: { title: 'Upper One' } });
    makeM4b(path.join(dir('Upper2'), 'Book.M4B'), { seconds: 5, fields: { title: 'Upper Two' } });
    add('X11a', 'UPPER', 1, 'uppercase .MP3');
    add('X11b', 'Upper2', 1, 'uppercase .M4B');
  }

  // X12 — variable bitrate with the header a player uses to find the duration
  // removed, so the duration has to be estimated.
  {
    const d = dir('VBR No Header');
    makeMp3(path.join(d, 'book.mp3'), {
      seconds: 20 * 60,
      silent: true,
      vbrNoHeader: true,
      fields: { title: 'VBR No Header' },
    });
    add('X12', 'VBR No Header', 1, 'duration must be estimated');
  }

  // X13 — chapter data that is wrong in every way at once: all the same title,
  // out of order, two sharing a start, and one past the end of the file.
  {
    const d = dir('Bad Chapters');
    makeM4b(path.join(d, 'book.m4b'), {
      seconds: 60,
      fields: { title: 'Bad Chapters' },
      rawChapters: [
        { startMs: 30000, endMs: 40000, title: 'Chapter' },
        { startMs: 10000, endMs: 20000, title: 'Chapter' },
        { startMs: 10000, endMs: 20000, title: 'Chapter' },
        { startMs: 999000, endMs: 1000000, title: 'Chapter' },
        { startMs: 0, endMs: 10000, title: 'Chapter' },
      ],
    });
    add('X13', 'Bad Chapters', 1, 'junk chapter data');
  }

  // X14 — chapters with empty titles.
  {
    const d = dir('Empty Titles');
    makeM4b(path.join(d, 'book.m4b'), {
      seconds: 80,
      fields: { title: 'Empty Titles' },
      rawChapters: Array.from({ length: 8 }, (_, i) => ({
        startMs: i * 10000,
        endMs: (i + 1) * 10000,
        title: '',
      })),
    });
    add('X14', 'Empty Titles', 1, 'blank chapter titles');
  }

  // X15 — a single ten-hour file with nothing to go on. Silence, so the encode
  // finishes in seconds rather than minutes.
  {
    const d = dir('One Huge');
    makeMp3(path.join(d, 'book.mp3'), {
      seconds: 10 * 3600,
      silent: true,
      bitrate: '8k',
      noTags: true,
    });
    add('X15', 'One Huge', 1, 'ten hours, untagged, no chapters');
  }

  // X16 — three different files whose names differ only in leading zeros.
  {
    const d = dir('Leading Zeros');
    for (const name of ['1.mp3', '01.mp3', '001.mp3']) {
      makeMp3(path.join(d, name), { seconds: 3, noTags: true });
    }
    add('X16', 'Leading Zeros', 3, 'pathological numbering, order must be stable');
  }

  // X17 — a multi-file book where each file carries its own chapters.
  {
    const d = dir('Chapters Per File');
    const names = ['01 Prologue', '02 Chapter 1', '03 Chapter 2'];
    names.forEach((name, i) => {
      makeM4b(path.join(d, `${name}.m4b`), {
        seconds: 30,
        chapters: 3,
        fields: { album: 'Chapters Per File', track: `${i + 1}/3` },
      });
    });
    add('X17', 'Chapters Per File', 3, 'embedded chapters inside each part');
  }

  // X18 — an intro and a credits track numbered outside the main run.
  {
    const d = dir('Intro Outro');
    makeMp3(path.join(d, '00 - Intro.mp3'), { seconds: 3, fields: { album: 'Intro Outro' } });
    for (let i = 1; i <= 10; i += 1) {
      makeMp3(path.join(d, `${String(i).padStart(2, '0')}.mp3`), {
        seconds: 3,
        fields: { album: 'Intro Outro' },
      });
    }
    makeMp3(path.join(d, '99 - Credits.mp3'), { seconds: 3, fields: { album: 'Intro Outro' } });
    add('X18', 'Intro Outro', 12, 'intro and outro outside the main sequence');
  }

  // X19 — dots standing in for spaces, with release junk in the folder name.
  {
    const folder = 'Book.Name.2019.MP3.64kbps';
    const d = dir('Spaces and Dots', folder);
    for (let i = 1; i <= 8; i += 1) {
      makeMp3(path.join(d, `part_${String(i).padStart(2, '0')}_of_08.mp3`), {
        seconds: 3,
        noTags: true,
      });
    }
    add('X19', `Spaces and Dots/${folder}`, 8, 'dots as spaces, junk in the name');
  }

  // X20 — very long names.
  //
  // Capped at what Windows will create: the host path already eats most of the
  // 260-character limit, so the full 255-character SAF case has to be made on
  // the device. The adb lines printed at the end cover that.
  {
    const longFolder = `Very Long ${'name '.repeat(18)}end`.trim();
    const longFile = `${'part '.repeat(16)}01`.trim();
    const d = dir('Very Long', longFolder);
    makeMp3(path.join(d, `${longFile}.mp3`), { seconds: 4, noTags: true });
    add('X20', `Very Long/${longFolder}`, 1, `${longFolder.length}-character folder name`);
  }


  fs.rmSync(TMP, { recursive: true, force: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    bigMb: BIG_MB,
    expectedBooks: expected,
    expectedBookCount: expected.length,
    foldersWithNoBook: ['Unsupported', 'No Audio', 'Too Deep'],
    unsupportedFileCount: 2,
  };
  fs.writeFileSync(
    path.join(process.cwd(), 'fixtures', 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  let bytes = 0;
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else bytes += fs.statSync(full).size;
    }
  };
  walk(OUT);
  console.log(`fixtures/Audiobooks ready: ${(bytes / 1024 ** 2).toFixed(0)} MB`);
  console.log(`${expected.length} books expected, plus ${manifest.foldersWithNoBook.length} folders that must produce none`);
  // Windows forbids ? : * " < > | in a name, so two fixtures have to be made
  // on the device, where ext4 accepts them. Printed rather than scripted
  // because the SD card path differs per emulator.
  const SD = '/storage/0900-360C/Audiobooks';
  console.log([
    '',
    'Names Windows cannot create — run these after pushing:',
    `  adb shell "mkdir -p '${SD}/Query ?1 &2'"`,
    `  adb shell "cp '${SD}/Mixed/book.m4b' '${SD}/Query ?1 &2/what? [1].m4b'"`,
    `  adb shell "mkdir -p '${SD}/Colon: Subtitle'"`,
    `  adb shell "cp '${SD}/Mixed/book.m4b' '${SD}/Colon: Subtitle/book.m4b'"`,
  ].join('\n'));
}

main();
