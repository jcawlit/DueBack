/**
 * MP3 / ID3v2 metadata reader.
 *
 * The ID3v2 header at byte 0 states its own length, so one read of that span
 * gets every tag: TIT2/TPE1/TCOM, the APIC cover, and the CHAP/CTOC chapter
 * frames. Duration comes from the Xing/Info or VBRI header in the first audio
 * frame, which is what variable-bitrate encoders write; failing that it is
 * estimated from the bitrate of the first frame.
 */

import { type ByteReader, decodeText, u32, utf8 } from './reader.ts';
import type { ParsedChapter, ReadOptions } from './mp4.ts';

export type ParsedMp3 = {
  container: 'mp3';
  title?: string;
  author?: string;
  narrator?: string;
  album?: string;
  year?: string;
  durationSec: number;
  durationSource: 'xing' | 'vbri' | 'bitrate-estimate' | 'none';
  chapters: ParsedChapter[];
  chapterSource: 'id3-chap' | 'none';
  cover?: { bytes: Uint8Array; mime: string };
  /** From `TRCK`; used to order the parts of a multi-file book. */
  trackNumber?: number;
  drm?: boolean;
};

/** ID3 sizes are "synchsafe": 7 bits per byte, high bit always clear. */
function synchsafe(b: Uint8Array, o: number) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

type Frame = { id: string; body: Uint8Array };

/** Walks the frames inside an ID3v2 tag body. */
function readFrames(tag: Uint8Array, version: number, start: number, end: number): Frame[] {
  const out: Frame[] = [];
  let p = start;
  const idLen = version === 2 ? 3 : 4;
  const sizeLen = version === 2 ? 3 : 4;
  const flagLen = version === 2 ? 0 : 2;

  while (p + idLen + sizeLen + flagLen <= end) {
    const id = String.fromCharCode(...tag.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    let size: number;
    if (version === 2) {
      size = (tag[p + 3] << 16) | (tag[p + 4] << 8) | tag[p + 5];
    } else if (version === 4) {
      size = synchsafe(tag, p + 4);
    } else {
      size = u32(tag, p + 4);
    }
    const bodyStart = p + idLen + sizeLen + flagLen;
    const bodyEnd = Math.min(bodyStart + size, end);
    if (size <= 0 || bodyEnd <= bodyStart) break;
    out.push({ id, body: tag.subarray(bodyStart, bodyEnd) });
    p = bodyStart + size;
  }
  return out;
}

function textFrame(body: Uint8Array): string {
  if (body.length < 1) return '';
  return decodeText(body.subarray(1), body[0]);
}

/**
 * The image inside a picture frame.
 *
 * There are two layouts, and the difference is not cosmetic. `APIC`, in
 * ID3v2.3 and 2.4, names its format with a null-terminated MIME string. `PIC`,
 * in ID3v2.2, uses a fixed three-character code — `JPG`, `PNG` — with no
 * terminator at all. Reading a v2.2 frame as though it were a v2.3 one sends
 * `indexOf(0, …)` hunting for a NUL inside the picture itself: it lands five
 * or nine bytes in and hands back a JPEG with no SOI marker, or a PNG with no
 * signature. Android draws noise for the one and nothing at all for the other,
 * and because every part of a book carries the same tag, the whole book loses
 * its cover — as did every v2.2-tagged rip in the library.
 */
function parsePicture(
  body: Uint8Array,
  version: number,
): { bytes: Uint8Array; mime: string } | undefined {
  if (body.length < 5) return undefined;
  const encoding = body[0];
  let p = 1;
  let mime: string;

  if (version === 2) {
    const code = utf8.decode(body.subarray(1, 4)).trim().toLowerCase();
    mime = code === 'png' ? 'image/png' : code === 'jpg' ? 'image/jpeg' : `image/${code}`;
    p = 4;
  } else {
    const mimeEnd = body.indexOf(0, p);
    if (mimeEnd < 0) return undefined;
    mime = utf8.decode(body.subarray(p, mimeEnd));
    p = mimeEnd + 1;
  }

  p += 1; // picture type
  // Description, terminated by one NUL (latin1/utf8) or two (UTF-16).
  if (encoding === 1 || encoding === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    const descEnd = body.indexOf(0, p);
    if (descEnd < 0) return undefined;
    p = descEnd + 1;
  }
  if (p >= body.length) return undefined;

  return { bytes: alignToImage(body.subarray(p)), mime: mime || 'image/jpeg' };
}

/** JPEG, PNG, GIF or WebP magic at `o`. */
function imageMagicAt(b: Uint8Array, o: number): boolean {
  if (b[o] === 0xff && b[o + 1] === 0xd8 && b[o + 2] === 0xff) return true;
  if (b[o] === 0x89 && b[o + 1] === 0x50 && b[o + 2] === 0x4e && b[o + 3] === 0x47) return true;
  if (b[o] === 0x47 && b[o + 1] === 0x49 && b[o + 2] === 0x46 && b[o + 3] === 0x38) return true;
  if (
    b[o] === 0x52 && b[o + 1] === 0x49 && b[o + 2] === 0x46 && b[o + 3] === 0x46 &&
    b[o + 8] === 0x57 && b[o + 9] === 0x45 && b[o + 10] === 0x42 && b[o + 11] === 0x50
  ) {
    return true;
  }
  return false;
}

/**
 * Trims anything before the image's own magic number.
 *
 * A last line of defence rather than the main event. Tags in the wild carry
 * stray padding, mislabelled description encodings and the occasional byte
 * order mark, and each of those shifts the picture by a few bytes. A decoder
 * handed those bytes does not complain — it draws nothing, or it draws noise —
 * so proving that the first bytes really are an image is worth the look. Bytes
 * that already begin with a signature are returned untouched.
 */
function alignToImage(bytes: Uint8Array): Uint8Array {
  if (imageMagicAt(bytes, 0)) return bytes;
  const limit = Math.min(bytes.length, 64);
  for (let i = 1; i < limit; i += 1) {
    if (imageMagicAt(bytes, i)) return bytes.subarray(i);
  }
  return bytes;
}

/** CHAP: element id\0, start ms, end ms, start byte, end byte, then subframes. */
function parseChap(frame: Frame, version: number): ParsedChapter | null {
  const body = frame.body;
  const idEnd = body.indexOf(0);
  if (idEnd < 0 || idEnd + 17 > body.length) return null;
  const startMs = u32(body, idEnd + 1);
  let title = '';
  const subStart = idEnd + 1 + 16;
  for (const sub of readFrames(body, version, subStart, body.length)) {
    if (sub.id === 'TIT2' || sub.id === 'TT2') {
      title = textFrame(sub.body);
      break;
    }
  }
  return { title, startSec: startMs / 1000 };
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

/**
 * Duration from the first audio frame's Xing/Info or VBRI header, which records
 * the total frame count. Without one, estimate from the first frame's bitrate.
 */
function durationFromFirstFrame(
  buf: Uint8Array,
  audioBytes: number,
): { sec: number; source: ParsedMp3['durationSource'] } {
  for (let i = 0; i + 4 < buf.length; i += 1) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (buf[i + 1] >> 3) & 0x03;
    const layerBits = (buf[i + 1] >> 1) & 0x03;
    if (layerBits !== 1) continue; // layer III only
    const bitrateIndex = (buf[i + 2] >> 4) & 0x0f;
    const rateIndex = (buf[i + 2] >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) continue;
    const mpeg1 = versionBits === 3;
    const bitrate = (mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] * 1000;
    const sampleRate = SAMPLE_RATES[versionBits]?.[rateIndex];
    if (!bitrate || !sampleRate) continue;
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const channelMode = (buf[i + 3] >> 6) & 0x03;

    // Xing/Info sits at a fixed offset after the header, which depends on
    // version and whether the stream is mono.
    const xingOffset = i + 4 + (mpeg1 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17);
    if (xingOffset + 12 <= buf.length) {
      const tag = String.fromCharCode(...buf.subarray(xingOffset, xingOffset + 4));
      if (tag === 'Xing' || tag === 'Info') {
        const flags = u32(buf, xingOffset + 4);
        if (flags & 1) {
          const frames = u32(buf, xingOffset + 8);
          return { sec: (frames * samplesPerFrame) / sampleRate, source: 'xing' };
        }
      }
    }
    const vbriOffset = i + 4 + 32;
    if (vbriOffset + 26 <= buf.length) {
      const tag = String.fromCharCode(...buf.subarray(vbriOffset, vbriOffset + 4));
      if (tag === 'VBRI') {
        const frames = u32(buf, vbriOffset + 14);
        return { sec: (frames * samplesPerFrame) / sampleRate, source: 'vbri' };
      }
    }
    return { sec: (audioBytes * 8) / bitrate, source: 'bitrate-estimate' };
  }
  return { sec: 0, source: 'none' };
}

/** Frames worth reading. Everything else is skipped without touching its body. */
const WANTED_FRAMES = new Set([
  'TIT2', 'TT2', 'TPE1', 'TP1', 'TCOM', 'TCM', 'TALB', 'TAL',
  'TYER', 'TDRC', 'TRCK', 'TRK', 'CHAP',
]);

/** Text frames are never large; a title past this is corrupt, not long. */
const TEXT_FRAME_CAP = 8 * 1024;
const CHAP_FRAME_CAP = 64 * 1024;
const COVER_CAP = 8 * 1024 * 1024;

/**
 * Walks the frames of an ID3v2 tag with targeted reads, skipping over the body
 * of anything unwanted.
 *
 * This matters more than it looks: every part of a multi-file book often
 * embeds the same 600 KB cover, so slurping the whole tag turns a 127-part
 * book into ~87 MB of reads. Skipping an unwanted APIC jumps the reader
 * straight past it.
 */
async function walkFrames(
  r: ByteReader,
  version: number,
  start: number,
  end: number,
  wantCover: boolean,
): Promise<Frame[]> {
  const out: Frame[] = [];
  const idLen = version === 2 ? 3 : 4;
  const sizeLen = version === 2 ? 3 : 4;
  const flagLen = version === 2 ? 0 : 2;
  const headerLen = idLen + sizeLen + flagLen;

  let p = start;
  while (p + headerLen <= end) {
    const header = await r.read(p, headerLen);
    if (header.length < headerLen) break;
    const id = String.fromCharCode(...header.subarray(0, idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding or end of frames

    let size: number;
    if (version === 2) {
      size = (header[3] << 16) | (header[4] << 8) | header[5];
    } else if (version === 4) {
      size = synchsafe(header, 4);
    } else {
      size = u32(header, 4);
    }
    if (size <= 0) break;

    const bodyStart = p + headerLen;
    const isCover = id === 'APIC' || id === 'PIC';
    const wanted = WANTED_FRAMES.has(id) || (isCover && wantCover);
    if (wanted) {
      const cap = isCover ? COVER_CAP : id === 'CHAP' ? CHAP_FRAME_CAP : TEXT_FRAME_CAP;
      if (size <= cap) {
        const body = await r.read(bodyStart, Math.min(size, end - bodyStart));
        out.push({ id, body });
      }
    }
    p = bodyStart + size;
  }
  return out;
}

export async function readMp3Metadata(
  r: ByteReader,
  options: ReadOptions = {},
): Promise<ParsedMp3> {
  const wantCover = options.cover !== false;
  const fileSize = await r.size();
  const head = await r.read(0, 10);

  let tagSize = 0;
  let version = 3;
  let frames: Frame[] = [];

  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    version = head[3];
    tagSize = synchsafe(head, 6);
    let start = 10;
    // An extended header, if present, sits before the frames.
    if (head[5] & 0x40) {
      const ext = await r.read(10, 8);
      start += version === 4 ? synchsafe(ext, 0) : u32(ext, 0) + 4;
    }
    frames = await walkFrames(r, version, start, 10 + tagSize, wantCover);
  }

  const out: ParsedMp3 = {
    container: 'mp3',
    durationSec: 0,
    durationSource: 'none',
    chapters: [],
    chapterSource: 'none',
  };

  const chapters: ParsedChapter[] = [];
  for (const f of frames) {
    switch (f.id) {
      case 'TIT2':
      case 'TT2':
        out.title = textFrame(f.body);
        break;
      case 'TPE1':
      case 'TP1':
        out.author = textFrame(f.body);
        break;
      case 'TCOM':
      case 'TCM':
        out.narrator = textFrame(f.body);
        break;
      case 'TALB':
      case 'TAL':
        out.album = textFrame(f.body);
        break;
      case 'TYER':
      case 'TDRC':
        out.year = textFrame(f.body);
        break;
      case 'TRCK':
      case 'TRK': {
        // "7" or "7/149" — only the leading number matters for ordering.
        const n = parseInt(textFrame(f.body), 10);
        if (Number.isFinite(n) && n > 0) out.trackNumber = n;
        break;
      }
      case 'APIC':
      case 'PIC':
        if (wantCover && !out.cover) out.cover = parsePicture(f.body, version);
        break;
      case 'CHAP': {
        const c = parseChap(f, version);
        if (c) chapters.push(c);
        break;
      }
      default:
        break;
    }
  }

  if (chapters.length > 0) {
    chapters.sort((a, b) => a.startSec - b.startSec);
    out.chapters = chapters;
    out.chapterSource = 'id3-chap';
  }

  const audioStart = tagSize > 0 ? 10 + tagSize : 0;
  const firstFrame = await r.read(audioStart, 4096);
  const { sec, source } = durationFromFirstFrame(firstFrame, fileSize - audioStart);
  out.durationSec = sec;
  out.durationSource = source;

  return out;
}
