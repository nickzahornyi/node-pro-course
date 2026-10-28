import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsideCache } from '../dist/redis/cache.js';

test('cache connection failure falls back to the repository', async () => {
  const cache = new AsideCache({ get: async () => { throw new Error('Redis unavailable'); } });
  assert.deepEqual(await cache.get('42', async () => ({ stock: 5 })), { stock: 5 });
});

test('Redis OOM on cache write or release does not fail a successful database read', async () => {
  const cache = new AsideCache({
    get: async () => null,
    set: async (_key, _value, expiry) => {
      if (expiry === 'PX') return 'OK';
      throw new Error('OOM command not allowed');
    },
    eval: async () => { throw new Error('connection lost'); },
  });
  assert.deepEqual(await cache.get('42', async () => ({ stock: 5 })), { stock: 5 });
});

test('database errors propagate once and release is attempted without hiding the error', async () => {
  const failure = new Error('database failure');
  let loads = 0, releases = 0;
  const cache = new AsideCache({ get: async () => null, set: async () => 'OK', eval: async () => { releases++; } });
  await assert.rejects(cache.get('42', async () => { loads++; throw failure; }), error => error === failure);
  assert.equal(loads, 1); assert.equal(releases, 1);
});
