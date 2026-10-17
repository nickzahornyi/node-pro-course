import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import dataSource from '../data-source.js';
import { checkout } from '../checkout.js';
import { ConfirmedPublisher, connectBroker } from './publisher.js';
import { declareTopology, PREFETCH, topology, type DemoMode } from './topology.js';
import type { ConsumerNotice, ConsumerStats } from './consumer.js';

const mode = process.argv[2] as DemoMode;
if (!['publish', 'dlq', 'duplicate'].includes(mode)) throw new Error('Expected publish, dlq or duplicate');
const url = process.env.BROKER_URL;
if (!url) throw new Error('BROKER_URL is required; use scripts/with-secrets.sh or SKIP_VAULT=1');
const names = topology(mode);
const workers: DemoWorker[] = [];

class DemoWorker {
  readonly child: ChildProcess;
  readonly notices: Array<ConsumerNotice | { kind: 'stopped'; stats: ConsumerStats }> = [];
  stats: ConsumerStats = { delivered: 0, effect: 0, skipped: 0, acked: 0, rejected: 0, redelivered: 0, processing_ms: 0 };
  private errorText = '';
  constructor(crash = false) {
    this.child = fork(fileURLToPath(new URL('./consumer-main.js', import.meta.url)), [`--demo=${mode}`, ...(crash ? ['--crash-after-effect'] : [])],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.child.on('message', message => {
      const notice = message as ConsumerNotice;
      this.notices.push(notice); if (notice.stats) this.stats = notice.stats;
    });
    this.child.stderr?.on('data', chunk => { this.errorText = (this.errorText + chunk.toString()).slice(-2000); });
    workers.push(this);
  }
  async until(condition: () => boolean) {
    const end = Date.now() + 20000;
    while (!condition()) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`Consumer exited unexpectedly: ${this.errorText}`);
      if (Date.now() >= end) throw new Error(`Consumer timed out: ${this.errorText}`);
      await delay(20);
    }
  }
  ready() { return this.until(() => this.notices.some(notice => notice.kind === 'ready')); }
  async exited() {
    const end = Date.now() + 5000;
    while (this.child.exitCode === null && this.child.signalCode === null) {
      if (Date.now() >= end) throw new Error('Consumer failed to exit');
      await delay(20);
    }
  }
  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.send({ kind: 'stop' });
    await this.exited(); assert.equal(this.child.exitCode, 0);
  }
}

await dataSource.initialize();
const lock = dataSource.createQueryRunner();
await lock.connect(); await lock.startTransaction();
let connection: Awaited<ReturnType<typeof connectBroker>> | undefined;
let publisher: ConfirmedPublisher | undefined;
try {
  // Transaction-scoped lock works through transaction-mode PgBouncer too.
  await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`hw19-demo-${mode}`]);
  const fixtures = await dataSource.transaction(async manager => {
    const user = async (role: string) => (await manager.query(`INSERT INTO users(email,display_name,balance_cents)
      VALUES($1,$2,10000) ON CONFLICT(lower(email)) DO UPDATE SET balance_cents=10000 RETURNING id`,
    [`hw19-${mode}-${role}@demo.marketplace.invalid`, `HW19 ${mode} ${role}`]))[0].id as string;
    const buyerId = await user('buyer'), sellerId = await user('seller');
    // Clean only this demo's fixtures; never TRUNCATE the application DB.
    await manager.query('DELETE FROM orders WHERE user_id=$1', [buyerId]);
    await manager.query('DELETE FROM products WHERE seller_id=$1', [sellerId]);
    const [product] = await manager.query(`INSERT INTO products(seller_id,name,price_cents,stock) VALUES($1,$2,1000,10) RETURNING id`, [sellerId, `HW19 ${mode} product`]);
    return { buyerId, productId: product.id as string };
  });
  connection = await connectBroker(url);
  const admin = await connection.createChannel(); admin.on('error', () => {});
  await declareTopology(admin, names); // This orchestration step acts as bootstrap, not publisher.
  for (const queue of [names.work, names.dlq]) {
    const state = await admin.checkQueue(queue);
    if (state.consumerCount) throw new Error('Demo queue already has an active consumer');
    await admin.purgeQueue(queue);
  }
  publisher = await ConfirmedPublisher.open(url, names.exchange);
  let published = 0;
  const observedPublisher = { async publish(event: Parameters<ConfirmedPublisher['publish']>[0]) { await publisher!.publish(event); published++; } };
  const effectCount = async () => Number((await dataSource.query('SELECT count(*)::int AS n FROM order_notifications WHERE user_id=$1', [fixtures.buyerId]))[0].n);
  const depth = async (queue: string, expected: number) => {
    const end = Date.now() + 5000;
    while (true) {
      const state = await admin.checkQueue(queue);
      if (state.messageCount === expected) return state.messageCount;
      if (Date.now() >= end) throw new Error(`Queue depth invariant failed: ${queue}=${state.messageCount}, expected ${expected}`);
      await delay(20);
    }
  };
  if (mode === 'publish') {
    // The real HW14 checkout commits money/stock/order/items/job, then publishes.
    // No consumer is online yet: all five events must remain in the durable work queue.
    for (let n = 0; n < 5; n++) await checkout(dataSource, fixtures.buyerId, fixtures.productId, 1, observedPublisher);
    await depth(names.work, 5);
    const worker = new DemoWorker(); await worker.ready(); await worker.until(() => worker.stats.acked === 5); await worker.stop();
    const effect = await effectCount(), dlq = await depth(names.dlq, 0);
    await depth(names.work, 0);
    assert.equal(published, 5); assert.equal(effect, 5); assert.equal(worker.stats.effect, effect);
    assert.equal(worker.stats.delivered, 5); assert.equal(worker.stats.acked, 5);
    assert.equal(Number((await dataSource.query('SELECT stock FROM products WHERE id=$1', [fixtures.productId]))[0].stock), 5);
    assert.equal((await dataSource.query('SELECT balance_cents FROM users WHERE id=$1', [fixtures.buyerId]))[0].balance_cents, '5000');
    for (const [key, value] of Object.entries({ published, delivered: worker.stats.delivered, effect, acked: worker.stats.acked, dlq, prefetch: PREFETCH, processing_ms: worker.stats.processing_ms })) console.log(`${key}=${value}`);
  } else if (mode === 'dlq') {
    await publisher.publishRaw({ eventId: randomUUID(), type: 'order.placed', version: 1, occurredAt: new Date().toISOString(),
      data: { orderId: 'invalid', buyerId: fixtures.buyerId, totalCents: '-1' } });
    const worker = new DemoWorker(); await worker.ready(); await worker.until(() => worker.stats.rejected === 1); await worker.stop();
    await depth(names.dlq, 1);
    const message = await admin.get(names.dlq, { noAck: false });
    if (!message) throw new Error('DLQ message disappeared');
    const headers = message.properties.headers ?? {};
    const reason = headers['x-death']?.[0]?.reason ?? headers['x-first-death-reason'];
    admin.nack(message, false, true); // Inspection must leave the DLQ message available for the grader.
    const work = await depth(names.work, 0), dlq = await depth(names.dlq, 1), effect = await effectCount();
    assert.equal(reason, 'rejected'); assert.equal(effect, 0); assert.equal(worker.stats.rejected, 1);
    for (const [key, value] of Object.entries({ rejected: worker.stats.rejected, work, dlq, 'dlq-reason': reason, effect })) console.log(`${key}=${value}`);
  } else {
    await checkout(dataSource, fixtures.buyerId, fixtures.productId, 1, observedPublisher);
    const first = new DemoWorker(true); await first.ready();
    await first.until(() => first.notices.some(notice => notice.kind === 'effect-before-ack'));
    assert.equal(await effectCount(), 1); assert.equal(first.stats.acked, 0);
    first.child.kill('SIGKILL'); await first.exited(); assert.equal(first.child.signalCode, 'SIGKILL');
    const second = new DemoWorker(); await second.ready(); await second.until(() => second.stats.acked === 1); await second.stop();
    const deliveries = first.stats.delivered + second.stats.delivered, effect = await effectCount(), skipped = second.stats.skipped;
    await depth(names.work, 0); await depth(names.dlq, 0);
    assert.ok(deliveries >= 2); assert.equal(effect, 1); assert.equal(skipped, 1); assert.equal(second.stats.redelivered, 1);
    for (const [key, value] of Object.entries({ deliveries, effect, skipped, redelivered: second.stats.redelivered, consumer_restarts: 1 })) console.log(`${key}=${value}`);
  }
  await admin.close();
} finally {
  for (const worker of workers) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
  }
  await publisher?.close(); await connection?.close().catch(() => {});
  await lock.rollbackTransaction(); await lock.release(); await dataSource.destroy();
}
