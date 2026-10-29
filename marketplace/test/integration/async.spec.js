import { beforeAll, afterAll, beforeEach, it, expect } from '@jest/globals';
import { DataSource } from 'typeorm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDatabase, truncate } from './testkit.js';
import { insertUser } from './builders.js';
import { User } from '../../dist/entities/user.entity.js';
import { Product } from '../../dist/entities/product.entity.js';
import { Order } from '../../dist/entities/order.entity.js';
import { OrderItem } from '../../dist/entities/order-item.entity.js';
import { Job } from '../../dist/entities/job.entity.js';
import { checkout } from '../../dist/checkout.js';
import { applyOrderPlaced } from '../../dist/async/effect.js';
import { OutboxRelay } from '../../dist/outbox/relay.js';

let database, ds, buyer, product, relay;
beforeAll(async () => {
  database = await startDatabase();
  ds = new DataSource({ type: 'postgres', url: database.container.getConnectionUri(),
    entities: [User, Product, Order, OrderItem, Job], synchronize: false });
  await ds.initialize();
});
afterAll(async () => { await ds?.destroy(); await database?.stop(); });
beforeEach(async () => {
  relay = new OutboxRelay(ds);
  await truncate(database.pool);
  buyer = await insertUser(database.pool);
  product = (await database.pool.query("INSERT INTO products(seller_id,name,price_cents,stock) VALUES($1,'Async test',1250,10) RETURNING *", [buyer.id])).rows[0];
});

it('commits order and stable outbox envelope together, then relays after COMMIT', async () => {
  let event;
  const id = await checkout(ds, buyer.id, product.id, 2);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).rows[0].n).toBe(1);
  await relay.batch({ async publish(value) {
    event = value;
    // Different connection: uncommitted orders would not be visible here.
    const row = (await database.pool.query('SELECT * FROM orders WHERE id=$1', [value.data.orderId])).rows[0];
    expect(row.status).toBe('paid');
    expect(value.eventId).toBe(row.placed_event_id);
  } });
  expect(event).toMatchObject({ type: 'order.placed', version: 1, data: { orderId: id, buyerId: buyer.id, totalCents: '2500' } });
  expect(Object.keys(event).sort()).toEqual(['data', 'eventId', 'occurredAt', 'type', 'version']);
  const results = await Promise.all(Array.from({ length: 12 }, () => applyOrderPlaced(ds, event)));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM order_notifications')).rows[0].n).toBe(1);
  await ds.destroy(); await ds.initialize();
  expect(await applyOrderPlaced(ds, event)).toBe(false);
});

it('rolls back business + outbox after enqueue; broker failure leaves a committed pending event', async () => {
  let calls = 0;
  const publisher = { async publish() { calls++; throw new Error('broker unavailable'); } };
  await expect(checkout(ds, buyer.id, product.id, 11)).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
  await expect(checkout(ds, buyer.id, product.id, 1, { afterOutbox() { throw new Error('write failed after outbox'); } })).rejects.toThrow('write failed after outbox');
  expect((await database.pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(0);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(0);
  expect((await database.pool.query('SELECT stock FROM products')).rows[0].stock).toBe(10);
  expect(calls).toBe(0);
  await checkout(ds, buyer.id, product.id);
  await expect(relay.batch(publisher)).rejects.toThrow('broker unavailable');
  expect(calls).toBe(1);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(1);
  expect((await database.pool.query('SELECT stock FROM products')).rows[0].stock).toBe(9);
  expect((await database.pool.query('SELECT published_at,attempts FROM outbox')).rows[0]).toEqual({ published_at: null, attempts: 0 });
  // The next call commits the prior failure even if publishing fails again.
  await expect(relay.batch(publisher)).rejects.toThrow('broker unavailable');
  expect((await database.pool.query('SELECT attempts FROM outbox')).rows[0].attempts).toBe(1);
  expect(await relay.batch({ async publish() {} })).toBe(1);
  expect((await database.pool.query('SELECT attempts FROM outbox')).rows[0].attempts).toBe(3);
  expect(await relay.batch({ async publish() {} })).toBe(0);
  expect((await database.pool.query('SELECT attempts FROM outbox')).rows[0].attempts).toBe(3);
});

it('rejects forged order data before applying any effect', async () => {
  let event;
  await checkout(ds, buyer.id, product.id);
  event = (await database.pool.query('SELECT payload FROM outbox')).rows[0].payload;
  await expect(applyOrderPlaced(ds, { ...event, data: { ...event.data, totalCents: '999' } })).rejects.toThrow();
  expect((await database.pool.query('SELECT count(*)::int AS n FROM order_notifications')).rows[0].n).toBe(0);
});

it('really reverts and reapplies outbox/inbox migration without deleting business orders', async () => {
  await checkout(ds, buyer.id, product.id);
  const cli = action => promisify(execFile)(process.execPath,
    ['node_modules/typeorm/cli.js', action, '-d', 'dist/data-source.js'], { env: database.env });
  // Revert newer migrations too: auth now follows the outbox migration.
  for (let count = 0; count < 10; count++) {
    if (!(await database.pool.query("SELECT to_regclass('public.outbox') AS name")).rows[0].name) break;
    await cli('migration:revert');
  }
  expect((await database.pool.query("SELECT to_regclass('public.outbox') AS name")).rows[0].name).toBeNull();
  expect((await database.pool.query("SELECT to_regclass('public.processed_messages') AS name")).rows[0].name).toBeNull();
  await cli('migration:run');
  expect((await database.pool.query("SELECT to_regclass('public.outbox') AS name")).rows[0].name).toBe('outbox');
  expect((await database.pool.query("SELECT to_regclass('public.processed_messages') AS name")).rows[0].name).toBe('processed_messages');
  expect((await database.pool.query('SELECT placed_event_id FROM orders')).rows[0].placed_event_id).toMatch(/^[0-9a-f-]{36}$/);
});

it('inbox and natural-key effect roll back together and both levels survive retries', async () => {
  await checkout(ds, buyer.id, product.id);
  const event = (await database.pool.query('SELECT payload FROM outbox')).rows[0].payload;
  await expect(applyOrderPlaced(ds, event, () => { throw new Error('effect failed'); })).rejects.toThrow('effect failed');
  expect((await database.pool.query('SELECT count(*)::int AS n FROM processed_messages')).rows[0].n).toBe(0);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM order_notifications')).rows[0].n).toBe(0);
  expect(await applyOrderPlaced(ds, event)).toBe(true);
  // Remove only the inbox marker: natural order_id key must still prevent a second effect.
  await database.pool.query('DELETE FROM processed_messages WHERE message_id=$1', [event.eventId]);
  expect(await applyOrderPlaced(ds, event)).toBe(false);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM processed_messages')).rows[0].n).toBe(1);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM order_notifications')).rows[0].n).toBe(1);
});

it('parallel relays skip locked rows rather than blocking on a stalled publisher', async () => {
  await checkout(ds, buyer.id, product.id); await checkout(ds, buyer.id, product.id);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const ids = [];
  const first = relay.batch({ async publish(event) { ids.push(event.eventId); entered(); await held; } }, { batchSize: 1 });
  try {
    await started;
    expect(await new OutboxRelay(ds).batch({ async publish(event) { ids.push(event.eventId); } }, { batchSize: 1 })).toBe(1);
  } finally { release(); await first; }
  expect(new Set(ids).size).toBe(2);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NOT NULL')).rows[0].n).toBe(2);
});

it('crash after confirmed publish leaves pending row; retry delivers twice but applies once', async () => {
  await checkout(ds, buyer.id, product.id);
  const events = [];
  const publisher = { async publish(event) { events.push(event); } };
  await expect(relay.batch(publisher, { afterPublish() { throw new Error('relay crash'); } })).rejects.toThrow('relay crash');
  expect((await database.pool.query('SELECT published_at FROM outbox')).rows[0].published_at).toBeNull();
  await relay.batch(publisher);
  expect(events).toHaveLength(2); expect(events[0]).toEqual(events[1]);
  const effects = await Promise.all(events.map(event => applyOrderPlaced(ds, event)));
  expect(effects.filter(Boolean)).toHaveLength(1);
});

it('defers failure accounting while another relay holds the row, then counts it after publication', async () => {
  await checkout(ds, buyer.id, product.id);
  await expect(relay.batch({ async publish() { throw new Error('broker unavailable'); } })).rejects.toThrow('broker unavailable');
  let release, entered, timer;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const other = new OutboxRelay(ds).batch({ async publish() { entered(); await held; } });
  try {
    await started;
    const retry = relay.batch({ async publish() { throw new Error('Locked row must be skipped'); } });
    expect(await Promise.race([retry, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Failure accounting blocked on another relay')), 1500);
    })])).toBe(0);
    expect((await database.pool.query('SELECT attempts FROM outbox')).rows[0].attempts).toBe(0);
  } finally { clearTimeout(timer); release(); await other; }
  expect(await relay.batch({ async publish() { throw new Error('Published row must not be redelivered'); } })).toBe(0);
  expect((await database.pool.query('SELECT attempts FROM outbox')).rows[0].attempts).toBe(2);
  await relay.batch({ async publish() {} });
  expect((await database.pool.query('SELECT attempts FROM outbox')).rows[0].attempts).toBe(2);
});

it('limits default and explicit batches to five events', async () => {
  for (let n = 0; n < 6; n++) await checkout(ds, buyer.id, product.id);
  const publisher = { async publish() {} };
  await expect(relay.batch(publisher, { batchSize: 6 })).rejects.toThrow('batchSize must be 1..5');
  expect(await relay.batch(publisher)).toBe(5);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).rows[0].n).toBe(1);
  expect(await relay.batch(publisher)).toBe(1);
});
