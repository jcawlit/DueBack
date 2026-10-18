/**
 * The download's URL building and its stale-ino handling.
 *
 * The transfer itself is `expo-file-system`'s `DownloadTask`, which is
 * native and cannot run here — `tools/abs-test` proves the real thing
 * against the real server. What is tested here is everything around it that
 * can be got wrong silently: the address, the absence of a token in it, and
 * the file list a checkout is built from.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileDownloadUrl, StaleInoError } from '../src/lib/abs/client.ts';
import { audioFilesOf } from '../src/lib/abs/map.ts';

const SAMPLES = path.join(process.cwd(), 'tools', 'abs-test');
const sample = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(SAMPLES, name), 'utf8')) as Record<string, unknown>;

describe('the download address', () => {
  it('is the per-file endpoint, never the whole-item ZIP', () => {
    const url = fileDownloadUrl('http://host:13378', 'item-1', '844424933942304');
    assert.equal(url, 'http://host:13378/api/items/item-1/file/844424933942304/download');
    /*
     * GET /api/items/:id/download returns a ZIP of the entire item. It
     * cannot be resumed, cannot be played until complete, and would have to
     * be unpacked. Checking for its shape here is cheap insurance against
     * somebody reaching for the obvious-looking endpoint later.
     */
    assert.equal(/\/items\/[^/]+\/download$/.test(url), false, 'that is the ZIP endpoint');
  });

  it('never carries a token', () => {
    const url = fileDownloadUrl('http://host:13378', 'item-1', '99');
    assert.equal(url.includes('token='), false);
    assert.equal(url.includes('?'), false);
  });

  it('tolerates a trailing slash on the server address', () => {
    assert.equal(
      fileDownloadUrl('http://host:13378///', 'i', '1'),
      'http://host:13378/api/items/i/file/1/download',
    );
  });

  it('escapes an id that would otherwise change the path', () => {
    const url = fileDownloadUrl('http://host', 'a/b', '1');
    assert.equal(url, 'http://host/api/items/a%2Fb/file/1/download');
  });
});

describe('the files a checkout downloads', () => {
  it('reads ino, name and size off a real expanded item', () => {
    const files = audioFilesOf(sample('sample-item.json'));
    assert.equal(files.length, 1);
    assert.ok(files[0].ino.length > 0, 'the ino is what the download addresses');
    assert.equal(files[0].name, 'the-lighthouse-keeper.mp3');
    assert.ok(files[0].sizeBytes > 0, 'the size is what the budget is checked against');
  });

  it('reads every file of a multi-file book, in order', () => {
    const files = audioFilesOf(sample('sample-item-multi.json'));
    assert.equal(files.length, 3);
    assert.deepEqual(files.map((f) => f.name), [
      '01 - Dusk.mp3',
      '02 - Midnight.mp3',
      '03 - Dawn.mp3',
    ]);
    // Distinct inos: two files sharing one would download the same bytes
    // twice and leave the book silently wrong.
    assert.equal(new Set(files.map((f) => f.ino)).size, 3);
  });

  it('drops a file with no ino rather than building a broken URL', () => {
    const files = audioFilesOf({
      media: {
        audioFiles: [
          { ino: '1', metadata: { filename: 'a.mp3', size: 10 } },
          { metadata: { filename: 'b.mp3', size: 10 } },
          { ino: '', metadata: { filename: 'c.mp3', size: 10 } },
        ],
      },
    });
    assert.deepEqual(files.map((f) => f.name), ['a.mp3']);
  });

  it('is empty for an item with no audio at all', () => {
    assert.deepEqual(audioFilesOf({}), []);
    assert.deepEqual(audioFilesOf({ media: {} }), []);
  });

  it('copes with a numeric ino, which some payloads use', () => {
    const files = audioFilesOf({
      media: { audioFiles: [{ ino: 12345, metadata: { filename: 'a.mp3', size: 1 } }] },
    });
    assert.deepEqual(files, [{ ino: '12345', name: 'a.mp3', sizeBytes: 1 }]);
  });
});

describe('a stale ino', () => {
  it('is its own error, so the caller knows to re-read the item', () => {
    const error = new StaleInoError(2, 'part.mp3');
    assert.equal(error instanceof StaleInoError, true);
    assert.equal(error.partIndex, 2);
    assert.match(error.message, /part\.mp3/);
    // Distinguishable from a transport failure without parsing a string.
    assert.equal(error.name, 'StaleInoError');
  });
});
