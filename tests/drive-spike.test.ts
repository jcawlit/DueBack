/**
 * SPIKE — throwaway, alongside `src/lib/spike/`.
 *
 * Only the pure half can be tested here: everything that matters about
 * Drive is what a real provider does on a real phone, and no test can
 * stand in for that. What this pins is the reasoning the probe's verdict
 * rests on, so that a number read off the screen means what the report
 * says it means.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sameBooks } from '../src/lib/spike/identity.ts';
import { fingerprintKey, groupIntoBooks } from '../src/lib/library/grouping.ts';
import type { ScannedFile } from '../src/lib/library/grouping.ts';

function file(relPath: string, sizeBytes = 1000): ScannedFile {
  const parts = relPath.split('/');
  return {
    relPath,
    name: parts[parts.length - 1],
    uri: `content://com.google.android.apps.docs.storage/tree/x/document/${encodeURIComponent(relPath)}`,
    sizeBytes,
    modifiedMs: 1,
    folderRelPath: parts.slice(0, -1).join('/'),
  } as ScannedFile;
}

describe('whether two listings describe the same library', () => {
  it('is stable when the same books come back', () => {
    const verdict = sameBooks(['a', 'b', 'c'], ['a', 'b', 'c']);
    assert.equal(verdict.same, true);
    assert.match(verdict.detail, /3 books/);
  });

  it('notices a different count at once', () => {
    const verdict = sameBooks(['a', 'b'], ['a']);
    assert.equal(verdict.same, false);
    assert.match(verdict.detail, /2 books, then 1/);
  });

  it('notices a swap, which a count alone would miss', () => {
    // The failure mode that would matter: the provider hands back the same
    // number of books under different identities, which to the scanner
    // reads as the whole library being replaced.
    const verdict = sameBooks(['a', 'b'], ['a', 'c']);
    assert.equal(verdict.same, false);
    assert.match(verdict.detail, /1 vanished, 1 appeared/);
  });

  it('does not care what order they came back in', () => {
    // A provider is under no obligation to list twice in the same order,
    // and treating that as instability would condemn Drive for nothing.
    assert.equal(sameBooks(['a', 'b', 'c'], ['c', 'a', 'b']).same, true);
  });

  it('calls two empty listings the same', () => {
    assert.equal(sameBooks([], []).same, true);
  });
});

describe('identity over a provider URI', () => {
  it('is built from the path, not the URI the provider handed out', () => {
    /*
     * The thing that decides whether Drive can work at all: a document URI
     * contains a provider-chosen document id, and there is no promise it is
     * the same between sessions. The scanner keys a book on its *path*, so
     * a URI that churns does not move a book — which is why this is worth
     * asserting rather than assuming.
     */
    const a = fingerprintKey('Author/Book', 'Author/Book/01.mp3');
    const b = fingerprintKey('Author/Book', 'Author/Book/01.mp3');
    assert.equal(a, b);
    assert.notEqual(a, fingerprintKey('Author/Other', 'Author/Other/01.mp3'));
  });

  it('groups a cloud listing into books the same way a drive one is', () => {
    const books = groupIntoBooks([
      file('Vale/Three Nights/01.mp3'),
      file('Vale/Three Nights/02.mp3'),
      file('Finch/Lighthouse/only.mp3'),
    ]);
    assert.equal(books.length, 2);
    const keys = books.map((b) => fingerprintKey(b.folderRelPath, b.files[0].relPath));
    assert.equal(new Set(keys).size, 2, 'two books, two identities');
  });

  it('spots a provider listing the same book twice', () => {
    // What a duplicate would look like coming out of groupIntoBooks: two
    // books resolving to one identity. The probe counts these.
    const keys = ['x', 'y', 'x'];
    const seen = new Set<string>();
    const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    assert.deepEqual(dupes, ['x']);
  });
});
