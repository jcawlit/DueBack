/**
 * What the app says when somebody's server will not cooperate.
 *
 * These are the sentences a person actually reads, so they are tested like
 * behaviour rather than like strings: no status codes, no server wording
 * passed through, and advice that matches what went wrong.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AbsError } from '../src/lib/abs/client.ts';
import {
  compareVersions,
  describeAbsError,
  describeServerVersion,
  needsSignIn,
  MIN_REFRESH_VERSION,
  MIN_SERVER_VERSION,
  type AbsContext,
} from '../src/lib/abs/errors.ts';
import { inoFromContentUrl, audioFilesOf } from '../src/lib/abs/map.ts';

const CONTEXTS: AbsContext[] = ['connect', 'catalogue', 'checkout', 'stream', 'cover'];

describe('no message ever shows a status code', () => {
  it('holds for every kind, in every context', () => {
    const errors = [
      new AbsError('unreachable', 'Could not reach the server. TypeError: fail'),
      new AbsError('auth', 'Sign in: the server did not accept those credentials.', 401),
      new AbsError('forbidden', 'List: this account is not allowed to do that.', 403),
      new AbsError('server', 'Read: the server answered 503. <html>Gateway</html>', 503),
      new Error('ENOENT: no such file'),
      'a bare string',
    ];
    for (const context of CONTEXTS) {
      for (const error of errors) {
        const text = describeAbsError(error, context);
        assert.match(text, /[a-z]/, 'says something');
        assert.doesNotMatch(text, /\b[45]\d\d\b/, `status code leaked: ${text}`);
        assert.doesNotMatch(text, /TypeError|ENOENT|<html>/, `raw detail leaked: ${text}`);
        assert.ok(text.endsWith('.'), `not a sentence: ${text}`);
      }
    }
  });
});

describe('each failure gets its own advice', () => {
  it('unreachable talks about the address and the network', () => {
    const text = describeAbsError(new AbsError('unreachable', 'x'), 'connect');
    assert.match(text, /address/i);
    assert.match(text, /network/i);
  });

  it('401 sends you to sign in again', () => {
    const text = describeAbsError(new AbsError('auth', 'x', 401), 'catalogue');
    assert.match(text, /sign in again/i);
    assert.equal(needsSignIn(new AbsError('auth', 'x', 401)), true);
    assert.equal(needsSignIn(new AbsError('forbidden', 'x', 403)), false);
  });

  it('403 at checkout names the download permission and who can fix it', () => {
    const text = describeAbsError(new AbsError('forbidden', 'x', 403), 'checkout');
    assert.match(text, /not allowed to download/i);
    assert.match(text, /administrator/i);
    // And must not send somebody to sign in again, which would not help.
    assert.doesNotMatch(text, /sign in/i);
  });

  it('403 elsewhere says not allowed without inventing a reason', () => {
    const text = describeAbsError(new AbsError('forbidden', 'x', 403), 'stream');
    assert.match(text, /not allowed/i);
    assert.doesNotMatch(text, /download permission/i);
  });

  it('names what was being done, so the same fault reads differently', () => {
    const unreachable = new AbsError('unreachable', 'x');
    const said = CONTEXTS.map((c) => describeAbsError(unreachable, c));
    assert.equal(new Set(said).size, CONTEXTS.length, 'each context says where it was');
  });

  it('does not blame the server for a fault on this phone', () => {
    const text = describeAbsError(new TypeError('undefined is not a function'), 'stream');
    assert.match(text, /this phone/i);
  });
});

describe('how old a server is', () => {
  it('compares versions sensibly', () => {
    assert.equal(compareVersions('2.37.1', '2.26.0'), 1);
    assert.equal(compareVersions('2.9.0', '2.26.0'), -1, 'nine is not newer than twenty-six');
    assert.equal(compareVersions('2.26.0', '2.26.0'), 0);
    assert.equal(compareVersions('v2.26.0', '2.26.0'), 0, 'a leading v is noise');
    assert.equal(compareVersions('2.26', '2.26.0'), 0, 'missing parts are zero');
  });

  it('says nothing about a current server', () => {
    assert.equal(describeServerVersion('2.37.1'), null);
    assert.equal(describeServerVersion(MIN_REFRESH_VERSION), null);
  });

  it('says nothing when the version is unknown', () => {
    // A proxy in the way is far likelier than a broken server, and
    // refusing on silence turns a working setup into a dead end.
    assert.equal(describeServerVersion(undefined), null);
    assert.equal(describeServerVersion(''), null);
  });

  it('warns, but does not block, a server without renewable sign-ins', () => {
    const note = describeServerVersion('2.20.0');
    assert.equal(note?.tone, 'warn');
    assert.match(note!.text, /sign in again/i);
    assert.match(note!.text, /2\.20\.0/, 'says which version it found');
  });

  it('refuses a server older than the endpoints it needs', () => {
    const note = describeServerVersion('1.9.0');
    assert.equal(note?.tone, 'bad');
    assert.match(note!.text, /older than this app can talk to/i);
  });

  it('puts the floor below the refresh-token version', () => {
    assert.equal(compareVersions(MIN_SERVER_VERSION, MIN_REFRESH_VERSION), -1);
  });
});

describe('a server too old to put an ino on a file', () => {
  it('reads it back out of the track address', () => {
    assert.equal(
      inoFromContentUrl('/api/items/abc-123/file/844424933942304'),
      '844424933942304',
    );
    assert.equal(inoFromContentUrl('/api/items/x/file/99?ts=1'), '99');
    assert.equal(inoFromContentUrl('/api/items/x/file/99#frag'), '99');
    assert.equal(inoFromContentUrl('/hls/session-id/output.m3u8'), '', 'no ino in an HLS url');
    assert.equal(inoFromContentUrl(''), '');
  });

  it('falls back per file, matching tracks by position', () => {
    // What a pre-2.18 expanded item looks like: files without inos, and
    // tracks that carry the number in the middle of their address.
    const files = audioFilesOf({
      media: {
        audioFiles: [
          { metadata: { filename: 'one.mp3', size: 10 } },
          { metadata: { filename: 'two.mp3', size: 20 } },
        ],
        tracks: [
          { index: 1, contentUrl: '/api/items/b/file/111' },
          { index: 2, contentUrl: '/api/items/b/file/222' },
        ],
      },
    });
    assert.deepEqual(files, [
      { ino: '111', name: 'one.mp3', sizeBytes: 10 },
      { ino: '222', name: 'two.mp3', sizeBytes: 20 },
    ]);
  });

  it('prefers a real ino over the address when both are there', () => {
    const files = audioFilesOf({
      media: {
        audioFiles: [{ ino: '777', metadata: { filename: 'a.mp3', size: 1 } }],
        tracks: [{ index: 1, contentUrl: '/api/items/b/file/999' }],
      },
    });
    assert.equal(files[0].ino, '777');
  });

  it('still drops a file it cannot address at all', () => {
    const files = audioFilesOf({
      media: {
        audioFiles: [{ metadata: { filename: 'a.mp3', size: 1 } }],
        tracks: [{ index: 1, contentUrl: '/hls/sess/output.m3u8' }],
      },
    });
    assert.deepEqual(files, []);
  });
});
