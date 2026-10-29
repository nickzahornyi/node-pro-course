import { AuthService, passwordHash } from '../auth/auth.service.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import dataSource from '../data-source.js';
import { OrderConsumer } from '../async/consumer.js';
import { ConfirmedPublisher, connectBroker } from '../async/publisher.js';
import { declareTopology, topology } from '../async/topology.js';
import { OrderCreationService } from '../order-creation.service.js';
import { OutboxRelay } from './relay.js';

const mode = process.argv[2];
if (mode !== 'outbox' && mode !== 'crash-write' && mode !== 'crash-relay') throw new Error('Unknown outbox demo');
const url = process.env.BROKER_URL;
if (!url) throw new Error('BROKER_URL is required');
const scope = `hw22.${mode}`, key = `hw22-demo-${mode}`, names = topology(mode);
const fault = new Error('HW22 intentional crash boundary');
await dataSource.initialize();
const relay = new OutboxRelay(dataSource);
const lock = dataSource.createQueryRunner();
let connection: Awaited<ReturnType<typeof connectBroker>> | undefined;
let publisher: ConfirmedPublisher | undefined;
let consumer: OrderConsumer | undefined;
let app: INestApplication | undefined;
await lock.connect(); await lock.startTransaction();
try {
  await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope]);
  connection = await connectBroker(url);
  const admin = await connection.createChannel(); admin.on('error', () => {});
  await declareTopology(admin, names); // Demo orchestration is a bootstrap step.
  for (const queue of [names.work, names.dlq]) {
    assert.equal((await admin.checkQueue(queue)).consumerCount, 0, 'Demo already has a consumer');
    await admin.purgeQueue(queue);
  }
  const product = await dataSource.transaction(async manager => {
    await manager.query('DELETE FROM processed_messages WHERE message_id IN (SELECT id FROM outbox WHERE relay_scope=$1)', [scope]);
    await manager.query('DELETE FROM outbox WHERE relay_scope=$1', [scope]);
    const [seller] = await manager.query(`INSERT INTO users(email,display_name) VALUES($1,'HW22 demo seller')
      ON CONFLICT(lower(email)) DO UPDATE SET display_name=users.display_name RETURNING id`, [`${scope}@demo.marketplace.invalid`]);
    await manager.query('DELETE FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE product_id IN (SELECT id FROM products WHERE seller_id=$1))', [seller.id]);
    await manager.query('DELETE FROM order_requests WHERE key=$1', [key]);
    await manager.query('DELETE FROM products WHERE seller_id=$1', [seller.id]);
    const [row] = await manager.query("INSERT INTO products(seller_id,name,price_cents,stock) VALUES($1,'HW22 demo product',1000,10) RETURNING id", [seller.id]);
    return row;
  });

  // Full, real HTTP boundary on an ephemeral port. Only this private application
  // instance gets the in-process fault/scope hook; no HTTP/env fault switches exist.
  process.env.AUTH_SECRET ??= randomBytes(32).toString('hex');
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../configure-app.js');
  app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  const creation = app.get(OrderCreationService);
  const create = creation.create.bind(creation);
  let failedWrite = 0;
  creation.create = (idempotencyKey, body, _options, userId) => create(idempotencyKey, body, { scope,
    afterOutbox: mode === 'crash-write' ? async (query, event) => {
      failedWrite++;
      // Actual business SQL failure (CHECK), on the SAME transaction connection.
      await query("UPDATE orders SET status='invalid-hw22-status' WHERE id=$1", [event.data.orderId]);
    } : undefined }, userId);
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const password = randomBytes(24).toString('hex');
  const [identity] = await dataSource.query('UPDATE users SET password_hash=$1 WHERE id=(SELECT seller_id FROM products WHERE id=$2) RETURNING email',[passwordHash(password),product.id]);
  const token = (await app.get(AuthService).login(identity.email,password)).access_token;
  const endpoint = `${await app.getUrl()}/orders`;
  const post = () => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key, authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [{ product_id: product.id, quantity: 1 }] }) });
  const first = await post();
  if (mode === 'crash-write') {
    assert.equal(first.status, 500); assert.equal(failedWrite, 1);
  } else {
    assert.equal(first.status, 201);
    const body = await first.json();
    if (mode === 'outbox') {
      const second = await post(); assert.equal(second.status, 201);
      assert.equal(second.headers.get('Idempotency-Replay'), 'true');
      assert.deepEqual(await second.json(), body);
    }
  }
  const scalar = async (sql: string, args: unknown[]) => Number((await dataSource.query(sql, args))[0].n);
  const countOrders = () => scalar('SELECT count(*)::int AS n FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE product_id=$1)', [product.id]);
  const countOutbox = () => scalar('SELECT count(*)::int AS n FROM outbox WHERE relay_scope=$1', [scope]);
  assert.equal(await countOrders(), mode === 'crash-write' ? 0 : 1);
  assert.equal(await countOutbox(), mode === 'crash-write' ? 0 : 1);
  assert.equal((await admin.checkQueue(names.work)).messageCount, 0, 'API must NOT publish directly');

  publisher = await ConfirmedPublisher.open(url, names.exchange);
  let published = 0;
  const observed = { async publish(event: Parameters<ConfirmedPublisher['publish']>[0]) { await publisher!.publish(event); published++; } };
  if (mode === 'crash-relay') {
    await assert.rejects(relay.batch(observed, { scope, afterPublish: () => { throw fault; } }), error => error === fault);
    assert.equal(published, 1);
    assert.equal(await scalar('SELECT count(*)::int AS n FROM outbox WHERE relay_scope=$1 AND published_at IS NULL', [scope]), 1);
    assert.equal((await admin.checkQueue(names.work)).messageCount, 1);
  }
  await relay.batch(observed, { scope });
  const expected = mode === 'crash-write' ? 0 : mode === 'crash-relay' ? 2 : 1;
  assert.equal(published, expected);
  assert.equal((await admin.checkQueue(names.work)).messageCount, expected);
  consumer = new OrderConsumer(dataSource, names);
  await consumer.start(url);
  const deadline = Date.now() + 10000;
  while (consumer.stats.acked !== expected) {
    assert.ok(Date.now() < deadline, 'Consumer timed out'); await delay(20);
  }
  await consumer.stop();
  const effect = await scalar('SELECT count(*)::int AS n FROM order_notifications WHERE order_id IN (SELECT order_id FROM order_items WHERE product_id=$1)', [product.id]);
  const processed = await scalar('SELECT count(*)::int AS n FROM processed_messages WHERE message_id IN (SELECT id FROM outbox WHERE relay_scope=$1)', [scope]);
  const deliveries = consumer.stats.delivered;
  assert.equal(deliveries, expected); assert.equal(effect, expected ? 1 : 0);
  assert.equal(processed, effect); assert.equal(consumer.stats.effect, effect);
  assert.equal((await admin.checkQueue(names.dlq)).messageCount, 0);
  assert.equal(await scalar('SELECT count(*)::int AS n FROM outbox WHERE relay_scope=$1 AND published_at IS NOT NULL', [scope]), effect);
  if (mode === 'crash-relay') assert.equal(consumer.stats.skipped, 1);
  const summary = mode === 'outbox'
    ? { requests: 2, orders: await countOrders(), outbox: await countOutbox(), published, deliveries, effect, processed }
    : mode === 'crash-write'
      ? { 'write-failed': failedWrite, orders: await countOrders(), outbox: await countOutbox(), published, deliveries, effect }
      : { published, deliveries, applied: consumer.stats.effect, effect, processed };
  for (const [name, value] of Object.entries(summary)) console.log(`${name}=${value}`);
  await admin.close();
} finally {
  await consumer?.stop();
  await app?.close(); await publisher?.close(); await connection?.close().catch(() => {});
  await lock.rollbackTransaction(); await lock.release(); await dataSource.destroy();
}
