import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CachingReader } from '../src/lib/metadata/reader.ts';

for (const length of [8, 64]) {
  it(`rejects missing source bytes for a ${length}-byte request`, async () => {
    const reader = new CachingReader({
      size: async () => 100,
      read: async () => new Uint8Array(0),
      close: async () => {},
    }, 16);
    await assert.rejects(reader.read(0, length), /Short read at 0: requested .* returned 0/);
    assert.equal(reader.bytesRead, 0);
    assert.equal(reader.readCount, 1);
  });
}

it('clips reads at the reported EOF without inventing bytes', async () => {
  const reader = new CachingReader({
    size: async () => 3,
    read: async () => Uint8Array.of(1, 2, 3),
    close: async () => {},
  });
  assert.deepEqual(await reader.read(1, 10), Uint8Array.of(2, 3));
  assert.deepEqual(await reader.read(3, 10), new Uint8Array(0));
});
