/**
 * What a scan is entitled to conclude from not finding a book.
 *
 * `markMissingExcept` marks every drive book missing and then un-marks the
 * ones the scan found, so absence from the walk is the whole evidence. That is
 * only sound where the walk actually looked. A folder that would not list, a
 * subtree past the depth limit, and a book that threw while being read all
 * leave a gap — and a gap read as "gone" ends with Settings offering to
 * "Forget N missing books", which deletes notes and history.
 *
 * The first half of this file pins the path logic. The second half runs the
 * real sweep against real SQLite and proves an unseen book comes out the other
 * side exactly as it went in.
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrate } from '../src/db/migrations.ts';
import { DRIVE_BOOKS } from '../src/db/scope.ts';
import {
  isUnder,
  normaliseFolder,
  unvouchedFolders,
  wasUnseen,
} from '../src/lib/scan/coverage.ts';

describe('naming a folder the same way twice', () => {
  it('strips what the two sides spell differently', () => {
    assert.equal(normaliseFolder('Sci-fi/Hyperion'), 'Sci-fi/Hyperion');
    assert.equal(normaliseFolder('./Sci-fi'), 'Sci-fi');
    assert.equal(normaliseFolder('/Sci-fi/'), 'Sci-fi');
    assert.equal(normaliseFolder('  Sci-fi  '), 'Sci-fi');
  });

  it('calls the root an empty string', () => {
    assert.equal(normaliseFolder('.'), '');
    assert.equal(normaliseFolder(''), '');
    assert.equal(normaliseFolder('/'), '');
  });
});

describe('whether a folder is inside a subtree', () => {
  it('counts the subtree itself', () => {
    assert.equal(isUnder('Sci-fi', 'Sci-fi'), true);
  });

  it('counts anything below it', () => {
    assert.equal(isUnder('Sci-fi/Hyperion/Disc 1', 'Sci-fi'), true);
  });

  it('does not count a sibling whose name merely starts the same', () => {
    // The separator is the whole test: a plain `startsWith` would say
    // "Hyperion" was inside "Hyper".
    assert.equal(isUnder('Hyperion', 'Hyper'), false);
    assert.equal(isUnder('Sci-fiction/A', 'Sci-fi'), false);
  });

  it('treats the root as containing everything', () => {
    // Which is the unreadable-root case, already refused one level up.
    assert.equal(isUnder('anything/at/all', ''), true);
  });
});

describe('whether a book was somewhere the scan could not see', () => {
  it('says no when the scan saw everything', () => {
    assert.equal(wasUnseen('Sci-fi/Hyperion', []), false);
  });

  it('says yes for a book under an unreadable folder', () => {
    assert.equal(wasUnseen('Sci-fi/Hyperion', ['Sci-fi']), true);
  });

  it('says no for a book in a folder that was read', () => {
    assert.equal(wasUnseen('Crime/Gorky Park', ['Sci-fi']), false);
  });

  it('survives a book with no folder recorded', () => {
    assert.equal(wasUnseen(null, ['Sci-fi']), false);
    assert.equal(wasUnseen(undefined, ['Sci-fi']), false);
  });

  it('matches a book whose folder is itself the root, only if the root was unseen', () => {
    assert.equal(wasUnseen('', ['Sci-fi']), false);
    assert.equal(wasUnseen('', ['']), true);
  });
});

describe('gathering the folders a scan cannot vouch for', () => {
  it('takes both the unseen and the errored, normalised and deduplicated', () => {
    assert.deepEqual(
      unvouchedFolders(['./Sci-fi/', 'Deep/Nest'], ['Sci-fi', 'Crime/Broken']),
      ['Sci-fi', 'Deep/Nest', 'Crime/Broken'],
    );
  });

  it('is empty when nothing went wrong', () => {
    assert.deepEqual(unvouchedFolders([], []), []);
  });
});

/*
 * The sweep itself, against real SQLite.
 *
 * `src/db/books.ts` reaches expo-sqlite and cannot load off a phone, so the
 * statements are run here as `markMissingExcept` runs them — the same SQL, the
 * same order, and the same protection rule from `coverage.ts`.
 */
describe('the missing sweep, with a gap in the scan', () => {
  let raw: DatabaseSync;

  before(async () => {
    raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = OFF');
    const db = {
      async execAsync(sql: string) { raw.exec(sql); },
      async runAsync(sql: string, ...a: SQLInputValue[]) { return raw.prepare(sql).run(...a); },
      async getFirstAsync<T>(sql: string, ...a: SQLInputValue[]) {
        return (raw.prepare(sql).get(...a) as T) ?? null;
      },
      async getAllAsync<T>(sql: string, ...a: SQLInputValue[]) {
        return raw.prepare(sql).all(...a) as T[];
      },
      async closeAsync() {},
    };
    await migrate(db as never);
  });

  const book = (id: string, folder: string, missing = 0) =>
    raw
      .prepare(
        `INSERT INTO books (id, folder_rel_path, raw_folder_name, title, missing)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, folder, folder, id, missing);

  beforeEach(() => {
    raw.exec('DELETE FROM books');
  });

  /** `markMissingExcept`, statement for statement. */
  const sweep = (seenIds: string[], unvouched: string[]) => {
    const seen = new Set(seenIds);
    const rows = raw
      .prepare(`SELECT id, folder_rel_path, missing FROM books WHERE ${DRIVE_BOOKS}`)
      .all() as { id: string; folder_rel_path: string | null; missing: number }[];

    const protectedRows =
      unvouched.length === 0
        ? []
        : rows.filter((r) => !seen.has(r.id) && wasUnseen(r.folder_rel_path, unvouched));

    raw.exec(
      `UPDATE books SET missing = 1
        WHERE ${DRIVE_BOOKS}
          AND NOT (COALESCE(source_kind, 'library') = 'imported' AND COALESCE(on_drive, 1) = 0)`,
    );
    const set = (value: 0 | 1, ids: string[]) => {
      for (const id of ids) {
        raw.prepare('UPDATE books SET missing = ? WHERE id = ?').run(value, id);
      }
    };
    set(0, seenIds);
    set(1, protectedRows.filter((r) => r.missing === 1).map((r) => r.id));
    set(0, protectedRows.filter((r) => r.missing !== 1).map((r) => r.id));
  };

  const missingOf = (id: string) =>
    (raw.prepare('SELECT missing FROM books WHERE id = ?').get(id) as { missing: number }).missing;

  it('still marks a book missing when the scan read its folder', () => {
    // The behaviour that has to survive: a gap elsewhere must not stop the
    // sweep doing its job where the scan did look.
    book('gone', 'Crime/Gorky Park');
    book('here', 'Crime/Smiley');
    sweep(['here'], ['Sci-fi']);
    assert.equal(missingOf('gone'), 1);
    assert.equal(missingOf('here'), 0);
  });

  it('does not mark a book missing because its folder could not be read', () => {
    /*
     * The whole point. The book is on the drive; the scan could not list its
     * folder, so it is absent from `seenIds` through no fault of its own.
     */
    book('unread', 'Sci-fi/Hyperion');
    sweep([], ['Sci-fi']);
    assert.equal(missingOf('unread'), 0, 'present, and left alone');
  });

  it('does not mark a book missing because reading it threw', () => {
    book('broken', 'Crime/Unparseable');
    sweep([], ['Crime/Unparseable']);
    assert.equal(missingOf('broken'), 0);
  });

  it('does not mark a book missing because it was nested too deep', () => {
    book('deep', 'A/B/C/D/E/F/G/H/I/Hyperion');
    sweep([], ['A/B/C/D/E/F/G/H']);
    assert.equal(missingOf('deep'), 0);
  });

  it('leaves an already-missing book missing rather than quietly clearing it', () => {
    /*
     * Protection means "unchanged", not "present". A book already known to be
     * gone must not come back onto the shelf because a different folder failed
     * to list — that would be the same mistake pointing the other way.
     */
    book('long-gone', 'Sci-fi/Vanished', 1);
    sweep([], ['Sci-fi']);
    assert.equal(missingOf('long-gone'), 1);
  });

  it('marks a protected book present if the scan did find it after all', () => {
    // Found is found: a stale `missing` flag has to clear, or a book that came
    // back would be stuck behind the gap for good.
    book('found', 'Sci-fi/Hyperion', 1);
    sweep(['found'], ['Sci-fi']);
    assert.equal(missingOf('found'), 0);
  });

  it('behaves exactly as before when the scan had no gaps', () => {
    book('one', 'A');
    book('two', 'B');
    sweep(['one'], []);
    assert.equal(missingOf('one'), 0);
    assert.equal(missingOf('two'), 1);
  });
});
