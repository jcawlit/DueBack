/**
 * The Audiobookshelf client, against a fetch that answers whatever the test
 * needs it to. No server involved — `tools/abs-test` is where this is proved
 * against a real one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AbsError,
  createClient,
  isCleartextToPublicHost,
  login,
  normalizeServerUrl,
  refresh,
  status,
} from '../src/lib/abs/client.ts';

type Call = { url: string; init: RequestInit & { headers?: Record<string, string> } };

/** A fetch that walks through scripted answers, recording what it was asked. */
function scripted(answers: (Response | Error | (() => Response | Error))[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init: init as Call['init'] });
    const entry = answers[Math.min(i, answers.length - 1)];
    i += 1;
    const answer = typeof entry === 'function' ? entry() : entry;
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, count: () => i };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

const SERVER = 'http://localhost:13378';

describe('the server address', () => {
  it('accepts what a person actually writes down', () => {
    assert.equal(normalizeServerUrl('192.168.1.90:13378'), 'http://192.168.1.90:13378');
    assert.equal(normalizeServerUrl('  http://abs.local/  '), 'http://abs.local');
    assert.equal(normalizeServerUrl('https://books.example.com//'), 'https://books.example.com');
    assert.equal(normalizeServerUrl(''), '');
  });

  it('warns only when a password would cross a public network in clear', () => {
    // On your own network, plain http is how this server is normally run.
    for (const lan of [
      'http://192.168.1.90:13378',
      'http://10.0.0.5',
      'http://172.16.4.4',
      'http://172.31.255.1',
      'http://127.0.0.1:13378',
      'http://localhost:13378',
      'http://abs.local',
      'http://nas',
      'http://169.254.1.1',
    ]) {
      assert.equal(isCleartextToPublicHost(lan), false, lan);
    }
    for (const open of ['http://books.example.com', 'http://93.184.216.34', 'http://172.32.0.1']) {
      assert.equal(isCleartextToPublicHost(open), true, open);
    }
    // https is fine wherever it points.
    assert.equal(isCleartextToPublicHost('https://books.example.com'), false);
  });
});

describe('signing in', () => {
  it('reads the legacy single token', async () => {
    const { fetchImpl } = scripted([json({ user: { id: 'u', username: 'jake', type: 'user', token: 'legacy' } })]);
    const session = await login(SERVER, 'jake', 'hunter2', fetchImpl);
    assert.equal(session.tokens.accessToken, 'legacy');
    assert.equal(session.tokens.refreshToken, undefined);
    assert.equal(session.user.username, 'jake');
  });

  it('prefers the 2.26 access token and keeps the refresh token', async () => {
    const { fetchImpl, calls } = scripted([
      json({
        user: {
          id: 'u',
          username: 'jake',
          type: 'user',
          token: 'legacy',
          accessToken: 'access',
          refreshToken: 'renew',
          permissions: { download: true },
        },
        serverVersion: '2.37.1',
      }),
    ]);
    const session = await login(SERVER, 'jake', 'hunter2', fetchImpl);
    assert.equal(session.tokens.accessToken, 'access');
    assert.equal(session.tokens.refreshToken, 'renew');
    assert.equal(session.serverVersion, '2.37.1');
    assert.equal(session.user.canDownload, true);
    // Without this header a native client gets the refresh token as an
    // http-only cookie it cannot read, and can never renew.
    assert.equal(calls[0].init.headers?.['x-return-tokens'], 'true');
    assert.equal(calls[0].url, `${SERVER}/login`);
  });

  it('does not put the password anywhere but the request body', async () => {
    const { fetchImpl, calls } = scripted([json({ user: { username: 'jake', accessToken: 'a' } })]);
    const session = await login(SERVER, 'jake', 'hunter2', fetchImpl);
    assert.equal(JSON.stringify(session).includes('hunter2'), false);
    assert.equal(calls[0].url.includes('hunter2'), false);
    assert.equal(JSON.stringify(calls[0].init.headers).includes('hunter2'), false);
  });

  it('maps the statuses a caller can act on', async () => {
    for (const [code, kind] of [[401, 'auth'], [403, 'forbidden'], [500, 'server']] as const) {
      const { fetchImpl } = scripted([new Response('no', { status: code })]);
      await assert.rejects(
        login(SERVER, 'jake', 'x', fetchImpl),
        (error: AbsError) => error instanceof AbsError && error.kind === kind && error.status === code,
        `status ${code}`,
      );
    }
  });

  it('calls a server that does not answer unreachable', async () => {
    const { fetchImpl } = scripted([new TypeError('Network request failed')]);
    await assert.rejects(
      login(SERVER, 'jake', 'x', fetchImpl),
      (error: AbsError) => error instanceof AbsError && error.kind === 'unreachable',
    );
  });

  it('refuses a 200 that carries no token', async () => {
    const { fetchImpl } = scripted([json({ user: { username: 'jake' } })]);
    await assert.rejects(
      login(SERVER, 'jake', 'x', fetchImpl),
      (error: AbsError) => error.kind === 'server' && /no token/.test(error.message),
    );
  });
});

describe('finding the status route', () => {
  it('uses /status, which is the one that exists on 2.37', async () => {
    const { fetchImpl, calls, count } = scripted([json({ serverVersion: '2.37.1', isInit: true })]);
    const reported = await status(SERVER, fetchImpl);
    assert.equal(reported.version, '2.37.1');
    assert.equal(reported.path, '/status');
    assert.equal(count(), 1, 'no second call when the first route answers');
    assert.equal(calls[0].url, `${SERVER}/status`);
  });

  it('falls back to /api/status for a version that has it there instead', async () => {
    const { fetchImpl, calls } = scripted([
      new Response('not found', { status: 404 }),
      json({ serverVersion: '2.19.0' }),
    ]);
    const reported = await status(SERVER, fetchImpl);
    assert.equal(reported.version, '2.19.0');
    assert.equal(reported.path, '/api/status');
    assert.deepEqual(calls.map((c) => c.url), [`${SERVER}/status`, `${SERVER}/api/status`]);
  });

  it('does not try the second route when nothing is listening', async () => {
    const { fetchImpl, count } = scripted([new TypeError('Network request failed')]);
    await assert.rejects(status(SERVER, fetchImpl), (e: AbsError) => e.kind === 'unreachable');
    assert.equal(count(), 1);
  });
});

describe('renewing a session', () => {
  it('sends the refresh token in the header the server asks for', async () => {
    const { fetchImpl, calls } = scripted([json({ user: { accessToken: 'fresh', refreshToken: 'next' } })]);
    const tokens = await refresh(SERVER, 'renew', fetchImpl);
    assert.deepEqual(tokens, { accessToken: 'fresh', refreshToken: 'next' });
    assert.equal(calls[0].url, `${SERVER}/auth/refresh`);
    assert.equal(calls[0].init.headers?.['x-refresh-token'], 'renew');
  });

  it('keeps the old refresh token when the server reissues only the access one', async () => {
    const { fetchImpl } = scripted([json({ user: { accessToken: 'fresh' } })]);
    assert.deepEqual(await refresh(SERVER, 'renew', fetchImpl), {
      accessToken: 'fresh',
      refreshToken: 'renew',
    });
  });

  it('renews once on a 401 and retries the original call', async () => {
    const saved: string[] = [];
    const { fetchImpl, calls } = scripted([
      new Response('expired', { status: 401 }),
      json({ user: { accessToken: 'fresh', refreshToken: 'next' } }),
      json({ libraries: [{ id: 'l1', name: 'Test Shelf', mediaType: 'book' }] }),
    ]);
    const client = createClient({
      serverUrl: SERVER,
      auth: { kind: 'tokens', tokens: { accessToken: 'stale', refreshToken: 'renew' } },
      onTokens: (t) => void saved.push(t.accessToken),
      fetch: fetchImpl,
    });

    const libraries = await client.libraries();
    assert.deepEqual(libraries, [{ id: 'l1', name: 'Test Shelf', mediaType: 'book' }]);
    assert.deepEqual(saved, ['fresh'], 'the new token is handed back to be stored');
    assert.deepEqual(
      calls.map((c) => c.url),
      [`${SERVER}/api/libraries`, `${SERVER}/auth/refresh`, `${SERVER}/api/libraries`],
    );
    // The retry carries the new token, not the one that was just refused.
    assert.equal(calls[2].init.headers?.Authorization, 'Bearer fresh');
  });

  it('gives up loudly when the renewal is refused, and never tries again', async () => {
    let prompted = 0;
    const { fetchImpl, count } = scripted([
      new Response('expired', { status: 401 }),
      new Response('no', { status: 401 }),
    ]);
    const client = createClient({
      serverUrl: SERVER,
      auth: { kind: 'tokens', tokens: { accessToken: 'stale', refreshToken: 'dead' } },
      onSignInRequired: () => void (prompted += 1),
      fetch: fetchImpl,
    });

    await assert.rejects(
      client.libraries(),
      (error: AbsError) => error instanceof AbsError && error.kind === 'auth',
    );
    assert.equal(prompted, 1, 'the source is marked once');
    assert.equal(count(), 2, 'one call, one failed renewal, and then a stop');

    // A second call must not start the cycle again: there is no password to
    // fall back on, so retrying can only lock the account.
    await assert.rejects(client.libraries(), (error: AbsError) => error.kind === 'auth');
    assert.equal(prompted, 1, 'and only once');
    assert.equal(count(), 3, 'the second call is made, but nothing is renewed');
  });

  it('does not try to renew an API key', async () => {
    let prompted = 0;
    const { fetchImpl, calls } = scripted([new Response('no', { status: 401 })]);
    const client = createClient({
      serverUrl: SERVER,
      auth: { kind: 'apiKey', apiKey: 'key123' },
      onSignInRequired: () => void (prompted += 1),
      fetch: fetchImpl,
    });
    await assert.rejects(client.libraries(), (error: AbsError) => error.kind === 'auth');
    assert.equal(prompted, 1);
    assert.deepEqual(calls.map((c) => c.url), [`${SERVER}/api/libraries`]);
    assert.equal(calls[0].init.headers?.Authorization, 'Bearer key123');
  });

  it('does not try to renew a legacy token, which has nothing to renew with', async () => {
    const { fetchImpl, count } = scripted([new Response('no', { status: 401 })]);
    const client = createClient({
      serverUrl: SERVER,
      auth: { kind: 'tokens', tokens: { accessToken: 'legacy' } },
      fetch: fetchImpl,
    });
    await assert.rejects(client.libraries(), (error: AbsError) => error.kind === 'auth');
    assert.equal(count(), 1);
  });
});

describe('listing libraries', () => {
  it('skips podcast libraries entirely', async () => {
    const { fetchImpl } = scripted([
      json({
        libraries: [
          { id: 'b1', name: 'Test Shelf', mediaType: 'book' },
          { id: 'p1', name: 'Shows', mediaType: 'podcast' },
          { id: 'b2', name: 'Spare Room', mediaType: 'book' },
        ],
      }),
    ]);
    const client = createClient({
      serverUrl: SERVER,
      auth: { kind: 'apiKey', apiKey: 'k' },
      fetch: fetchImpl,
    });
    assert.deepEqual(
      (await client.libraries()).map((l) => l.name),
      ['Test Shelf', 'Spare Room'],
    );
  });

  it('survives a payload that is not shaped the way it should be', async () => {
    const { fetchImpl } = scripted([json({ libraries: 'nope' })]);
    const client = createClient({
      serverUrl: SERVER,
      auth: { kind: 'apiKey', apiKey: 'k' },
      fetch: fetchImpl,
    });
    assert.deepEqual(await client.libraries(), []);
  });

  it('reports a forbidden account as forbidden, not as a sign-in problem', async () => {
    const { fetchImpl } = scripted([new Response('nope', { status: 403 })]);
    const client = createClient({
      serverUrl: SERVER,
      auth: { kind: 'apiKey', apiKey: 'k' },
      fetch: fetchImpl,
    });
    await assert.rejects(
      client.libraries(),
      (error: AbsError) => error.kind === 'forbidden' && error.status === 403,
    );
  });
});

describe('authorize', () => {
  it('reports the user and keeps the tokens it already had', async () => {
    const { fetchImpl, calls } = scripted([
      json({ user: { id: 'u', username: 'dueback-test', type: 'user', permissions: { download: true } } }),
    ]);
    const client = createClient({
      serverUrl: SERVER,
      auth: { kind: 'tokens', tokens: { accessToken: 'a', refreshToken: 'r' } },
      fetch: fetchImpl,
    });
    const session = await client.authorize();
    assert.equal(session.user.username, 'dueback-test');
    assert.equal(session.user.canDownload, true);
    assert.deepEqual(session.tokens, { accessToken: 'a', refreshToken: 'r' });
    assert.equal(calls[0].url, `${SERVER}/api/authorize`);
    assert.equal(calls[0].init.method, 'POST');
  });
});
