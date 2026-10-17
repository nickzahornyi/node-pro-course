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

let database, ds, buyer, product;
beforeAll(async () => {
  database = await startDatabase();
  ds = new DataSource({ type: 'postgres', url: database.container.getConnectionUri(),
    entities: [User, Product, Order, OrderItem, Job], synchronize: false });
  await ds.initialize();
});
afterAll(async () => { await ds?.destroy(); await database?.stop(); });
beforeEach(async () => {
  await truncate(database.pool);
  buyer = await insertUser(database.pool);
  product = (await database.pool.query("INSERT INTO products(seller_id,name,price_cents,stock) VALUES($1,'Async test',1250,10) RETURNING *", [buyer.id])).rows[0];
});

it('publishes the deliberately designed stable envelope only after checkout COMMIT', async () => {
  let event;
  const id = await checkout(ds, buyer.id, product.id, 2, { async publish(value) {
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

it('does not publish rolled-back checkout; broker failure does not undo an already committed order', async () => {
  let calls = 0;
  const publisher = { async publish() { calls++; throw new Error('broker unavailable'); } };
  await expect(checkout(ds, buyer.id, product.id, 11, publisher)).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
  expect(calls).toBe(0);
  await expect(checkout(ds, buyer.id, product.id, 1, publisher)).rejects.toThrow('broker unavailable');
  expect(calls).toBe(1);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(1);
  expect((await database.pool.query('SELECT stock FROM products')).rows[0].stock).toBe(9);
});

it('rejects forged order data before applying any effect', async () => {
  let event;
  await checkout(ds, buyer.id, product.id, 1, { async publish(value) { event = value; } });
  await expect(applyOrderPlaced(ds, { ...event, data: { ...event.data, totalCents: '999' } })).rejects.toThrow();
  expect((await database.pool.query('SELECT count(*)::int AS n FROM order_notifications')).rows[0].n).toBe(0);
});

it('really reverts and reapplies the notification migration', async () => {
  await checkout(ds, buyer.id, product.id);
  const cli = action => promisify(execFile)(process.execPath,
    ['node_modules/typeorm/cli.js', action, '-d', 'dist/data-source.js'], { env: database.env });
  await cli('migration:revert');
  expect((await database.pool.query("SELECT to_regclass('public.order_notifications') AS name")).rows[0].name).toBeNull();
  expect((await database.pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='orders' AND column_name='placed_event_id'")).rows[0].n).toBe(0);
  await cli('migration:run');
  expect((await database.pool.query("SELECT to_regclass('public.order_notifications') AS name")).rows[0].name).toBe('order_notifications');
  expect((await database.pool.query('SELECT placed_event_id FROM orders')).rows[0].placed_event_id).toMatch(/^[0-9a-f-]{36}$/);
});
