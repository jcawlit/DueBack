/**
 * MP4 / M4B metadata reader.
 *
 * Reads only the byte ranges it needs. The `moov` atom is located by walking the
 * top-level atom chain — each header tells you how far to jump to the next one —
 * so a file with `moov` at the end costs a handful of 64 KB reads rather than a
 * full scan. Nothing ever touches `mdat`, which is all but the last fraction of
 * a percent of an audiobook.
 *
 * Chapters come from either of the two formats in the wild:
 *   - Nero: a `chpl` atom under `moov/udta`, a flat list of title + timestamp.
 *   - QuickTime: a separate text track referenced by the audio track's
 *     `tref/chap`; titles live in that track's samples, timings in its `stts`.
 * Files commonly carry both; Nero is preferred because it is one contiguous read.
 */

import { type ByteReader, fourcc, u16, u32, u64, utf8 } from './reader.ts';

export type ParsedChapter = { title: string; startSec: number };

export type ParsedMetadata = {
  container: 'mp4';
  title?: string;
  author?: string;
  narrator?: string;
  album?: string;
  series?: string;
  seriesIndex?: number;
  year?: string;
  /** From `trkn`; used to order the parts of a multi-file book. */
  trackNumber?: number;
  durationSec: number;
  chapters: ParsedChapter[];
  chapterSource: 'nero-chpl' | 'quicktime-text' | 'none';
  cover?: { bytes: Uint8Array; mime: string };
  /** The file is encrypted and cannot be played. */
  drm?: boolean;
};

export type ReadOptions = {
  /**
   * Skip extracting the embedded cover. Every part of a multi-file book often
   * carries the same artwork, and reading 127 copies of a 600 KB PNG is the
   * difference between a scan reading megabytes and reading tens of megabytes.
   */
  cover?: boolean;
};

type Atom = { type: string; start: number; headerSize: number; size: number; end: number };

/** Reads the atom header at `offset`, handling the 64-bit size escape. */
async function readAtomHeader(r: ByteReader, offset: number, limit: number): Promise<Atom | null> {
  if (offset + 8 > limit) return null;
  const head = await r.read(offset, 16);
  if (head.length < 8) return null;
  let size = u32(head, 0);
  const type = fourcc(head, 4);
  let headerSize = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    size = u64(head, 8);
    headerSize = 16;
  } else if (size === 0) {
    // "To end of file."
    size = limit - offset;
  }
  if (size < headerSize) return null;
  return { type, start: offset, headerSize, size, end: Math.min(offset + size, limit) };
}

/** Lists the direct children of a container atom spanning [start, end). */
async function children(r: ByteReader, start: number, end: number): Promise<Atom[]> {
  const out: Atom[] = [];
  let cursor = start;
  while (cursor < end) {
    const atom = await readAtomHeader(r, cursor, end);
    if (!atom) break;
    out.push(atom);
    if (atom.size <= 0) break;
    cursor = atom.start + atom.size;
  }
  return out;
}

function find(atoms: Atom[], type: string) {
  return atoms.find((a) => a.type === type);
}

/** Walks the top-level chain to find `moov`, wherever it sits in the file. */
async function findMoov(r: ByteReader, fileSize: number): Promise<Atom | null> {
  const top = await children(r, 0, fileSize);
  return find(top, 'moov') ?? null;
}

/** `mvhd` gives the overall duration via timescale + duration. */
function parseMvhd(body: Uint8Array): number {
  const version = body[0];
  if (version === 1) {
    const timescale = u32(body, 20);
    const duration = u64(body, 24);
    return timescale ? duration / timescale : 0;
  }
  const timescale = u32(body, 12);
  const duration = u32(body, 16);
  return timescale ? duration / timescale : 0;
}

/** iTunes-style tags live in `moov/udta/meta/ilst`, each a typed `data` atom. */
async function parseIlst(r: ByteReader, ilst: Atom, wantCover: boolean) {
  const out: {
    title?: string;
    author?: string;
    narrator?: string;
    album?: string;
    series?: string;
    seriesIndex?: number;
    year?: string;
    trackNumber?: number;
    cover?: { bytes: Uint8Array; mime: string };
  } = {};

  const items = await children(r, ilst.start + ilst.headerSize, ilst.end);
  for (const item of items) {
    const kids = await children(r, item.start + item.headerSize, item.end);
    const data = find(kids, 'data');
    if (!data) continue;
    const payloadStart = data.start + data.headerSize + 8; // 4 type + 4 locale
    const payloadLen = data.end - payloadStart;
    if (payloadLen <= 0) continue;

    // The covers are the only large payload; cap everything else.
    const isCover = item.type === 'covr';
    if (isCover && !wantCover) continue;
    if (!isCover && payloadLen > 4096) continue;

    const bytes = await r.read(payloadStart, Math.min(payloadLen, isCover ? 8 * 1024 * 1024 : 4096));
    const text = () => utf8.decode(bytes).replace(/\0+$/, '');

    switch (item.type) {
      case '©nam':
        out.title = text();
        break;
      case '©ART':
      case 'aART':
        if (!out.author) out.author = text();
        break;
      // Audiobooks conventionally put the narrator in the composer field.
      case '©wrt':
        out.narrator = text();
        break;
      case '©alb':
        out.album = text();
        break;
      /*
       * The series. iTunes' movement atoms are what Apple Books and most
       * taggers use for it; grouping is the older convention and only taken
       * if nothing better turned up.
       */
      case '©mvn':
        out.series = text();
        break;
      case '©grp':
        if (!out.series) out.series = text();
        break;
      case '©mvi': {
        // An integer atom, but some taggers write the number as text.
        const n = bytes.length >= 4 ? u32(bytes, 0) : NaN;
        const parsed = Number.isFinite(n) && n > 0 && n < 10000 ? n : parseInt(text(), 10);
        if (Number.isFinite(parsed) && parsed > 0) out.seriesIndex = parsed;
        break;
      }
      case '©day':
        out.year = text();
        break;
      case 'trkn':
        // trkn payload: 2 reserved bytes, then the 16-bit track number.
        if (bytes.length >= 4) out.trackNumber = u16(bytes, 2) || undefined;
        break;
      case 'covr': {
        const flags = u32(await r.read(data.start + data.headerSize, 4), 0) & 0xffffff;
        // 13 = JPEG, 14 = PNG, per the iTunes metadata well-known types.
        const mime = flags === 14 ? 'image/png' : flags === 13 ? 'image/jpeg' : sniffMime(bytes);
        out.cover = { bytes, mime };
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function sniffMime(b: Uint8Array): string {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  return 'application/octet-stream';
}

/** A Nero chapter count is one byte, so the format cannot express more. */
const NERO_MAX_CHAPTERS = 255;

/** Nero `chpl`: version/flags, count, then (8-byte 100ns time, pascal title)*. */
async function parseChpl(r: ByteReader, chpl: Atom): Promise<ParsedChapter[]> {
  const body = await r.read(chpl.start + chpl.headerSize, chpl.end - chpl.start - chpl.headerSize);
  if (body.length < 5) return [];
  const version = body[0];
  // Version 1 inserts a 4-byte reserved field before the count.
  let p = version === 1 ? 8 : 4;
  if (p >= body.length) return [];
  const count = body[p];
  p += 1;
  const out: ParsedChapter[] = [];
  for (let i = 0; i < count && p + 9 <= body.length; i += 1) {
    const start100ns = u64(body, p);
    p += 8;
    const len = body[p];
    p += 1;
    if (p + len > body.length) break;
    const title = utf8.decode(body.subarray(p, p + len)).replace(/\0+$/, '');
    p += len;
    out.push({ title, startSec: start100ns / 10_000_000 });
  }
  return out;
}

/**
 * QuickTime chapters: the audio track's `tref/chap` names a text track by id.
 * That track's `stts` gives per-sample durations and its `stco`/`co64` +
 * `stsz` give where each title string lives in `mdat`.
 */
async function parseQuickTimeChapters(
  r: ByteReader,
  moov: Atom,
  moovKids: Atom[],
): Promise<ParsedChapter[]> {
  const traks = moovKids.filter((a) => a.type === 'trak');
  if (traks.length === 0) return [];

  // Which track id do the chapters live in?
  let chapterTrackId: number | null = null;
  for (const trak of traks) {
    const kids = await children(r, trak.start + trak.headerSize, trak.end);
    const tref = find(kids, 'tref');
    if (!tref) continue;
    const trefKids = await children(r, tref.start + tref.headerSize, tref.end);
    const chap = find(trefKids, 'chap');
    if (!chap) continue;
    const body = await r.read(chap.start + chap.headerSize, chap.end - chap.start - chap.headerSize);
    if (body.length >= 4) chapterTrackId = u32(body, 0);
    break;
  }
  if (chapterTrackId === null) return [];

  for (const trak of traks) {
    const kids = await children(r, trak.start + trak.headerSize, trak.end);
    const tkhd = find(kids, 'tkhd');
    if (!tkhd) continue;
    const tkhdBody = await r.read(tkhd.start + tkhd.headerSize, 32);
    const version = tkhdBody[0];
    const trackId = version === 1 ? u32(tkhdBody, 20) : u32(tkhdBody, 12);
    if (trackId !== chapterTrackId) continue;

    const mdia = find(kids, 'mdia');
    if (!mdia) return [];
    const mdiaKids = await children(r, mdia.start + mdia.headerSize, mdia.end);
    const mdhd = find(mdiaKids, 'mdhd');
    if (!mdhd) return [];
    const mdhdBody = await r.read(mdhd.start + mdhd.headerSize, 32);
    const mdhdVersion = mdhdBody[0];
    const timescale = mdhdVersion === 1 ? u32(mdhdBody, 20) : u32(mdhdBody, 12);

    const minf = find(mdiaKids, 'minf');
    if (!minf) return [];
    const minfKids = await children(r, minf.start + minf.headerSize, minf.end);
    const stbl = find(minfKids, 'stbl');
    if (!stbl) return [];
    const stblKids = await children(r, stbl.start + stbl.headerSize, stbl.end);

    const sttsAtom = find(stblKids, 'stts');
    const stszAtom = find(stblKids, 'stsz');
    const stcoAtom = find(stblKids, 'stco') ?? find(stblKids, 'co64');
    const stscAtom = find(stblKids, 'stsc');
    if (!sttsAtom || !stszAtom || !stcoAtom) return [];

    // Sample durations -> chapter start times.
    const stts = await r.read(
      sttsAtom.start + sttsAtom.headerSize,
      sttsAtom.end - sttsAtom.start - sttsAtom.headerSize,
    );
    const entryCount = u32(stts, 4);
    const durations: number[] = [];
    for (let i = 0; i < entryCount; i += 1) {
      const count = u32(stts, 8 + i * 8);
      const delta = u32(stts, 12 + i * 8);
      for (let c = 0; c < count; c += 1) durations.push(delta);
    }

    // Sample sizes.
    const stsz = await r.read(
      stszAtom.start + stszAtom.headerSize,
      stszAtom.end - stszAtom.start - stszAtom.headerSize,
    );
    const uniformSize = u32(stsz, 4);
    const sampleCount = u32(stsz, 8);
    const sizes: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      sizes.push(uniformSize !== 0 ? uniformSize : u32(stsz, 12 + i * 4));
    }

    // Chunk offsets.
    const isCo64 = stcoAtom.type === 'co64';
    const stco = await r.read(
      stcoAtom.start + stcoAtom.headerSize,
      stcoAtom.end - stcoAtom.start - stcoAtom.headerSize,
    );
    const chunkCount = u32(stco, 4);
    const chunkOffsets: number[] = [];
    for (let i = 0; i < chunkCount; i += 1) {
      chunkOffsets.push(isCo64 ? u64(stco, 8 + i * 8) : u32(stco, 8 + i * 4));
    }

    // Samples-per-chunk, so we know which chunk each sample starts in.
    const samplesPerChunk: number[] = [];
    if (stscAtom) {
      const stsc = await r.read(
        stscAtom.start + stscAtom.headerSize,
        stscAtom.end - stscAtom.start - stscAtom.headerSize,
      );
      const stscCount = u32(stsc, 4);
      for (let i = 0; i < stscCount; i += 1) {
        const firstChunk = u32(stsc, 8 + i * 12);
        const perChunk = u32(stsc, 12 + i * 12);
        const nextFirst = i + 1 < stscCount ? u32(stsc, 8 + (i + 1) * 12) : chunkCount + 1;
        for (let c = firstChunk; c < nextFirst; c += 1) samplesPerChunk.push(perChunk);
      }
    }

    // Absolute file offset of every sample.
    const sampleOffsets: number[] = [];
    let sampleIndex = 0;
    for (let c = 0; c < chunkOffsets.length && sampleIndex < sampleCount; c += 1) {
      const n = samplesPerChunk[c] ?? 1;
      let within = chunkOffsets[c];
      for (let s = 0; s < n && sampleIndex < sampleCount; s += 1) {
        sampleOffsets.push(within);
        within += sizes[sampleIndex];
        sampleIndex += 1;
      }
    }

    const out: ParsedChapter[] = [];
    let elapsed = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const offset = sampleOffsets[i];
      const size = Math.min(sizes[i], 512);
      if (offset === undefined || size <= 0) continue;
      const raw = await r.read(offset, size);
      // A chapter sample is a 16-bit length followed by the title text.
      let title = '';
      if (raw.length >= 2) {
        const textLen = Math.min(u16(raw, 0), raw.length - 2);
        title = utf8.decode(raw.subarray(2, 2 + textLen)).replace(/\0+$/, '');
      }
      out.push({ title, startSec: timescale ? elapsed / timescale : 0 });
      elapsed += durations[i] ?? 0;
    }
    return out;
  }
  return [];
}

export async function readMp4Metadata(
  r: ByteReader,
  options: ReadOptions = {},
): Promise<ParsedMetadata> {
  const wantCover = options.cover !== false;
  const fileSize = await r.size();
  const moov = await findMoov(r, fileSize);
  if (!moov) {
    return { container: 'mp4', durationSec: 0, chapters: [], chapterSource: 'none' };
  }

  const moovKids = await children(r, moov.start + moov.headerSize, moov.end);

  let durationSec = 0;
  const mvhd = find(moovKids, 'mvhd');
  if (mvhd) {
    durationSec = parseMvhd(await r.read(mvhd.start + mvhd.headerSize, 112));
  }

  let tags: Awaited<ReturnType<typeof parseIlst>> = {};
  let neroChapters: ParsedChapter[] = [];

  const udta = find(moovKids, 'udta');
  if (udta) {
    const udtaKids = await children(r, udta.start + udta.headerSize, udta.end);
    const chpl = find(udtaKids, 'chpl');
    if (chpl) neroChapters = await parseChpl(r, chpl);

    const meta = find(udtaKids, 'meta');
    if (meta) {
      // `meta` is a full atom: 4 extra bytes of version/flags before its children.
      const metaKids = await children(r, meta.start + meta.headerSize + 4, meta.end);
      const ilst = find(metaKids, 'ilst');
      if (ilst) tags = await parseIlst(r, ilst, wantCover);
    }
  }

  let chapters = neroChapters;
  let chapterSource: ParsedMetadata['chapterSource'] = neroChapters.length ? 'nero-chpl' : 'none';

  /**
   * Nero is preferred because it is one contiguous read, but its chapter count
   * is a single byte, so a book with more than 255 chapters is silently
   * truncated at exactly 255. When there is no Nero list, or when it has
   * saturated, fall back to the QuickTime track and take it if it has more.
   */
  if (chapters.length === 0 || chapters.length === NERO_MAX_CHAPTERS) {
    const qt = await parseQuickTimeChapters(r, moov, moovKids);
    if (qt.length > chapters.length) {
      chapters = qt;
      chapterSource = 'quicktime-text';
    }
  }

  return {
    container: 'mp4',
    title: tags.title,
    author: tags.author,
    narrator: tags.narrator,
    album: tags.album,
    year: tags.year,
    trackNumber: tags.trackNumber,
    durationSec,
    chapters,
    chapterSource,
    cover: tags.cover,
    drm: await hasEncryptedAudio(r, moovKids),
  };
}

/**
 * Audible and FairPlay files declare an encrypted sample entry in the audio
 * track's `stsd`. Detecting it lets the book be shown as unplayable rather than
 * failing the scan or vanishing.
 */
const DRM_SAMPLE_FORMATS = new Set(['drms', 'aavd', 'enca', 'encv', 'drmi']);

async function hasEncryptedAudio(r: ByteReader, moovKids: Atom[]): Promise<boolean> {
  for (const trak of moovKids.filter((a) => a.type === 'trak')) {
    const kids = await children(r, trak.start + trak.headerSize, trak.end);
    const mdia = find(kids, 'mdia');
    if (!mdia) continue;
    const mdiaKids = await children(r, mdia.start + mdia.headerSize, mdia.end);
    const minf = find(mdiaKids, 'minf');
    if (!minf) continue;
    const minfKids = await children(r, minf.start + minf.headerSize, minf.end);
    const stbl = find(minfKids, 'stbl');
    if (!stbl) continue;
    const stblKids = await children(r, stbl.start + stbl.headerSize, stbl.end);
    const stsd = find(stblKids, 'stsd');
    if (!stsd) continue;
    // stsd: 4 bytes version/flags, 4 bytes entry count, then sample entries.
    const entries = await children(r, stsd.start + stsd.headerSize + 8, stsd.end);
    if (entries.some((e) => DRM_SAMPLE_FORMATS.has(e.type))) return true;
  }
  return false;
}

/** Exposed so the spike can compare the two chapter sources against each other. */
export async function readMp4ChaptersBothWays(r: ByteReader) {
  const fileSize = await r.size();
  const moov = await findMoov(r, fileSize);
  if (!moov) return { nero: [], quicktime: [] };
  const moovKids = await children(r, moov.start + moov.headerSize, moov.end);
  const udta = find(moovKids, 'udta');
  let nero: ParsedChapter[] = [];
  if (udta) {
    const udtaKids = await children(r, udta.start + udta.headerSize, udta.end);
    const chpl = find(udtaKids, 'chpl');
    if (chpl) nero = await parseChpl(r, chpl);
  }
  const quicktime = await parseQuickTimeChapters(r, moov, moovKids);
  return { nero, quicktime };
}
