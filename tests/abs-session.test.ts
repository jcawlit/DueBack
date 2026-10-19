/**
 * The streaming session's accounting, against a fake server.
 *
 * Two things here are easy to get wrong and expensive when wrong, because
 * nothing ever corrects them afterwards: `timeListened` is a delta the
 * server adds up across every session row it has ever held, and a session
 * that has vanished must be replaced quietly rather than reported to.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamSession, isTranscode, SYNC_INTERVAL_MS } from '../src/lib/abs/session.ts';
import type { AbsClient, AbsSessionInfo } from '../src/lib/abs/client.ts';

type Body = { currentTime: number; timeListened: number; duration: number };

type Script = {
  /** Sessions handed out, in order. The last repeats. */
  sessions?: (AbsSessionInfo | Error)[];
  /** Answers for each sync: true alive, false gone (404), Error to throw. */
  syncs?: (boolean | Error)[];
};

function fake(script: Script = {}) {
  const opened: string[] = [];
  const synced: { id: string; body: Body }[] = [];
  const closed: { id: string; body: Body }[] = [];
  let openIndex = 0;
  let syncIndex = 0;

  const session = (id: string, playMethod = 0): AbsSessionInfo => ({
    id,
    playMethod: playMethod as AbsSessionInfo['playMethod'],
    tracks: [{ index: 1, startSec: 0, durationSec: 900, url: `http://h/t/${id}`, mimeType: 'audio/mpeg' }],
    durationSec: 900,
    startedAtSec: 0,
  });

  const client = {
    async openSession(itemId: string) {
      opened.push(itemId);
      const next = script.sessions?.[Math.min(openIndex, (script.sessions.length ?? 1) - 1)];
      openIndex += 1;
      if (next instanceof Error) throw next;
      return next ?? session(`s${openIndex}`);
    },
    async syncSession(id: string, body: Body) {
      synced.push({ id, body });
      const answer = script.syncs?.[Math.min(syncIndex, (script.syncs.length ?? 1) - 1)];
      syncIndex += 1;
      if (answer instanceof Error) throw answer;
      return answer ?? true;
    },
    async closeSession(id: string, body: Body) {
      closed.push({ id, body });
    },
  } as unknown as AbsClient;

  return { client, opened, synced, closed, session };
}

const make = (client: AbsClient, events = {}) =>
  new StreamSession(client, 'item-1', 'device-1', 900, events);

describe('opening', () => {
  it('sends the item and this install’s device id', async () => {
    const f = fake();
    const live = make(f.client);
    const info = await live.open();
    assert.deepEqual(f.opened, ['item-1']);
    assert.equal(info.id, 's1');
    assert.equal(live.current?.id, 's1');
  });
});

describe('time listened is a delta, not a total', () => {
  it('reports only what has happened since the last successful sync', async () => {
    const f = fake();
    const live = make(f.client);
    await live.open();

    live.listened(15);
    await live.sync(100);
    assert.deepEqual(f.synced[0].body, { currentTime: 100, timeListened: 15, duration: 900 });

    live.listened(15);
    await live.sync(115);
    // 15 again, not 30: the server adds these up itself.
    assert.deepEqual(f.synced[1].body, { currentTime: 115, timeListened: 15, duration: 900 });
  });

  it('carries seconds forward when a sync fails, rather than losing them', async () => {
    const f = fake({ syncs: [new Error('Network request failed'), true] });
    const live = make(f.client);
    await live.open();

    live.listened(15);
    assert.equal(await live.sync(100), false);
    assert.equal(live.unreportedSeconds, 15, 'the server never counted them');

    live.listened(15);
    assert.equal(await live.sync(115), true);
    assert.equal(f.synced[1].body.timeListened, 30, 'both intervals, on the next success');
    assert.equal(live.unreportedSeconds, 0);
  });

  it('resets the counter on a 200 and on nothing else', async () => {
    const f = fake({ syncs: [true] });
    const live = make(f.client);
    await live.open();
    live.listened(20);
    await live.sync(50);
    assert.equal(live.unreportedSeconds, 0);
  });

  it('rounds to whole seconds, because that is what the server stores', async () => {
    const f = fake();
    const live = make(f.client);
    await live.open();
    live.listened(0.4);
    live.listened(0.4);
    await live.sync(10);
    assert.equal(Number.isInteger(f.synced[0].body.timeListened), true);
  });
});

describe('a session that has gone', () => {
  it('opens a replacement once, quietly, and tells the caller', async () => {
    let reopened: AbsSessionInfo | null = null;
    const f = fake({ syncs: [false, true] });
    const live = make(f.client, { onReopened: (s: AbsSessionInfo) => (reopened = s) });
    await live.open();

    live.listened(15);
    const alive = await live.sync(300);
    assert.equal(alive, true, 'a 404 is answered by reopening, not by failing');
    assert.deepEqual(f.opened, ['item-1', 'item-1']);
    assert.equal(live.current?.id, 's2');
    assert.equal(reopened !== null, true, 'the caller is told, so HLS can reload');
  });

  it('tells the new session where the listener is, at once', async () => {
    const f = fake({ syncs: [false, true] });
    const live = make(f.client);
    await live.open();
    await live.sync(421);
    const onNew = f.synced.find((entry) => entry.id === 's2');
    assert.equal(onNew?.body.currentTime, 421);
    assert.equal(onNew?.body.timeListened, 0, 'the new session saw none of that listening');
  });

  it('does not carry listening across to a session that never saw it', async () => {
    const f = fake({ syncs: [false, true] });
    const live = make(f.client);
    await live.open();
    live.listened(42);
    await live.sync(300);
    assert.equal(live.unreportedSeconds, 0);
  });

  it('gives up without throwing when a replacement cannot be opened', async () => {
    let lost = '';
    const f = fake({ sessions: [fake().session('s1'), new Error('server is down')], syncs: [false] });
    const live = make(f.client, { onLost: (reason: string) => (lost = reason) });
    await live.open();
    const alive = await live.sync(10);
    assert.equal(alive, false);
    assert.equal(live.current, null);
    assert.match(lost, /server is down/);
  });

  it('does not open two replacements when syncs overlap', async () => {
    const f = fake({ syncs: [false, false, true] });
    const live = make(f.client);
    await live.open();
    await Promise.all([live.sync(10), live.sync(11)]);
    const opens = f.opened.length;
    assert.ok(opens <= 2, `one replacement, not ${opens - 1}`);
  });
});

describe('closing', () => {
  it('carries the final sync in the close, rather than syncing first', async () => {
    const f = fake();
    const live = make(f.client);
    await live.open();
    live.listened(7);
    await live.close(512);

    assert.equal(f.synced.length, 0, 'no separate sync — the tail would be reported twice');
    assert.deepEqual(f.closed, [{ id: 's1', body: { currentTime: 512, timeListened: 7, duration: 900 } }]);
  });

  it('is safe to call twice, and reports the tail once', async () => {
    const f = fake();
    const live = make(f.client);
    await live.open();
    live.listened(5);
    await live.close(100);
    await live.close(100);
    assert.equal(f.closed.length, 1);
  });

  it('stops reporting once closed', async () => {
    const f = fake();
    const live = make(f.client);
    await live.open();
    await live.close(100);
    assert.equal(await live.sync(200), false);
    assert.equal(f.synced.length, 0);
  });

  it('closes without a session without throwing', async () => {
    const f = fake();
    const live = make(f.client);
    await live.close(0);
    assert.deepEqual(f.closed, []);
  });
});

describe('how the audio is served', () => {
  const info = (playMethod: number): AbsSessionInfo => ({
    id: 's1',
    playMethod: playMethod as AbsSessionInfo['playMethod'],
    tracks: [],
    durationSec: 900,
    startedAtSec: 0,
  });

  it('calls only play method 2 a transcode', () => {
    assert.equal(isTranscode(info(0)), false, 'direct play');
    assert.equal(isTranscode(info(1)), false, 'direct stream');
    assert.equal(isTranscode(info(2)), true, 'transcode — HLS');
  });

  it('syncs often enough that a crash loses little', () => {
    assert.ok(SYNC_INTERVAL_MS <= 30_000);
    assert.ok(SYNC_INTERVAL_MS >= 5_000, 'not so often it is chatter');
  });
});
