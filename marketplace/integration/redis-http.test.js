import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ds from '../dist/data-source.js';
import { createFixture, cleanupFixture } from '../dist/demo-fixture.js';
import { checkout } from '../dist/checkout.js';
import { connectRedis, requiredUrl } from '../dist/redis/connection.js';

const api = process.env.ASYNC_API_URL ?? 'http://127.0.0.1:3000';
const cache = connectRedis(requiredUrl('REDIS_URL'));
const state = connectRedis(requiredUrl('REDIS_QUEUE_URL'));
const scope = `hw23-http-${randomUUID()}`;
let fixture, cookie, session;
const get = path => fetch(`${api}${path}`, { headers: { cookie } });

before(async () => {
  await Promise.all([cache.connect(), state.connect(), ds.initialize()]);
  fixture = await createFixture(ds, 10);
  await checkout(ds, fixture.buyerId, fixture.productId, 2, { scope });
  const response = await fetch(`${api}/session`);
  assert.equal(response.status, 200);
  session = await response.json();
  cookie = response.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  try {
    if (session) await state.del(`shop:session:${session.id}`);
    if (fixture) await cache.del(`shop:card:v1:${fixture.productId}`);
    if (ds.isInitialized) {
      await ds.query('DELETE FROM outbox WHERE relay_scope=$1', [scope]);
      if (fixture) await cleanupFixture(ds, fixture.buyerId);
    }
  } finally {
    cache.disconnect(); state.disconnect();
    if (ds.isInitialized) await ds.destroy();
  }
});

test('real Nest/OpenAPI card reads SQL aggregates, then serves cached data until invalidated', async () => {
  const path = `/products/${fixture.productId}/card`;
  const response = await get(path);
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.stock, 8);
  assert.equal(card.units_sold, '2');
  assert.equal(card.orders_count, '1');
  assert.equal(card.price_cents, '100');
  const key = `shop:card:v1:${fixture.productId}`;
  assert.deepEqual(JSON.parse(await cache.get(key)), card);
  assert(await cache.ttl(key) > 0);
  await ds.query('UPDATE products SET stock=7 WHERE id=$1', [fixture.productId]);
  assert.deepEqual(await (await get(path)).json(), card);
  await cache.del(key);
  assert.equal((await (await get(path)).json()).stock, 7);
});

test('real Nest middleware renews persisted anonymous sessions and cookie expiry', async () => {
  const key = `shop:session:${session.id}`;
  assert.equal(await state.exists(key), 1);
  await state.expire(key, 5);
  const response = await get('/session');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), session);
  assert(await state.ttl(key) > 1700);
  assert.match(response.headers.get('set-cookie'), /Max-Age=1800/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
});
