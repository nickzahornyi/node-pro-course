import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { io } from 'socket.io-client';
import request from 'supertest';
import { startDatabase, startApplication, truncate } from '../integration/testkit.js';
import { aProduct, insertUser } from '../integration/builders.js';
import { ProductsRepository } from '../../dist/repositories/products.repository.js';
import { OrdersRepository } from '../../dist/repositories/orders.repository.js';
import { OrderEventsService } from '../../dist/realtime/order-events.service.js';
import { issueToken } from '../../dist/realtime/token.js';

let database, app, base, ownerA, ownerB, orderA, orderB, tokenA, tokenB;
const sockets = new Set(), streams = new Set();
beforeAll(async () => { database = await startDatabase(); app = await startApplication(database); base = await app.getUrl(); });
afterAll(async () => { try { await app?.close(); } finally { await database?.stop(); } });
beforeEach(async () => {
  await truncate(database.pool);
  ownerA = await insertUser(database.pool); ownerB = await insertUser(database.pool);
  const product = await new ProductsRepository(database.pool).create(aProduct(ownerA.id));
  const repo = new OrdersRepository(database.pool);
  orderA = await repo.create(ownerA.id, [{ product_id: product.id, quantity: 1 }]);
  orderB = await repo.create(ownerB.id, [{ product_id: product.id, quantity: 1 }]);
  tokenA = issueToken(ownerA.id, database.env.AUTH_SECRET); tokenB = issueToken(ownerB.id, database.env.AUTH_SECRET);
});
afterEach(async () => {
  sockets.forEach(socket => socket.disconnect()); sockets.clear();
  for (const stream of streams) { stream.controller.abort(); await stream.reader.cancel().catch(() => {}); }
  streams.clear();
});

function deadline(promise, ms = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Realtime timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}
async function connect(token) {
  const socket = io(base, { transports: ['websocket'], auth: { token }, autoConnect: false, reconnection: false });
  sockets.add(socket);
  await deadline(new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); }));
  return socket;
}
const patch = (order, token, status) => request(app.getHttpServer()).patch(`/orders/${order.id}/status`).set('Authorization', `Bearer ${token}`).send({ status });

async function openStream(order, token, lastId) {
  const controller = new AbortController();
  const response = await deadline(fetch(`${base}/orders/${order.id}/events`, { signal: controller.signal,
    headers: { Authorization: `Bearer ${token}`, ...(lastId === undefined ? {} : { 'Last-Event-ID': String(lastId) }) } }));
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
  const stream = { controller, reader: response.body.getReader(), text: '', decoder: new TextDecoder() };
  streams.add(stream);
  return stream;
}
async function nextEvent(stream) {
  return deadline((async () => {
    while (true) {
      let boundary;
      while ((boundary = stream.text.indexOf('\n\n')) !== -1) {
        const frame = stream.text.slice(0, boundary); stream.text = stream.text.slice(boundary + 2);
        if (!frame.startsWith('id:')) continue;
        const lines = Object.fromEntries(frame.split('\n').map(line => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
        return { id: Number(lines.id), event: lines.event, data: JSON.parse(lines.data) };
      }
      const chunk = await stream.reader.read();
      if (chunk.done) throw new Error('SSE unexpectedly closed');
      stream.text += stream.decoder.decode(chunk.value, { stream: true });
    }
  })());
}

it('headless demo measures different rooms and the same-room positive control', async () => {
  const env = { ...process.env, REALTIME_URL: base, REALTIME_ORDER_A: orderA.id, REALTIME_ORDER_B: orderB.id, REALTIME_TOKEN_A: tokenA, REALTIME_TOKEN_B: tokenB };
  const run = promisify(execFile);
  const normal = await run(process.execPath, ['scripts/realtime-demo.mjs'], { env, timeout: 20000 });
  expect(normal.stdout).toBe('A_RECEIVED=1\nB_RECEIVED=0\n');
  const control = await run(process.execPath, ['scripts/realtime-demo.mjs', '--same-room'], { env, timeout: 20000 });
  expect(control.stdout).toBe('A_RECEIVED=1\nB_RECEIVED=1\n');
});

it('rejects anonymous, forged and foreign identities for WS, SSE and status changes', async () => {
  await expect(connect(undefined)).rejects.toThrow('Unauthorized');
  await expect(connect(issueToken(ownerA.id, 'another-signing-key-at-least-32-characters'))).rejects.toThrow('Unauthorized');
  const foreign = await connect(tokenB);
  const ack = await foreign.timeout(5000).emitWithAck('join', { order_id: orderA.id });
  expect(ack).toMatchObject({ ok: false, status: 403 });
  await request(app.getHttpServer()).get(`/orders/${orderA.id}/events`).expect(401);
  await request(app.getHttpServer()).get(`/orders/${orderA.id}/events`).set('Authorization', `Bearer ${tokenB}`).expect(403);
  await request(app.getHttpServer()).patch(`/orders/${orderA.id}/status`).send({ status: 'paid' }).expect(401);
  await patch(orderA, tokenB, 'paid').expect(403);
  expect((await database.pool.query('SELECT status FROM orders WHERE id=$1', [orderA.id])).rows[0].status).toBe('pending');
});

it('SSE and WebSocket carry the same committed event, and GET reflects the status', async () => {
  const socket = await connect(tokenA);
  expect(await socket.timeout(5000).emitWithAck('join', { order_id: orderA.id })).toMatchObject({ ok: true });
  const stream = await openStream(orderA, tokenA);
  const received = deadline(new Promise(resolve => socket.once('order.status', resolve)));
  const changed = await patch(orderA, tokenA, 'paid').expect(200);
  const frame = await nextEvent(stream), event = await received;
  expect(frame.event).toBe('order.status'); expect(frame.id).toBe(changed.body.event_id);
  expect(frame.data).toEqual(event); expect(event).toMatchObject({ order_id: orderA.id, previous_status: 'pending', status: 'paid' });
  expect((await database.pool.query('SELECT status FROM orders WHERE id=$1', [orderA.id])).rows[0].status).toBe(event.status);
  const read = await request(app.getHttpServer()).get(`/orders/${orderA.id}`).expect(200);
  expect(read.body.status).toBe('paid');
});

it('Last-Event-ID replays only missed events of the owned order without duplicates', async () => {
  const changes = [];
  for (const status of ['paid', 'shipped', 'pending', 'cancelled']) changes.push((await patch(orderA, tokenA, status).expect(200)).body);
  await patch(orderB, tokenB, 'paid').expect(200);
  const stream = await openStream(orderA, tokenA, changes[2].event_id);
  const replay = await nextEvent(stream);
  expect(replay.id).toBe(changes[3].event_id); expect(replay.data.status).toBe('cancelled');
  const live = await patch(orderA, tokenA, 'paid').expect(200);
  expect((await nextEvent(stream)).id).toBe(live.body.event_id);
  await request(app.getHttpServer()).get(`/orders/${orderA.id}/events`).set('Authorization', `Bearer ${tokenA}`).set('Last-Event-ID', '-1').expect(400);
  await request(app.getHttpServer()).get(`/orders/${orderA.id}/events`).set('Authorization', `Bearer ${tokenA}`).set('Last-Event-ID', '999999999').expect(400);
});

it('no-op, invalid status and rolled-back transaction publish no events', async () => {
  const bus = app.get(OrderEventsService), received = [];
  const subscription = bus.observeAll().subscribe(event => received.push(event));
  try {
    const noop = await patch(orderA, tokenA, 'pending').expect(200);
    expect(noop.body).toMatchObject({ changed: false, event_id: null });
    await patch(orderA, tokenA, 'unknown').expect(400);
    await database.pool.query(`CREATE FUNCTION reject_status_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced rollback'; END $$`);
    await database.pool.query(`CREATE TRIGGER reject_status_update BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION reject_status_update()`);
    try { await patch(orderA, tokenA, 'paid').expect(500); }
    finally { await database.pool.query('DROP TRIGGER reject_status_update ON orders; DROP FUNCTION reject_status_update()'); }
    expect(received).toHaveLength(0);
    expect((await database.pool.query('SELECT status FROM orders WHERE id=$1', [orderA.id])).rows[0].status).toBe('pending');
  } finally { subscription.unsubscribe(); }
});

it('concurrent status changes retain commit order and monotonic event IDs', async () => {
  const bus = app.get(OrderEventsService), received = [];
  const subscription = bus.observe(orderA.id).subscribe(event => received.push(event));
  try {
    await Promise.all(['paid', 'shipped', 'cancelled'].map(status => patch(orderA, tokenA, status).expect(200)));
    expect(received).toHaveLength(3);
    expect(received[0].previous_status).toBe('pending');
    for (let i = 1; i < received.length; i++) {
      expect(received[i].id).toBeGreaterThan(received[i - 1].id);
      expect(received[i].previous_status).toBe(received[i - 1].status);
    }
    expect((await database.pool.query('SELECT status FROM orders WHERE id=$1', [orderA.id])).rows[0].status).toBe(received.at(-1).status);
  } finally { subscription.unsubscribe(); }
});

it('later status changes preserve the original idempotent POST response', async () => {
  const product = await new ProductsRepository(database.pool).create(aProduct(ownerA.id));
  const body = { items: [{ product_id: product.id, quantity: 1 }] };
  const created = await request(app.getHttpServer()).post('/orders').set('Idempotency-Key', 'status-replay').send(body).expect(201);
  const { rows: [guest] } = await database.pool.query('SELECT user_id FROM orders WHERE id=$1', [created.body.id]);
  await patch(created.body, issueToken(guest.user_id, database.env.AUTH_SECRET), 'paid').expect(200);
  const replay = await request(app.getHttpServer()).post('/orders').set('Idempotency-Key', 'status-replay').send(body).expect(201);
  expect(replay.headers['idempotency-replay']).toBe('true'); expect(replay.body).toEqual(created.body);
  expect((await request(app.getHttpServer()).get(`/orders/${created.body.id}`).expect(200)).body.status).toBe('paid');
});
