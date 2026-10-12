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
import { FIXTURE_DIR, ffprobe, hasFfprobe, nodeReader } from './helpers.ts';
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
