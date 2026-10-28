import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dataSource from '../data-source.js';
import { checkout } from '../checkout.js';
import { createFixture, cleanupFixture } from '../demo-fixture.js';
import { orderPlacedSchema } from '../async/order-placed.js';
import { applyOrderPlaced } from '../async/effect.js';
import { OutboxRelay } from '../outbox/relay.js';
import { connectRedis, requiredUrl } from './connection.js';
import { BullOrderPublisher, orderWorker } from './queue.js';
import { printMetrics, until } from './demo-utils.js';

const scope = `hw23-${randomUUID()}`;
const url = requiredUrl('REDIS_QUEUE_URL');
const redis = connectRedis(url);
const publisher = new BullOrderPublisher(url, scope, { backoff: { type: 'exponential', delay: 100, jitter: 0.5 } });
let worker: ReturnType<typeof orderWorker> | undefined;
let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
try {
  await redis.connect();
  const policy = await redis.config('GET', 'maxmemory-policy') as string[];
  assert.equal(policy[1], 'noeviction');
  await publisher.queue.waitUntilReady();
  await dataSource.initialize();
  fixture = await createFixture(dataSource, 10);
  const orderId = await checkout(dataSource, fixture.buyerId, fixture.productId, 1, { scope });
  const [outbox] = await dataSource.query('SELECT payload FROM outbox WHERE aggregate_id=$1 AND relay_scope=$2', [orderId, scope]);
  const event = orderPlacedSchema.parse(outbox.payload);
  const relay = new OutboxRelay(dataSource);
  let added = 0;
  const transport = { async publish(value: typeof event) { await publisher.publish(value); added++; } };
  // Simulate relay failure after a successful add, before published_at commits.
  await assert.rejects(relay.batch(transport, { scope, afterPublish() { throw new Error('demo relay crash'); } }), /demo relay crash/);
  assert.equal(await relay.batch(transport, { scope }), 1);
  const queued = await publisher.queue.getWaitingCount();
  assert.equal(added, 2); assert.equal(queued, 1);
  let attempts = 0, scheduledRuns = 0;
  worker = orderWorker(url, dataSource, publisher, async job => {
    if (job.name === 'order.placed') {
      attempts++;
      if (job.attemptsMade < 2) throw new Error('demo transient failure');
    }
  });
  worker.on('completed', job => { if (job.name === 'outbox-sweep') scheduledRuns++; });
  await worker.waitUntilReady();
  await until(async () => await (await publisher.queue.getJob(event.eventId))?.getState() === 'completed');
  const finished = await publisher.queue.getJob(event.eventId);
  assert.equal(finished?.attemptsMade, 3); assert.equal(attempts, 3);
  assert.equal((await dataSource.query('SELECT count(*)::int AS n FROM order_notifications WHERE event_id=$1', [event.eventId]))[0].n, 1);
  // Completed IDs remain retained; PostgreSQL inbox also rejects a replay independently.
  assert.equal(await publisher.queue.getCompletedCount(), 1);
  assert.equal(await applyOrderPlaced(dataSource, event), false);
  await publisher.schedule(500, scope);
  await publisher.schedule(500, scope);
  const schedulers = await publisher.queue.getJobSchedulersCount();
  assert.equal(schedulers, 1);
  await until(async () => scheduledRuns >= 2);
  await publisher.queue.removeJobScheduler('outbox-sweep-v1');
  printMetrics({ 'queue-noeviction': Number(policy[1] === 'noeviction'), attempts,
    completed: Number(await finished?.getState() === 'completed'), added, queued, schedulers, 'scheduled-runs': scheduledRuns });
} finally {
  await worker?.close();
  try { await publisher.queue.obliterate({ force: true }); } finally { await publisher.close(); redis.disconnect(); }
  if (dataSource.isInitialized) {
    await dataSource.query('DELETE FROM processed_messages WHERE message_id IN (SELECT id FROM outbox WHERE relay_scope=$1)', [scope]);
    await dataSource.query('DELETE FROM outbox WHERE relay_scope=$1', [scope]);
    if (fixture) await cleanupFixture(dataSource, fixture.buyerId);
    await dataSource.destroy();
  }
}
