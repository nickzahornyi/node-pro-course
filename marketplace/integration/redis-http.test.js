import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ds from '../dist/data-source.js';
import { createFixture, cleanupFixture } from '../dist/demo-fixture.js';
import { checkout } from '../dist/checkout.js';
import { connectRedis, requiredUrl } from '../dist/redis/connection.js';
import { AsideCache } from '../dist/redis/cache.js';
import { OrderStatusService } from '../dist/realtime/order-status.service.js';
import { passwordHash } from '../dist/auth/auth.service.js';
import { OrderEventsService } from '../dist/realtime/order-events.service.js';

const api = process.env.ASYNC_API_URL ?? 'http://127.0.0.1:3000';
const cache = connectRedis(requiredUrl('REDIS_URL'));
const state = connectRedis(requiredUrl('REDIS_QUEUE_URL'));
const scope = `hw23-http-${randomUUID()}`;
let fixture, cookie, session, access;
const draftIds = [];
const get = path => fetch(`${api}${path}`, { headers: { cookie } });

before(async () => {
  await Promise.all([cache.connect(), state.connect(), ds.initialize()]);
  fixture = await createFixture(ds, 10);
  const password = randomUUID();
  const [user] = await ds.query('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING email',[passwordHash(password),fixture.buyerId]);
  const login = await fetch(`${api}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:user.email,password})});
  assert.equal(login.status,200);
  access = (await login.json()).access_token;
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
      await ds.query(`DELETE FROM processed_messages WHERE message_id IN
        (SELECT id FROM outbox WHERE aggregate_id=ANY($1::text[]))`, [draftIds]);
      await ds.query('DELETE FROM outbox WHERE aggregate_id=ANY($1::text[])', [draftIds]);
      await ds.query('DELETE FROM orders WHERE id=ANY($1::bigint[])', [draftIds]);
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

test('cookie-less requests and invalid cookies do not allocate sessions outside /session', async () => {
  async function keys() {
    const found = [];
    let cursor = '0';
    do {
      const page = await state.scan(cursor, 'MATCH', 'shop:session:*', 'COUNT', 100);
      cursor = page[0]; found.push(...page[1]);
    } while (cursor !== '0');
    return found.sort();
  }
  const before = await keys();
  for (const headers of [{}, { cookie: 'sid=invalid' }, { cookie: `sid=${'0'.repeat(64)}` }]) {
    for (const path of ['/products', '/orders', '/missing']) {
      const response = await fetch(`${api}${path}`, { headers });
      assert.equal(response.headers.get('set-cookie'), null);
      await response.text();
    }
  }
  assert.deepEqual(await keys(), before);
});

test('committed checkout invalidates aggregates and fences an older cache fill; rollback preserves cache', async () => {
  const key = `shop:card:v1:${fixture.productId}`, path = `/products/${fixture.productId}/card`;
  const previous = await (await get(path)).json();
  await cache.del(key);
  let release, loaded;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { loaded = resolve; });
  const oldRead = new AsideCache(cache).get(fixture.productId, async () => {
    loaded(); await held; return previous;
  });
  try {
    await started;
    await checkout(ds, fixture.buyerId, fixture.productId, 1, { scope });
    assert.equal(await cache.exists(key), 0);
    const fresh = await (await get(path)).json();
    assert.equal(fresh.stock, 6); assert.equal(fresh.units_sold, '3'); assert.equal(fresh.orders_count, '2');
    release(); await oldRead;
    assert.deepEqual(JSON.parse(await cache.get(key)), fresh);
    await assert.rejects(checkout(ds, fixture.buyerId, fixture.productId, 1, {
      scope, afterOutbox() { throw new Error('rollback fixture'); },
    }), /rollback fixture/);
    assert.deepEqual(JSON.parse(await cache.get(key)), fresh);
  } finally { release(); await oldRead; }
});

test('POST /orders invalidates its product cards after commit and preserves the cache on replay', async () => {
  const key = `shop:card:v1:${fixture.productId}`, path = `/products/${fixture.productId}/card`;
  await (await get(path)).json();
  assert.equal(await cache.exists(key), 1);
  const intent = `hw23-http-${randomUUID()}`;
  const post = () => fetch(`${api}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': intent, cookie, authorization: `Bearer ${access}` },
    body: JSON.stringify({ items: [{ product_id: fixture.productId, quantity: 1 }] }),
  });
  const created = await post();
  assert.equal(created.status, 201);
  draftIds.push((await created.json()).id);
  assert.equal(await cache.exists(key), 0);
  const current = await (await get(path)).json();
  const replay = await post();
  assert.equal(replay.status, 201); await replay.text();
  assert.equal(replay.headers.get('idempotency-replay'), 'true');
  assert.deepEqual(JSON.parse(await cache.get(key)), current);
});

test('committed status changes invalidate the paid-sales aggregate', async () => {
  const [{ id }] = await ds.query('SELECT id FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [fixture.buyerId]);
  const path = `/products/${fixture.productId}/card`, key = `shop:card:v1:${fixture.productId}`;
  assert.equal((await (await get(path)).json()).units_sold, '3');
  const service = new OrderStatusService({
    transaction: operation => ds.transaction(manager => operation({
      query: async (sql, parameters) => ({ rows: await manager.query(sql, parameters) }),
    })),
  }, new OrderEventsService());
  await service.change(id, fixture.buyerId, 'cancelled');
  assert.equal(await cache.exists(key), 0);
  const fresh = await (await get(path)).json();
  assert.equal(fresh.units_sold, '2'); assert.equal(fresh.orders_count, '1');
});

test('POST /orders shares the product limit and returns 429 with Retry-After before writing', async () => {
  const [{ n: before }] = await ds.query('SELECT count(*)::int AS n FROM orders');
  const responses = await Promise.all(Array.from({ length: 105 }, () => fetch(`${api}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `limit-${randomUUID()}` },
    body: JSON.stringify({ items: [] }),
  })));
  assert(responses.every(response => [400, 429].includes(response.status)));
  const blocked = responses.filter(response => response.status === 429);
  assert(blocked.length > 0);
  assert(blocked.every(response => Number(response.headers.get('retry-after')) > 0));
  assert(responses.every(response => response.headers.get('set-cookie') === null));
  await Promise.all(responses.map(response => response.text()));
  const product = await get(`/products/${fixture.productId}/card`);
  assert.equal(product.status, 429); await product.text();
  const health = await fetch(`${api}/health`);
  assert.equal(health.status, 200); await health.text();
  const [{ n: after }] = await ds.query('SELECT count(*)::int AS n FROM orders');
  assert.equal(after, before);
});
