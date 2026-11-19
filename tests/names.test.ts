/**
 * Name handling: SAF document ids, folder-name cleanup, and the ordering rules.
 *
 * The SAF cases come from a real USB drive, where entry names arrive as
 * `BC72-B058:Some Folder` rather than `Some Folder`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeviceStorage, safDisplayName, safFolderPath } from '../src/lib/files/safNames.ts';
import { safeLocalName } from '../src/lib/files/localNames.ts';
import { cleanName, naturalCompare, resolveName, splitAuthorTitle } from '../src/lib/library/names.ts';
import { orderParts, workKey, type ScannedFile } from '../src/lib/library/grouping.ts';

describe('safDisplayName', () => {
  it('drops a USB volume prefix', () => {
    assert.equal(safDisplayName('BC72-B058:Hyperion'), 'Hyperion');
    assert.equal(
      safDisplayName('BC72-B058:02 - Before They Are Hanged'),
      '02 - Before They Are Hanged',
    );
  });

  it('drops a primary-storage prefix', () => {
    assert.equal(safDisplayName('primary:Audiobooks'), 'Audiobooks');
  });

  it('uses the volume id for the drive root', () => {
    assert.equal(safDisplayName('BC72-B058:'), 'BC72-B058');
  });

  it('takes the last segment of a nested path', () => {
    assert.equal(safDisplayName('BC72-B058:Hyperion/Disc 1'), 'Disc 1');
    assert.equal(safDisplayName('primary:Audiobooks/Hyperion'), 'Hyperion');
  });

  it('leaves a plain name alone', () => {
    assert.equal(safDisplayName('Hyperion'), 'Hyperion');
    assert.equal(safDisplayName('04 - Best Served Cold.m4b'), '04 - Best Served Cold.m4b');
  });
});

describe('cleanName', () => {
  it('strips release junk', () => {
    assert.equal(cleanName('Dune [Unabridged] [64kbps] MP3'), 'Dune');
    assert.equal(cleanName('The Hobbit (2019)'), 'The Hobbit');
  });

  it('strips a leading series number', () => {
    assert.equal(cleanName('04 - Best Served Cold'), 'Best Served Cold');
    assert.equal(cleanName('15 - Hyperion - Dan Simmons - 1989'), 'Hyperion - Dan Simmons');
  });

  it('treats underscores and dots as spaces', () => {
    assert.equal(cleanName('Sharp_Ends_Stories'), 'Sharp Ends Stories');
    assert.equal(cleanName('The.Blade.Itself'), 'The Blade Itself');
  });
});

describe('splitAuthorTitle', () => {
  it('splits a clear "Author - Title"', () => {
    assert.deepEqual(splitAuthorTitle('Joe Abercrombie - The Blade Itself'), {
      title: 'The Blade Itself',
      author: 'Joe Abercrombie',
    });
  });

  it('leaves an ambiguous name alone', () => {
    assert.equal(splitAuthorTitle('A - B - C').author, undefined);
    assert.equal(splitAuthorTitle('Hyperion').author, undefined);
  });
});

describe('resolveName', () => {
  it('prefers embedded metadata', () => {
    const r = resolveName({
      folderName: '07 - Sharp Ends_ Stories from the World of the First Law',
      embeddedTitle: '07 - Sharp Ends: Stories from the World of the First Law',
      embeddedAuthor: 'Joe Abercrombie',
    });
    assert.equal(r.title, 'Sharp Ends: Stories from the World of the First Law');
    assert.equal(r.titleSource, 'embedded');
    assert.equal(r.author, 'Joe Abercrombie');
  });

  it('prefers the folder when it is a tighter form of the embedded title', () => {
    const r = resolveName({
      folderName: 'Hyperion',
      embeddedTitle: '15 - Hyperion - Dan Simmons - 1989',
      embeddedAuthor: 'Top 100 Sci-Fi Books',
    });
    assert.equal(r.title, 'Hyperion');
    assert.equal(r.titleSource, 'folder');
  });

  it('still prefers the folder once a USB volume prefix has been stripped', () => {
    // The bug this guards: with the raw SAF name the folder was
    // "BC72-B058:Hyperion", which is not contained in the album tag, so the
    // messy tag won and the book was titled "Hyperion - Dan Simmons".
    const r = resolveName({
      folderName: safDisplayName('BC72-B058:Hyperion'),
      embeddedTitle: '15 - Hyperion - Dan Simmons - 1989',
      embeddedAuthor: 'Top 100 Sci-Fi Books',
    });
    assert.equal(r.title, 'Hyperion');
  });

  it('keeps a real subtitle rather than cutting it to the folder name', () => {
    // Regression from a real drive: a folder named "Sharp Ends" sat beside the
    // same book in a fully-named folder, and the two produced different titles.
    const r = resolveName({
      folderName: 'Sharp Ends',
      embeddedTitle: '07 - Sharp Ends: Stories from the World of the First Law',
      embeddedAuthor: 'Joe Abercrombie',
    });
    assert.equal(r.title, 'Sharp Ends: Stories from the World of the First Law');
    assert.equal(r.titleSource, 'embedded');
  });

  it('keeps the embedded title when the folder is merely a prefix', () => {
    const r = resolveName({ folderName: 'Dune', embeddedTitle: 'Dune Messiah' });
    assert.equal(r.title, 'Dune Messiah');
  });

  it('falls back to the folder name when there are no tags', () => {
    const r = resolveName({ folderName: '04 - Best Served Cold' });
    assert.equal(r.title, 'Best Served Cold');
    assert.equal(r.titleSource, 'folder');
  });
});

describe('naturalCompare', () => {
  it('orders Part 2 before Part 10', () => {
    const names = ['Part 10', 'Part 2', 'Part 1'];
    assert.deepEqual(names.sort(naturalCompare), ['Part 1', 'Part 2', 'Part 10']);
  });
});

describe('workKey', () => {
  it('collapses part markers so siblings share a key', () => {
    assert.equal(workKey('Dune Part 01.mp3'), workKey('Dune Part 02.mp3'));
    assert.equal(workKey('Dune CD 1.mp3'), workKey('Dune CD 12.mp3'));
  });

  it('keeps different works apart', () => {
    assert.notEqual(workKey('Dune Part 1.mp3'), workKey('Hyperion Part 1.mp3'));
  });
});

function file(name: string, i: number): ScannedFile {
  return { relPath: `book/${name}`, name, uri: name, sizeBytes: 1000 + i, modifiedMs: i };
}

describe('orderParts', () => {
  it('uses natural filename order when there are no track tags', () => {
    const parts = [file('Part 10.mp3', 1), file('Part 2.mp3', 2)].map((f) => ({ file: f }));
    const out = orderParts(parts);
    assert.equal(out.basis, 'filename');
    assert.deepEqual(out.parts.map((p) => p.file.name), ['Part 2.mp3', 'Part 10.mp3']);
  });

  it('prefers track tags, and tolerates gaps', () => {
    // Mirrors the real Hyperion set: 127 files numbered up to 149.
    const parts = [
      { file: file('a.mp3', 1), trackNumber: 1 },
      { file: file('b.mp3', 2), trackNumber: 5 },
      { file: file('c.mp3', 3), trackNumber: 149 },
    ];
    const out = orderParts(parts);
    assert.equal(out.basis, 'tags');
    assert.equal(out.warning, undefined);
    assert.deepEqual(out.parts.map((p) => p.trackNumber), [1, 5, 149]);
  });

  it('warns when tags and filenames disagree, and follows the tags', () => {
    const parts = [
      { file: file('first.mp3', 1), trackNumber: 2 },
      { file: file('second.mp3', 2), trackNumber: 1 },
    ];
    const out = orderParts(parts);
    assert.equal(out.basis, 'tags');
    assert.ok(out.warning, 'expected a warning');
    assert.deepEqual(out.parts.map((p) => p.file.name), ['second.mp3', 'first.mp3']);
  });

  it('ignores track tags that are incomplete or duplicated', () => {
    const partial = [
      { file: file('a.mp3', 1), trackNumber: 1 },
      { file: file('b.mp3', 2) },
    ];
    assert.equal(orderParts(partial).basis, 'filename');

    const duplicated = [
      { file: file('a.mp3', 1), trackNumber: 1 },
      { file: file('b.mp3', 2), trackNumber: 1 },
    ];
    assert.equal(orderParts(duplicated).basis, 'filename');
  });
});

describe('safeLocalName', () => {
  it('keeps the extension and drops the rest of the name', () => {
    assert.equal(safeLocalName(0, 'Hyperion Part 01.mp3'), '0000.mp3');
    assert.equal(safeLocalName(12, 'Best Served Cold.m4b'), '0012.m4b');
  });

  it('survives the characters that broke java.net.URI', () => {
    // Non-ASCII and the bracket set are rejected by `URI.create`, which
    // expo-file-system runs on every local path. None of it reaches the result.
    assert.equal(safeLocalName(1, 'Sharp Ends \u2013 Stories [Unabridged].m4b'), '0001.m4b');
    assert.equal(safeLocalName(2, 'Tom\u00e1s Herrera - Niamh O\u2019Donnell.MP3'), '0002.mp3');
    assert.equal(safeLocalName(3, '\u041c\u0430\u0440\u0438\u043d\u0430 \u041e\u0440\u043b\u043e\u0432\u0430.m4a'), '0003.m4a');
  });

  it('falls back when there is no usable extension', () => {
    assert.equal(safeLocalName(4, 'no-extension'), '0004.bin');
    assert.equal(safeLocalName(5, 'weird.verylongextension'), '0005.bin');
  });
});

describe('isDeviceStorage', () => {
  it('recognises the phone’s own storage', () => {
    // A library already on the phone needs no checking out: copying each book
    // into app storage would keep every file twice.
    assert.ok(
      isDeviceStorage(
        'content://com.android.externalstorage.documents/tree/primary%3AAudiobooks',
      ),
    );
    assert.ok(isDeviceStorage('file:///storage/emulated/0/Audiobooks/'));
    assert.ok(
      isDeviceStorage('file:///data/data/com.dueback.audiobooks/files/fixtures/Audiobooks/'),
    );
  });

  it('treats removable volumes as a drive', () => {
    // A memory card is usually left in, but it is still removable, so a
    // library on one keeps the check-out behaviour.
    assert.ok(
      !isDeviceStorage(
        'content://com.android.externalstorage.documents/tree/BC72-B058%3AAudiobooks',
      ),
    );
    assert.ok(
      !isDeviceStorage(
        'content://com.android.externalstorage.documents/tree/0900-360C%3ALib',
      ),
    );
  });

  it('does not guess at anything else', () => {
    assert.ok(!isDeviceStorage('content://com.example.provider/tree/whatever'));
    assert.ok(!isDeviceStorage(''));
  });
});

describe('safFolderPath', () => {
  it('gives the path inside the volume, not just the last segment', () => {
    assert.equal(
      safFolderPath('content://com.android.externalstorage.documents/tree/primary%3AAudiobooks%2FFiction'),
      'Audiobooks/Fiction',
    );
  });

  it('handles a folder straight off the volume root', () => {
    assert.equal(
      safFolderPath('content://com.android.externalstorage.documents/tree/primary%3AAudiobooks'),
      'Audiobooks',
    );
  });

  it('names the volume when the root itself was picked', () => {
    // A bare `VOLUME:` has no path below it, so the volume is the answer.
    assert.equal(
      safFolderPath('content://com.android.externalstorage.documents/tree/BC72-B058%3A'),
      'BC72-B058',
    );
  });

  it('drops a trailing slash rather than ending on one', () => {
    assert.equal(
      safFolderPath('content://com.android.externalstorage.documents/tree/primary%3ABooks%2F'),
      'Books',
    );
  });

  it('is empty for a URI carrying no volume, so a caller can fall back', () => {
    assert.equal(safFolderPath('file:///storage/emulated/0/Books'), '');
    assert.equal(safFolderPath(''), '');
  });
});
