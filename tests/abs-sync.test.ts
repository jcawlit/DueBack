/**
 * The progress rule in both directions, and the throttle that carries it.
 *
 * The rule is the valuable part and the easiest to get subtly wrong, so it
 * is tested at the level a caller uses: give it a server and a local place,
 * assert which one wins and whether anything was sent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPushScheduler,
  pushIfAhead,
  reconcile,
  PUSH_INTERVAL_MS,
} from '../src/lib/abs/sync.ts';
import type { AbsClient, AbsProgress } from '../src/lib/abs/client.ts';

type Pushed = { currentTime: number; duration: number; isFinished: boolean };

/** A client that answers with whatever the test wants, and records pushes. */
function fakeClient(
  server: AbsProgress | null | Error,
): AbsClient & { pushes: Pushed[]; reads: number } {
  const pushes: Pushed[] = [];
  const client = {
    reads: 0,
    pushes,
    async progress() {
      client.reads += 1;
      if (server instanceof Error) throw server;
      return server;
    },
    async pushProgress(_itemId: string, place: Pushed) {
      pushes.push(place);
    },
    async authorize() { throw new Error('not used'); },
    async libraries() { return []; },
    async libraryItems() { return []; },
    async item() { return {}; },
    async cover() { return new Uint8Array(); },
    currentAuth() { return { kind: 'apiKey' as const, apiKey: 'k' }; },
  };
  return client as unknown as AbsClient & { pushes: Pushed[]; reads: number };
}

const place = (currentTime: number, lastUpdate: number, isFinished = false): AbsProgress => ({
  currentTime,
  lastUpdate,
  isFinished,
  duration: 1000,
});

const OLD = Date.parse('2026-10-16T10:00:00.000Z');
const NEW = Date.parse('2026-10-18T10:00:00.000Z');

describe('deciding which side is ahead', () => {
  it('adopts the server when it wrote last', async () => {
    const client = fakeClient(place(500, NEW));
    const result = await reconcile(client, 'r1', {
      positionSec: 100,
      updatedAt: new Date(OLD).toISOString(),
    });
    assert.deepEqual(result, {
      outcome: 'adopted',
      positionSec: 500,
      isFinished: false,
      serverLastUpdate: NEW,
    });
  });

  it('keeps ours when this phone wrote last', async () => {
    const client = fakeClient(place(500, OLD));
    const result = await reconcile(client, 'r1', {
      positionSec: 100,
      updatedAt: new Date(NEW).toISOString(),
    });
    assert.deepEqual(result, { outcome: 'local-newer', positionSec: 100 });
  });

  it('says in-step when the server is newer but at the same place', async () => {
    // A push we made ourselves comes back as a newer server write at the
    // position we just sent. Adopting it would be a pointless round trip,
    // and would flash "picked up on another device" at somebody who did not.
    const client = fakeClient(place(300.4, NEW));
    const result = await reconcile(client, 'r1', {
      positionSec: 300,
      updatedAt: new Date(OLD).toISOString(),
    });
    assert.deepEqual(result, { outcome: 'in-step' });
  });

  it('is offline, not broken, when the server cannot be reached', async () => {
    const client = fakeClient(new Error('Network request failed'));
    const result = await reconcile(client, 'r1', { positionSec: 10, updatedAt: null });
    assert.deepEqual(result, { outcome: 'offline' });
  });

  it('is offline with no client at all', async () => {
    assert.deepEqual(await reconcile(null, 'r1', { positionSec: 10, updatedAt: null }), {
      outcome: 'offline',
    });
  });

  it('takes the server when this phone has never recorded a place', async () => {
    const client = fakeClient(place(42, OLD));
    const result = await reconcile(client, 'r1', { positionSec: 0, updatedAt: null });
    assert.equal(result.outcome, 'adopted');
  });

  it('carries the server finishing a book itself', async () => {
    const client = fakeClient(place(999, NEW, true));
    const result = await reconcile(client, 'r1', {
      positionSec: 10,
      updatedAt: new Date(OLD).toISOString(),
    });
    assert.equal(result.outcome === 'adopted' && result.isFinished, true);
  });
});

describe('pushing', () => {
  it('sends only when ours is the newer position', async () => {
    const client = fakeClient(place(500, OLD));
    await pushIfAhead(client, 'r1', {
      positionSec: 900,
      updatedAt: new Date(NEW).toISOString(),
      durationSec: 1000,
      isFinished: false,
    });
    assert.deepEqual(client.pushes, [{ currentTime: 900, duration: 1000, isFinished: false }]);
  });

  it('sends nothing when the server is ahead', async () => {
    const client = fakeClient(place(900, NEW));
    const result = await pushIfAhead(client, 'r1', {
      positionSec: 100,
      updatedAt: new Date(OLD).toISOString(),
      durationSec: 1000,
      isFinished: false,
    });
    assert.equal(result.outcome, 'adopted');
    assert.deepEqual(client.pushes, [], 'overwriting a newer position loses it for good');
  });

  it('re-reads before every push, because the other device may have moved', async () => {
    const client = fakeClient(place(1, OLD));
    const local = {
      positionSec: 50,
      updatedAt: new Date(NEW).toISOString(),
      durationSec: 1000,
      isFinished: false,
    };
    await pushIfAhead(client, 'r1', local);
    await pushIfAhead(client, 'r1', local);
    assert.equal(client.reads, 2);
  });

  it('sends isFinished honestly rather than inferring it', async () => {
    const client = fakeClient(null);
    await pushIfAhead(client, 'r1', {
      positionSec: 1000,
      updatedAt: new Date(NEW).toISOString(),
      durationSec: 1000,
      isFinished: true,
    });
    assert.equal(client.pushes[0].isFinished, true);
    // And never a progress fraction: the server computes that itself and
    // ignores what a client sends.
    assert.deepEqual(Object.keys(client.pushes[0]).sort(), [
      'currentTime',
      'duration',
      'isFinished',
    ]);
  });

  it('reports offline when the push itself fails, and keeps quiet', async () => {
    const client = fakeClient(null);
    (client as unknown as { pushProgress: () => Promise<void> }).pushProgress = async () => {
      throw new Error('Network request failed');
    };
    const result = await pushIfAhead(client, 'r1', {
      positionSec: 5,
      updatedAt: new Date(NEW).toISOString(),
      durationSec: 1000,
      isFinished: false,
    });
    assert.equal(result.outcome, 'offline');
  });
});

describe('the push throttle', () => {
  it('collapses a burst of changes into one send', async () => {
    const sent: string[] = [];
    const scheduler = createPushScheduler(async (id) => void sent.push(id), 10);
    for (let i = 0; i < 20; i += 1) scheduler.schedule('b1');
    assert.deepEqual(sent, [], 'nothing goes out immediately');
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(sent, ['b1'], 'one request for twenty position writes');
  });

  it('keeps a separate timer per book', async () => {
    const sent: string[] = [];
    const scheduler = createPushScheduler(async (id) => void sent.push(id), 10);
    scheduler.schedule('b1');
    scheduler.schedule('b2');
    assert.deepEqual(scheduler.pending().sort(), ['b1', 'b2']);
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(sent.sort(), ['b1', 'b2']);
  });

  it('flushes now for a pause, and cancels the pending timer', async () => {
    let sends = 0;
    const scheduler = createPushScheduler(async () => void (sends += 1), 10);
    scheduler.schedule('b1');
    await scheduler.flush('b1');
    assert.equal(sends, 1);
    assert.deepEqual(scheduler.pending(), []);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sends, 1, 'the timer that was waiting must not fire as well');
  });

  it('cancels everything on demand', async () => {
    let sends = 0;
    const scheduler = createPushScheduler(async () => void (sends += 1), 10);
    scheduler.schedule('b1');
    scheduler.cancelAll();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sends, 0);
  });

  it('waits a sensible interval by default', () => {
    // A request per position write would be one every few seconds for as
    // long as anyone listens.
    assert.ok(PUSH_INTERVAL_MS >= 30_000, 'too chatty');
    assert.ok(PUSH_INTERVAL_MS <= 300_000, 'too stale to be useful on a pause');
  });
});

describe('settling a position before playback', () => {
  /*
   * The bug this guards against, found on the phone: picking up another
   * device's position "worked sometimes". It was reconciled when one screen
   * opened, and every other route to playback — the mini player, "Keep
   * listening", the checked-out tray, the player route — skipped it; even
   * on that screen, pressing Play before the round trip returned started
   * from the stale position.
   *
   * `reconcileBeforePlay` lives in the store and needs a database, so what
   * is pinned here is the decision it is built on: the comparison must be
   * made fresh at the moment of playing, and must not block when the
   * server does not answer.
   */

  it('asks the server again rather than trusting an earlier answer', async () => {
    // Opening a screen, then playing a minute later: the second comparison
    // has to be a real round trip or it cannot see the other device.
    const client = fakeClient(place(700, NEW));
    const stale = { positionSec: 10, updatedAt: new Date(OLD).toISOString() };
    const first = await reconcile(client, 'r1', stale);
    const second = await reconcile(client, 'r1', stale);
    assert.equal(client.reads, 2, 'each decision costs a read, by design');
    assert.equal(first.outcome, 'adopted');
    assert.equal(second.outcome, 'adopted');
  });

  it('does not stall playback when the server never answers', async () => {
    // What the bounded wait in reconcileBeforePlay is built on: a reconcile
    // that hangs must be raced, not awaited. Here it is proved that a
    // hanging call does hang, so the race is load-bearing.
    const hanging = {
      async progress() {
        return new Promise(() => {});
      },
    } as unknown as Parameters<typeof reconcile>[0];

    const raced = await Promise.race([
      reconcile(hanging, 'r1', { positionSec: 5, updatedAt: null }),
      new Promise((resolve) => setTimeout(() => resolve({ outcome: 'timed-out' }), 30)),
    ]);
    assert.deepEqual(raced, { outcome: 'timed-out' });
  });

  it('starts where the server says when this phone has no stamp at all', async () => {
    // A freshly downloaded book has a position of zero and no local stamp,
    // and the server's place is the whole reason to check.
    const client = fakeClient(place(1234, OLD));
    const result = await reconcile(client, 'r1', { positionSec: 0, updatedAt: null });
    assert.deepEqual(result, {
      outcome: 'adopted',
      positionSec: 1234,
      isFinished: false,
      serverLastUpdate: OLD,
    });
  });

  it('leaves a locally-newer position alone, so a rewind is not undone', async () => {
    const client = fakeClient(place(900, OLD));
    const result = await reconcile(client, 'r1', {
      positionSec: 60,
      updatedAt: new Date(NEW).toISOString(),
    });
    assert.deepEqual(result, { outcome: 'local-newer', positionSec: 60 });
  });
});
