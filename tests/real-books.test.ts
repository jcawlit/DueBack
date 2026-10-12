/**
 * Tests against the real audiobooks in `audiobooks/`.
 *
 * Those files are copyrighted and git-ignored, so they are absent on most
 * machines. Every test here skips itself when the folder is missing rather than
 * failing, which keeps `npm test` green on a fresh clone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REAL_DIR, ffprobe, hasFfprobe, hasRealBooks, nodeReader, walk } from './helpers.ts';
import { readMetadata, isSupportedAudio } from '../src/lib/metadata/index.ts';
import { groupIntoBooks, orderParts, type ScannedFile } from '../src/lib/library/grouping.ts';
import { resolveName } from '../src/lib/library/names.ts';

const skip = !hasRealBooks ? 'audiobooks/ not present' : false;

/** Describes the real tree the way the scanner's access layer would. */
function scanTree(): ScannedFile[] {
  return walk(REAL_DIR).map((abs) => {
    const relPath = path.relative(REAL_DIR, abs).split(path.sep).join('/');
    const stat = fs.statSync(abs);
    return {
      relPath,
      name: path.basename(abs),
      uri: abs,
      sizeBytes: stat.size,
      modifiedMs: stat.mtimeMs,
    };
  });
}

describe('real audiobooks', { skip }, () => {
  it('groups the tree into one book per folder', () => {
    const groups = groupIntoBooks(scanTree());
    assert.ok(groups.length >= 1, 'expected at least one book');
    for (const g of groups) {
      assert.ok(g.files.length > 0 || g.drmFiles > 0, `${g.folderName} has no audio`);
      for (const f of g.files) {
        assert.ok(isSupportedAudio(f.name), `${f.name} should be supported audio`);
      }
    }
  });

  it('never turns a non-audio file into a book', () => {
    const tree = scanTree();
    const groups = groupIntoBooks(tree);
    const grouped = new Set(groups.flatMap((g) => g.files.map((f) => f.relPath)));
    for (const f of tree) {
      if (!isSupportedAudio(f.name)) {
        assert.ok(!grouped.has(f.relPath), `${f.name} must not be part of a book`);
      }
    }
    // An ebook beside an audiobook must not create an extra book.
    const ebooks = tree.filter((f) => /\.(mobi|epub|azw3?|pdf)$/i.test(f.name));
    for (const e of ebooks) {
      const folder = e.relPath.slice(0, e.relPath.lastIndexOf('/'));
      const inFolder = groups.filter((g) => g.folderRelPath === folder);
      assert.ok(inFolder.length <= 1, `${folder} split into ${inFolder.length} books`);
    }
  });

  it('orders multi-part books without gaps or duplicates', async () => {
    const groups = groupIntoBooks(scanTree()).filter((g) => g.files.length > 1);
    if (groups.length === 0) return;

    for (const g of groups) {
      const parts = [];
      for (const f of g.files) {
        const r = nodeReader(f.uri);
        const meta = await readMetadata(r, f.name, { cover: false });
        await r.close();
        parts.push({ file: f, trackNumber: meta.trackNumber });
      }
      const ordered = orderParts(parts);
      assert.equal(ordered.parts.length, g.files.length, 'no parts lost');
      const seen = new Set(ordered.parts.map((p) => p.file.relPath));
      assert.equal(seen.size, g.files.length, 'no duplicate parts');

      if (ordered.basis === 'tags') {
        const nums = ordered.parts.map((p) => p.trackNumber!);
        for (let i = 1; i < nums.length; i += 1) {
          assert.ok(nums[i] > nums[i - 1], 'track numbers must ascend');
        }
      }
    }
  });

  it('resolves a title for every book', async () => {
    for (const g of groupIntoBooks(scanTree())) {
      if (g.files.length === 0) continue;
      const first = g.files[0];
      const r = nodeReader(first.uri);
      const meta = await readMetadata(r, first.name, { cover: false });
      await r.close();
      const name = resolveName({
        folderName: g.folderName,
        embeddedTitle: g.files.length > 1 ? meta.album : meta.title,
        embeddedAuthor: meta.author,
      });
      assert.ok(name.title.length > 0, `no title for ${g.folderName}`);
      assert.ok(!/\[|\]|\bunabridged\b/i.test(name.title), `title not cleaned: ${name.title}`);
    }
  });

  it('agrees with ffprobe on every real file', { skip: skip || !hasFfprobe }, async () => {
    const files = walk(REAL_DIR).filter((f) => isSupportedAudio(path.basename(f)));
    let checked = 0;
    for (const f of files) {
      const ref = ffprobe(f);
      if (!ref) continue;
      const r = nodeReader(f);
      const meta = await readMetadata(r, path.basename(f));
      await r.close();
      assert.ok(
        Math.abs(meta.durationSec - ref.durationSec) < 0.5,
        `${path.basename(f)}: duration ${meta.durationSec} vs ffprobe ${ref.durationSec}`,
      );
      assert.equal(
        meta.chapters.length,
        ref.chapters.length,
        `${path.basename(f)}: chapter count`,
      );
      checked += 1;
    }
    assert.ok(checked > 0, 'no real files were checked');
  });

  it('reads a book without pulling in its cover more than once', async () => {
    const groups = groupIntoBooks(scanTree()).filter((g) => g.files.length > 3);
    if (groups.length === 0) return;
    const g = groups[0];

    let bytesWithoutCovers = 0;
    for (const f of g.files) {
      const r = nodeReader(f.uri);
      await readMetadata(r, f.name, { cover: false });
      bytesWithoutCovers += r.bytesRead;
      await r.close();
    }

    let bytesWithCovers = 0;
    for (const f of g.files) {
      const r = nodeReader(f.uri);
      await readMetadata(r, f.name);
      bytesWithCovers += r.bytesRead;
      await r.close();
    }

    assert.ok(
      bytesWithoutCovers < bytesWithCovers,
      `skipping covers should read less (${bytesWithoutCovers} vs ${bytesWithCovers})`,
    );
  });
});
