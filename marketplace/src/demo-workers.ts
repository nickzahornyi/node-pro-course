import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import db from './data-source.js';
import { checkout } from './checkout.js';
import { runWorker } from './worker.js';
import { createFixture, cleanupFixture } from './demo-fixture.js';

await db.initialize();
let buyerId: string | undefined;
try {
  assert.ok((db.options.poolSize ?? 10) >= 2, 'Workers require DB_POOL_MAX >= 2');
  const fixture = await createFixture(db, 12);
  buyerId = fixture.buyerId;
  const orderIds: string[] = [];
  for (let n = 0; n < 12; n++) orderIds.push(await checkout(db, buyerId, fixture.productId));
  const duration = 100;
  const started = performance.now();
  const results = await Promise.allSettled(['worker-1', 'worker-2', 'worker-3'].map((id) =>
    runWorker(db, id, orderIds, async (orderId) => { await delay(duration); return `Receipt for order ${orderId}`; })));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const elapsed = performance.now() - started;
  const distribution = await db.query('SELECT worker_id, count(*)::int AS tasks FROM jobs WHERE order_id=ANY($1) GROUP BY worker_id ORDER BY worker_id', [orderIds]);
  const [{ twice, done }] = await db.query(`SELECT count(*) FILTER (WHERE processed > 1)::int AS twice,
    count(*) FILTER (WHERE processed = 1 AND status = 'done' AND result IS NOT NULL)::int AS done FROM jobs WHERE order_id=ANY($1)`, [orderIds]);
  console.table(distribution);
  console.log(`Оброблено двічі: ${twice}; оброблено: ${done}; час: ${elapsed.toFixed(1)} ms; послідовно: ${12 * duration} ms`);
  assert.equal(twice, 0); assert.equal(done, 12); assert.ok(distribution.length >= 2);
  assert.ok(elapsed < 12 * duration, 'Worker pool must beat sequential processing');
} finally {
  try { if (buyerId) await cleanupFixture(db, buyerId); } finally { await db.destroy(); }
}
