/**
 * Ordering and naming the parts of a book added from the phone.
 *
 * "Add a book folder" used to list the picked folder's immediate files only,
 * so a book arranged as `Disc 1/` and `Disc 2/` — an ordinary shape for a
 * ripped audiobook — yielded no audio and was refused as if it held none. The
 * mixed case was worse: a stray intro file loose at the top with the rest in
 * subfolders imported as a one-part book.
 *
 * The walk now descends, which puts two new rules in play and both are here:
 * parts order by path so discs do not interleave, and a part out of a
 * subfolder is renamed to carry it, because that name is what the file is
 * called if the book is later pushed to the drive into one flat folder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orderImportedParts } from '../src/lib/library/importOrder.ts';

const names = (paths: string[]) =>
  orderImportedParts(paths.map((path) => ({ path }))).map((p) => p.name);

describe('ordering', () => {
  it('keeps a flat book in natural order', () => {
    // "Part 2" before "Part 10": the whole reason it is not a string sort.
    assert.deepEqual(
      names(['Part 10.mp3', 'Part 2.mp3', 'Part 1.mp3']),
      ['Part 1.mp3', 'Part 2.mp3', 'Part 10.mp3'],
    );
  });

  it('plays all of disc one before any of disc two', () => {
    /*
     * The case that matters. Both discs number their files from one, so
     * sorting on the filename alone interleaves them and the book plays
     * 1, 1, 2, 2 — out of order in a way that sounds like a broken file.
     */
    assert.deepEqual(
      names(['Disc 2/01.mp3', 'Disc 1/02.mp3', 'Disc 1/01.mp3', 'Disc 2/02.mp3']),
      ['Disc 1 - 01.mp3', 'Disc 1 - 02.mp3', 'Disc 2 - 01.mp3', 'Disc 2 - 02.mp3'],
    );
  });

  it('puts a loose file at the top ahead of a subfolder, by name', () => {
    // Nothing clever: "00 Intro.mp3" sorts before "Disc 1/…" on the path,
    // which is the order anyone naming a file "00" intended.
    assert.deepEqual(
      names(['Disc 1/01.mp3', '00 Intro.mp3']),
      ['00 Intro.mp3', 'Disc 1 - 01.mp3'],
    );
  });

  it('does not mutate what it was given', () => {
    const input = [{ path: 'b.mp3' }, { path: 'a.mp3' }];
    orderImportedParts(input);
    assert.deepEqual(input.map((p) => p.path), ['b.mp3', 'a.mp3']);
  });
});

describe('naming', () => {
  it('leaves a top-level file’s name exactly alone', () => {
    assert.deepEqual(names(['Hyperion - Part 1.m4b']), ['Hyperion - Part 1.m4b']);
  });

  it('gives two discs’ identically-named parts different names', () => {
    /*
     * A push to the drive writes every part into one flat folder, by this
     * name. Two `01.mp3` files would mean the second landing on the first:
     * a book that plays disc two twice and has lost disc one.
     */
    const out = names(['Disc 1/01.mp3', 'Disc 2/01.mp3']);
    assert.equal(new Set(out).size, 2, 'the names must differ');
    assert.deepEqual(out, ['Disc 1 - 01.mp3', 'Disc 2 - 01.mp3']);
  });

  it('keeps the extension at the end, where the mime lookup reads it', () => {
    for (const name of names(['CD 1/track01.mp3', 'A/B/part.m4b'])) {
      assert.match(name, /\.(mp3|m4b)$/);
    }
  });

  it('flattens a second level too', () => {
    assert.deepEqual(names(['Audio/Disc 1/01.mp3']), ['Audio - Disc 1 - 01.mp3']);
  });

  it('carries every other field through untouched', () => {
    const [part] = orderImportedParts([{ path: 'Disc 1/01.mp3', uri: 'content://x' }]);
    assert.equal(part.uri, 'content://x');
    assert.equal(part.path, 'Disc 1/01.mp3');
    assert.equal(part.name, 'Disc 1 - 01.mp3');
  });
});
