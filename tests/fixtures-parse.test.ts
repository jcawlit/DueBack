/**
 * Parser behaviour against the generated F1–F20 test library.
 *
 * These are the parts of the device test plan that do not need a device: what
 * the metadata reader makes of a DRM-flagged file, a container truncated before
 * its `moov`, a megabyte of noise with an `.mp3` extension, a zero-length file,
 * and a book with more chapters than Nero's 255-entry ceiling can hold.
 *
 * The fixtures are large and git-ignored, so the whole suite skips itself when
 * they are absent. Generate them with `npm run make:fixtures`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeReader } from './helpers.ts';
import { readMetadata, isSupportedAudio, isUnsupportedAudio } from '../src/lib/metadata/index.ts';

const DIR = path.join(process.cwd(), 'fixtures', 'Audiobooks');
const present = fs.existsSync(DIR);

/** Reads one fixture, never throwing: the scanner must never be stopped. */
async function parse(relPath: string) {
  const file = path.join(DIR, relPath);
  const reader = nodeReader(file);
  try {
    return await readMetadata(reader, path.basename(file), { cover: true });
  } finally {
    await reader.close();
  }
}

describe('generated fixtures', { skip: present ? false : 'run npm run make:fixtures' }, () => {
  it('reads the baseline book and its chapters', async () => {
    const m = await parse('Hyperion - Dan Simmons/book.m4b');
    assert.equal(m.title, 'Hyperion');
    assert.equal(m.author, 'Dan Simmons');
    assert.equal(m.chapters.length, 5);
    assert.ok(m.durationSec > 25 && m.durationSec < 35, `duration ${m.durationSec}`);
    assert.ok(!m.drm);
  });

  it('flags a DRM-protected sample entry', async () => {
    const m = await parse('DRM/book.m4b');
    assert.equal(m.drm, true);
  });

  it('falls back past the 255-chapter Nero ceiling', async () => {
    const m = await parse('Chapters QT/book.m4b');
    // The point of the fixture: 300 chapters cannot come from a saturated
    // `chpl`, so reading all of them proves the QuickTime track was used.
    assert.equal(m.chapters.length, 300);
    assert.equal(m.chapters[0].startSec, 0);
    assert.ok(
      m.chapters[299].startSec > m.chapters[0].startSec,
      'chapters must be ordered',
    );
  });

  it('survives a container truncated before its moov', async () => {
    const m = await parse('Truncated/book.m4b');
    // No metadata is recoverable, but it must come back as a value rather
    // than throwing — one bad file never stops a scan.
    assert.equal(m.durationSec, 0);
    assert.equal(m.chapters.length, 0);
  });

  it('survives a megabyte of noise with an audio extension', async () => {
    const m = await parse('Corrupt/garbage.mp3');
    assert.equal(m.durationSec, 0);
    assert.equal(m.chapters.length, 0);
  });

  it('survives a zero-length file', async () => {
    const m = await parse('Zero/empty.m4b');
    assert.equal(m.durationSec, 0);
  });

  it('round-trips non-ASCII tags exactly', async () => {
    const m = await parse('Война и мир - Лев Толстой/книга.m4b');
    assert.equal(m.title, 'Война и мир');
    assert.equal(m.author, 'Лев Толстой');
  });

  it('reads a book whose path java.net.URI would reject', async () => {
    const m = await parse('Weird #1 %20 &= [v2]/Ünïcødé — 東京 #2.m4b');
    assert.equal(m.title, 'Weird Names');
  });

  it('extracts embedded artwork, and finds none where there is none', async () => {
    const withArt = await parse('Embedded Only/book.m4b');
    assert.ok(withArt.cover, 'expected embedded cover bytes');
    assert.ok(withArt.cover!.bytes.length > 1000);

    const without = await parse('No Art/book.mp3');
    assert.ok(!without.cover);
  });

  it('orders multi-part books by track tag, not filename', async () => {
    const a = await parse('Tag Wins/a.mp3');
    const b = await parse('Tag Wins/b.mp3');
    const c = await parse('Tag Wins/c.mp3');
    assert.equal(b.trackNumber, 1);
    assert.equal(c.trackNumber, 2);
    assert.equal(a.trackNumber, 3);
  });

  it('classifies the supported and unsupported extensions', () => {
    assert.ok(isSupportedAudio('book.m4b'));
    assert.ok(isSupportedAudio('book.m4a'));
    assert.ok(isSupportedAudio('book.mp3'));
    assert.ok(isUnsupportedAudio('book.flac'));
    assert.ok(isUnsupportedAudio('book.ogg'));
    assert.ok(!isSupportedAudio('book.mobi'));
    assert.ok(!isUnsupportedAudio('notes.txt'));
  });

  it('reads only a fraction of a large file', async () => {
    const file = path.join(DIR, 'Big/book.m4b');
    const size = fs.statSync(file).size;
    const reader = nodeReader(file);
    try {
      await readMetadata(reader, 'book.m4b', { cover: true });
      assert.ok(size > 20 * 1024 * 1024, `fixture too small to be meaningful: ${size}`);
      assert.ok(
        reader.bytesRead < 2 * 1024 * 1024,
        `read ${(reader.bytesRead / 1024 ** 2).toFixed(1)} MB of a ${(size / 1024 ** 2).toFixed(0)} MB file`,
      );
    } finally {
      await reader.close();
    }
  });
});
