/**
 * Parser tests against the synthetic fixtures committed with the repo.
 *
 * Run with `npm test`. These cover the container shapes that matter: metadata
 * at the front and at the back of the file, both MP4 chapter formats, ID3v2.3
 * and v2.4, non-ASCII tags, and the 255-chapter Nero ceiling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { FIXTURE_DIR, ffprobe, hasFfprobe, memoryReader, nodeReader } from './helpers.ts';
import { readMp4Metadata } from '../src/lib/metadata/mp4.ts';
import { readMp3Metadata } from '../src/lib/metadata/mp3.ts';
import { readMetadata } from '../src/lib/metadata/index.ts';

const fixture = (name: string) => path.join(FIXTURE_DIR, name);

async function parse(name: string, options = {}) {
  const r = nodeReader(fixture(name));
  try {
    return name.endsWith('.mp3')
      ? { meta: await readMp3Metadata(r, options), reader: r }
      : { meta: await readMp4Metadata(r, options), reader: r };
  } finally {
    // Left open deliberately so callers can inspect bytesRead; closed below.
  }
}

describe('mp4 / m4b', () => {
  it('reads tags, duration and chapters with moov at the front', async () => {
    const { meta, reader } = await parse('faststart.m4b');
    assert.equal(meta.title, 'The Count of Monte Cristo');
    assert.equal(meta.author, 'Alexandre Dumas');
    assert.equal(meta.narrator, 'Bill Homewood');
    assert.equal(meta.chapters.length, 5);
    assert.equal(meta.chapterSource, 'nero-chpl');
    assert.equal(meta.chapters[0].title, 'Chapter 1 - Marseilles, The Arrival');
    assert.ok(Math.abs(meta.durationSec - 30) < 1, `duration ${meta.durationSec}`);
    await reader.close();
  });

  it('finds moov when it sits at the end of the file', async () => {
    const { meta, reader } = await parse('tailmoov.m4b');
    assert.equal(meta.title, 'The Count of Monte Cristo');
    assert.equal(meta.chapters.length, 5);
    await reader.close();
  });

  it('reads only a small part of the file', async () => {
    const { meta, reader } = await parse('tailmoov.m4b');
    assert.ok(meta.chapters.length > 0);
    // Comfortably under a megabyte regardless of how large the file is.
    assert.ok(reader.bytesRead < 1024 * 1024, `read ${reader.bytesRead} bytes`);
    await reader.close();
  });

  it('extracts an embedded cover', async () => {
    const { meta, reader } = await parse('cover_tail.m4b');
    assert.ok(meta.cover, 'expected a cover');
    assert.equal(meta.cover!.mime, 'image/jpeg');
    assert.ok(meta.cover!.bytes.length > 100);
    await reader.close();
  });

  it('skips the cover when asked, and reads less as a result', async () => {
    const withCover = await parse('cover_tail.m4b');
    const without = await parse('cover_tail.m4b', { cover: false });
    assert.ok(withCover.meta.cover);
    assert.equal(without.meta.cover, undefined);
    assert.ok(
      without.reader.bytesRead <= withCover.reader.bytesRead,
      'skipping the cover should never read more',
    );
    await withCover.reader.close();
    await without.reader.close();
  });

  it('decodes non-ASCII tags', async () => {
    const { meta, reader } = await parse('unicode.m4b');
    assert.equal(meta.title, 'Война и мир');
    assert.equal(meta.author, 'Лев Толстой');
    await reader.close();
  });

  it('falls back to the QuickTime track past the 255-chapter Nero ceiling', async () => {
    const { meta, reader } = await parse('many.m4b');
    assert.equal(meta.chapters.length, 300, 'Nero chpl truncates at 255');
    assert.equal(meta.chapterSource, 'quicktime-text');
    assert.equal(meta.chapters[299].title, 'Chapter 300');
    await reader.close();
  });

  it('reports no DRM on a plain file', async () => {
    const { meta, reader } = await parse('faststart.m4b');
    assert.equal(meta.drm, false);
    await reader.close();
  });
});

describe('mp3 / id3', () => {
  it('reads ID3v2.3 tags, chapters, cover and track number', async () => {
    const { meta, reader } = await parse('chap.mp3');
    assert.equal(meta.title, 'The Count of Monte Cristo');
    assert.equal(meta.author, 'Alexandre Dumas');
    assert.equal(meta.chapters.length, 5);
    assert.equal(meta.chapterSource, 'id3-chap');
    assert.ok(meta.cover, 'expected a cover');
    assert.equal(meta.trackNumber, 3, 'track "3/12" should parse as 3');
    await reader.close();
  });

  it('reads ID3v2.4 with accented text', async () => {
    const { meta, reader } = await parse('id3v24.mp3');
    assert.equal(meta.title, 'Les Misérables — Tome I');
    assert.equal(meta.author, 'Victor Hugo');
    await reader.close();
  });

  it('derives duration from the Xing header', async () => {
    const r = nodeReader(fixture('chap.mp3'));
    const meta = await readMp3Metadata(r);
    assert.equal(meta.durationSource, 'xing');
    assert.ok(Math.abs(meta.durationSec - 30) < 1, `duration ${meta.durationSec}`);
    await r.close();
  });
});

/**
 * ID3v2.2 picture frames.
 *
 * Two real books in the library — both Glen Cook rips — are tagged v2.2, where
 * the picture frame is `PIC` and names its format with three bare characters
 * instead of a null-terminated MIME string. Parsed as though it were a v2.3
 * `APIC`, the hunt for that terminator runs into the image and the cover comes
 * back with its first five to nine bytes missing: a JPEG with no SOI marker, a
 * PNG with no signature. Android drew noise for one and a blank cover for the
 * other, on every book in the rip, because every part carries the same tag.
 */
describe('id3v2.2 pictures', () => {
  const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

  const PNG_BYTES = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // length + IHDR
    ...new Array(40).fill(0x7f),
  ]);
  const JPEG_BYTES = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ...new Array(40).fill(0x42),
    0xff, 0xd9,
  ]);

  /** A v2.2 tag holding one TT2 and one PIC frame. */
  function v22Tag(format: string, image: Uint8Array, description = '') {
    const title = Uint8Array.from([0x00, ...ascii('Chapter 01: Legate')]);
    const pic = Uint8Array.from([
      0x00, // latin-1 description
      ...ascii(format), // three characters, no terminator
      0x03, // picture type: front cover
      ...ascii(description),
      0x00, // description terminator
      ...image,
    ]);

    const frame = (id: string, body: Uint8Array) =>
      Uint8Array.from([
        ...ascii(id),
        (body.length >> 16) & 0xff,
        (body.length >> 8) & 0xff,
        body.length & 0xff,
        ...body,
      ]);

    const frames = Uint8Array.from([...frame('TT2', title), ...frame('PIC', pic)]);
    const size = frames.length;
    return Uint8Array.from([
      ...ascii('ID3'),
      0x02, 0x00, 0x00, // version 2.2, no flags
      (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
      ...frames,
    ]);
  }

  it('keeps a PNG signature intact', async () => {
    const r = memoryReader(v22Tag('PNG', PNG_BYTES));
    const meta = await readMp3Metadata(r);
    assert.equal(meta.title, 'Chapter 01: Legate', 'v2.2 text frames still read');
    assert.ok(meta.cover, 'expected a cover');
    assert.equal(meta.cover!.mime, 'image/png');
    assert.deepEqual([...meta.cover!.bytes], [...PNG_BYTES]);
    await r.close();
  });

  it('keeps a JPEG SOI marker intact, description or not', async () => {
    for (const description of ['', 'Front cover']) {
      const r = memoryReader(v22Tag('JPG', JPEG_BYTES, description));
      const meta = await readMp3Metadata(r);
      assert.ok(meta.cover, `expected a cover (description ${JSON.stringify(description)})`);
      assert.equal(meta.cover!.mime, 'image/jpeg');
      assert.deepEqual([...meta.cover!.bytes], [...JPEG_BYTES]);
      await r.close();
    }
  });

  /**
   * The alignment guard, which is what catches the layouts nobody predicted.
   * A tag that lies about its description encoding leaves the picture a few
   * bytes along, and a decoder handed those bytes draws noise rather than
   * complaining — so the bytes are trimmed back to the image's own magic.
   */
  it('trims junk in front of the image', async () => {
    const tag = v22Tag('JPG', Uint8Array.from([0x00, 0x00, 0x00, ...JPEG_BYTES]));
    const r = memoryReader(tag);
    const meta = await readMp3Metadata(r);
    assert.ok(meta.cover, 'expected a cover');
    assert.deepEqual([...meta.cover!.bytes], [...JPEG_BYTES]);
    await r.close();
  });

  it('still reads a v2.3 APIC, whose layout is different', async () => {
    const { meta, reader } = await parse('chap.mp3');
    assert.ok(meta.cover, 'expected a cover');
    assert.ok(
      meta.cover!.bytes[0] === 0xff || meta.cover!.bytes[0] === 0x89,
      `v2.3 cover should start with an image magic, got ${meta.cover!.bytes[0]?.toString(16)}`,
    );
    await reader.close();
  });
});

describe('dispatcher', () => {
  it('routes by extension', async () => {
    const r = nodeReader(fixture('chap.mp3'));
    const meta = await readMetadata(r, 'chap.mp3');
    assert.equal(meta.chapters.length, 5);
    await r.close();
  });

  it('reports DRM for an .aax without reading it', async () => {
    const r = nodeReader(fixture('chap.mp3'));
    const meta = await readMetadata(r, 'book.aax');
    assert.equal(meta.drm, true);
    assert.equal(r.bytesRead, 0, 'should not read an encrypted container');
    await r.close();
  });
});

describe('agreement with ffprobe (fixtures)', { skip: !hasFfprobe && 'ffprobe not installed' }, () => {
  for (const name of [
    'faststart.m4b',
    'tailmoov.m4b',
    'cover_tail.m4b',
    'unicode.m4b',
    'chap.mp3',
    'id3v24.mp3',
  ]) {
    it(`${name} matches ffprobe`, { skip: !hasFfprobe }, async () => {
      const ref = ffprobe(fixture(name));
      assert.ok(ref, 'ffprobe failed');
      const { meta, reader } = await parse(name);
      assert.ok(
        Math.abs(meta.durationSec - ref!.durationSec) < 0.5,
        `duration ${meta.durationSec} vs ffprobe ${ref!.durationSec}`,
      );
      assert.equal(meta.chapters.length, ref!.chapters.length, 'chapter count');
      assert.equal(meta.title ?? '', ref!.title ?? '', 'title');
      await reader.close();
    });
  }
});
