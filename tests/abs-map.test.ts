/**
 * Mapping an Audiobookshelf item onto this app's model.
 *
 * Built on the real samples saved by `tools/abs-test/verify.sh`, not on
 * handwritten JSON. A payload somebody invented proves only that the mapper
 * agrees with whoever invented it; these came off a 2.37.1 server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  authorOf,
  catalogueEntries,
  catalogueEntry,
  chaptersFrom,
  detailFrom,
  narratorOf,
  seriesOf,
} from '../src/lib/abs/map.ts';

const SAMPLES = path.join(process.cwd(), 'tools', 'abs-test');

function sample(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES, name), 'utf8'));
}

/** The single-file book: every tag present, no chapter marks. */
const tagged = sample('sample-item.json');
/** The three-file book: chapters derived from the files, by the server. */
const multi = sample('sample-item-multi.json');

describe('the structured fields, which only an expanded item carries', () => {
  it('prefers authors[] over the flattened authorName', () => {
    assert.equal(authorOf({ authors: [{ name: 'Marla Finch' }], authorName: 'WRONG' }), 'Marla Finch');
    assert.equal(authorOf({ authors: [{ name: 'A' }, { name: 'B' }] }), 'A, B');
  });

  it('falls back to authorName, which is all a minified item has', () => {
    assert.equal(authorOf({ authorName: 'Marla Finch' }), 'Marla Finch');
    assert.equal(authorOf({ authors: [], authorName: 'Marla Finch' }), 'Marla Finch');
    assert.equal(authorOf({}), '');
  });

  it('reads narrators, which arrive as bare strings rather than objects', () => {
    assert.equal(narratorOf({ narrators: ['Nell Ward'] }), 'Nell Ward');
    assert.equal(narratorOf({ narratorName: 'Nell Ward' }), 'Nell Ward');
    assert.equal(narratorOf({ narrators: [], narratorName: '' }), '');
  });

  it('rebuilds the series string from name and sequence', () => {
    assert.equal(seriesOf({ series: [{ name: 'Keepers', sequence: '1' }] }), 'Keepers #1');
    // The flattened form the server produces must come out identical, so
    // the catalogue and the book screen can never disagree.
    assert.equal(seriesOf({ seriesName: 'Keepers #1' }), 'Keepers #1');
    // A series with no number is its name, not "Keepers #".
    assert.equal(seriesOf({ series: [{ name: 'Keepers', sequence: '' }] }), 'Keepers');
    assert.equal(seriesOf({}), '');
  });
});

describe('a catalogue entry, from the real single-file sample', () => {
  const entry = catalogueEntry(tagged)!;

  it('reads the tags the server parsed out of the file', () => {
    assert.equal(entry.title, 'The Lighthouse Keeper');
    assert.equal(entry.author, 'Marla Finch');
    assert.equal(entry.narrator, 'Nell Ward');
    assert.equal(entry.series, 'Keepers #1');
    assert.deepEqual(entry.genres, ['Fiction']);
  });

  it('reads the facts the shelves sort and group on', () => {
    assert.equal(entry.durationSec, 600);
    assert.ok(entry.sizeBytes > 0);
    assert.equal(entry.hasCover, true);
    assert.equal(entry.isMissing, false);
    assert.ok(entry.updatedAt > 0, 'updatedAt is the whole of the refresh diff');
    assert.equal(entry.remoteId, tagged.id);
  });
});

describe('a catalogue entry, from a minified list item', () => {
  // What GET /api/libraries/:id/items?minified=1 actually returns: the
  // flattened fields and nothing structured.
  const minified = {
    id: 'abc',
    relPath: 'The Unmarked Box',
    updatedAt: 1792196925597,
    isMissing: false,
    size: 1680451,
    media: {
      metadata: { title: 'The Unmarked Box', authorName: '', narratorName: '', seriesName: '', genres: [] },
      coverPath: null,
      duration: 420,
      size: 1680451,
      numChapters: 0,
      numTracks: 1,
    },
  };

  it('maps a book the server knows almost nothing about', () => {
    const entry = catalogueEntry(minified)!;
    assert.equal(entry.title, 'The Unmarked Box');
    assert.equal(entry.author, '');
    assert.equal(entry.narrator, '');
    assert.equal(entry.series, '');
    assert.equal(entry.hasCover, false, 'a null coverPath is no cover');
    assert.equal(entry.durationSec, 420);
    assert.equal(entry.chapterCount, 0);
    assert.equal(entry.trackCount, 1);
  });

  it('keeps a book that has no title rather than dropping it silently', () => {
    const entry = catalogueEntry({ ...minified, media: { ...minified.media, metadata: {} } })!;
    assert.equal(entry.title, 'The Unmarked Box', 'falls back to the folder name');
    const nameless = catalogueEntry({ id: 'x', media: {} })!;
    assert.equal(nameless.title, 'Untitled');
  });

  it('refuses only an item with no id, which cannot be identified at all', () => {
    assert.equal(catalogueEntry({ media: {} }), null);
    assert.equal(catalogueEntry({ id: '' }), null);
    assert.deepEqual(catalogueEntries([{ id: 'a' }, { nope: 1 }, null, 'x']).map((e) => e.remoteId), ['a']);
  });
});

describe('chapters', () => {
  it('reads the server chapters off the three-file book', () => {
    const { chapters, fromParts } = chaptersFrom(multi);
    assert.deepEqual(
      chapters,
      [
        { title: 'Dusk', startSec: 0 },
        { title: 'Midnight', startSec: 300 },
        { title: 'Dawn', startSec: 600 },
      ],
    );
    assert.equal(fromParts, false, 'these are real chapter titles, not file names');
  });

  it('sorts chapters by where they start, which nothing in the API promises', () => {
    const { chapters } = chaptersFrom({
      media: {
        chapters: [
          { title: 'Three', start: 600 },
          { title: 'One', start: 0 },
          { title: 'Two', start: 300 },
        ],
      },
    });
    assert.deepEqual(chapters.map((c) => c.title), ['One', 'Two', 'Three']);
  });

  it('gives a single untagged file no chapters rather than one fake one', () => {
    // The real sample: one file, no chapter marks. One chapter spanning the
    // whole book tells the listener nothing they did not already know.
    const { chapters, fromParts } = chaptersFrom(tagged);
    assert.deepEqual(chapters, []);
    assert.equal(fromParts, false);
  });

  it('falls back to one chapter per file, and says that is what it did', () => {
    const { chapters, fromParts } = chaptersFrom({
      media: {
        chapters: [],
        tracks: [
          { index: 2, title: 'part2.mp3', startOffset: 300 },
          { index: 1, title: 'part1.mp3', startOffset: 0 },
        ],
      },
    });
    assert.deepEqual(chapters, [
      { title: 'part1.mp3', startSec: 0 },
      { title: 'part2.mp3', startSec: 300 },
    ]);
    assert.equal(fromParts, true, 'the lock screen needs to know these are parts');
  });

  it('numbers a nameless track rather than showing an empty row', () => {
    const { chapters } = chaptersFrom({
      media: { tracks: [{ startOffset: 0 }, { startOffset: 10 }] },
    });
    assert.deepEqual(chapters.map((c) => c.title), ['Part 1', 'Part 2']);
  });
});

describe('the expanded detail', () => {
  it('carries the tracks, in order, with their offsets', () => {
    const detail = detailFrom(multi);
    assert.equal(detail.chapters.length, 3);
    assert.equal(detail.durationSec, 900);
    assert.ok(detail.sizeBytes > 0);
    assert.equal(detail.tracks.length, 3);
    assert.deepEqual(detail.tracks.map((t) => t.startSec), [0, 300, 600]);
    for (const track of detail.tracks) {
      assert.ok(track.contentUrl.length > 0, 'every track needs an address');
      assert.equal(track.contentUrl.includes('token='), false, 'never a token in a URL');
    }
  });

  it('survives an item with no media at all', () => {
    const detail = detailFrom({});
    assert.deepEqual(detail.chapters, []);
    assert.equal(detail.durationSec, 0);
    assert.deepEqual(detail.tracks, []);
  });
});
