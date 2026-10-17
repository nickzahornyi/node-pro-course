import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfirmedPublisher, connectBroker } from '../dist/async/publisher.js';
import { declareTopology } from '../dist/async/topology.js';
import ds from '../dist/data-source.js';
import { mkdtemp, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainDlq } from '../dist/async/drain-dlq.js';

test('real broker returns unmatched routing keys despite positive confirms', async () => {
  assert.ok(process.env.BROKER_URL, 'BROKER_URL is required');
  const prefix = `shop.test.${randomUUID()}`;
  const names = { exchange: `${prefix}.events`, work: `${prefix}.work`, dlx: `${prefix}.dlx`, dlq: `${prefix}.dlq` };
  const connection = await connectBroker(process.env.BROKER_URL);
  const channel = await connection.createChannel();
  let publisher;
  try {
    await declareTopology(channel, names);
    publisher = await ConfirmedPublisher.open(process.env.BROKER_URL, names.exchange);
    await assert.rejects(publisher.publishRaw({ eventId: randomUUID() }, 'no.match'), /mandatory return/);
    assert.equal((await channel.checkQueue(names.work)).messageCount, 0);
    const eventId = randomUUID();
    await publisher.publishRaw({ eventId });
    const message = await channel.get(names.work, { noAck: false });
    assert.ok(message); assert.equal(message.properties.messageId, eventId);
    assert.equal(message.properties.deliveryMode, 2);
    channel.ack(message);
  } finally {
    await publisher?.close();
    await channel.deleteQueue(names.work); await channel.deleteQueue(names.dlq);
    await channel.deleteExchange(names.exchange); await channel.deleteExchange(names.dlx);
    await connection.close();
  }
});

test('live AppModule POST produces one durable effect, including idempotent HTTP replay', async () => {
  const api = process.env.ASYNC_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  await ds.initialize();
  let sellerId, productId, orderId;
  try {
    [ { id: sellerId } ] = await ds.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`${randomUUID()}@async-test.invalid`, 'Async HTTP test']);
    [ { id: productId } ] = await ds.query("INSERT INTO products(seller_id,name,price_cents,stock) VALUES($1,'Async HTTP test',1250,10) RETURNING id", [sellerId]);
    const key = `hw19-test-${randomUUID()}`;
    const post = quantity => fetch(`${api}/orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ items: [{ product_id: productId, quantity }] }) });
    const response = await post(2); assert.equal(response.status, 201);
    const body = await response.json(); orderId = body.id;
    const replay = await post(2); assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('Idempotency-Replay'), 'true');
    assert.deepEqual(await replay.json(), body);
    const different = await post(3); assert.equal(different.status, 422);
    const deadline = Date.now() + 5000;
    let rows;
    do {
      rows = await ds.query('SELECT n.event_id,n.total_cents,o.placed_event_id FROM order_notifications n JOIN orders o ON o.id=n.order_id WHERE n.order_id=$1', [orderId]);
      if (rows.length) break;
      await delay(20);
    } while (Date.now() < deadline);
    assert.equal(rows.length, 1); assert.equal(rows[0].event_id, rows[0].placed_event_id);
    assert.equal(rows[0].total_cents, '2500');
  } finally {
    // Only this test's fixtures, never the shared guest or unrelated orders.
    if (productId) await ds.transaction(async manager => {
      const ids = await manager.query('SELECT DISTINCT order_id::text AS id FROM order_items WHERE product_id=$1', [productId]);
      const orderIds = ids.map(row => row.id);
      await manager.query(`DELETE FROM processed_messages WHERE message_id IN
        (SELECT id FROM outbox WHERE aggregate_type='order' AND aggregate_id=ANY($1::text[]))`, [orderIds]);
      await manager.query("DELETE FROM outbox WHERE aggregate_type='order' AND aggregate_id=ANY($1::text[])", [orderIds]);
    });
    if (productId) await ds.query('DELETE FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE product_id=$1)', [productId]);
    if (productId) await ds.query('DELETE FROM products WHERE id=$1', [productId]);
    if (sellerId) await ds.query('DELETE FROM users WHERE id=$1', [sellerId]);
    await ds.destroy();
  }
});

test('DLQ drain archives poison headers/body before ACK; storage failure keeps the delivery', async () => {
  const prefix = `shop.test.${randomUUID()}`;
  const names = { exchange: `${prefix}.events`, work: `${prefix}.work`, dlx: `${prefix}.dlx`, dlq: `${prefix}.dlq` };
  const directory = await mkdtemp(join(tmpdir(), 'marketplace-dlq-'));
  const connection = await connectBroker(process.env.BROKER_URL);
  const admin = await connection.createChannel();
  let publisher, reader;
  try {
    await declareTopology(admin, names);
    publisher = await ConfirmedPublisher.open(process.env.BROKER_URL, names.exchange);
    const payload = { eventId: randomUUID(), invalid: true };
    const poison = async () => {
      await publisher.publishRaw(payload);
      const message = await admin.get(names.work, { noAck: false });
      assert.ok(message); admin.reject(message, false);
      const deadline = Date.now() + 5000;
      while ((await admin.checkQueue(names.dlq)).messageCount !== 1) {
        assert.ok(Date.now() < deadline, 'Poison never reached DLQ'); await delay(20);
      }
    };
    await poison();
    assert.deepEqual(await drainDlq(admin, names.dlq, directory, 1), { archived: 1, remaining: 0, archive: directory });
    const files = await readdir(directory); assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
    assert.equal(record.reason, 'rejected');
    assert.equal(record.properties.headers['x-death'][0].reason, 'rejected');
    assert.deepEqual(JSON.parse(Buffer.from(record.contentBase64, 'base64')), payload);
    assert.equal((await drainDlq(admin, names.dlq, directory, 1)).archived, 0);

    await poison();
    reader = await connection.createChannel();
    const failingDirectory = join(directory, 'vanishes');
    // Real delivery, then the archive mount disappears before the write.
    const failingChannel = {
      checkQueue: queue => reader.checkQueue(queue),
      get: async (...args) => { const message = await reader.get(...args); await rmdir(failingDirectory); return message; },
      ack: () => assert.fail('Must not ACK when archive write fails'),
    };
    await assert.rejects(drainDlq(failingChannel, names.dlq, failingDirectory, 1), { code: 'ENOENT' });
    await reader.close(); reader = undefined;
    let recovered;
    const deadline = Date.now() + 5000;
    while (!(recovered = await admin.get(names.dlq, { noAck: false }))) {
      assert.ok(Date.now() < deadline, 'Unacked delivery was not requeued'); await delay(20);
    }
    assert.ok(recovered); assert.equal(recovered.fields.redelivered, true);
    admin.ack(recovered);
  } finally {
    await reader?.close().catch(() => {}); await publisher?.close();
    await admin.deleteQueue(names.work); await admin.deleteQueue(names.dlq);
    await admin.deleteExchange(names.exchange); await admin.deleteExchange(names.dlx);
    await connection.close(); await rm(directory, { recursive: true, force: true });
  }
});
