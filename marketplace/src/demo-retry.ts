import assert from 'node:assert/strict';
import db from './data-source.js';
import { retryTransaction } from './retry.js';
import { createFixture, cleanupFixture } from './demo-fixture.js';

await db.initialize();
let buyerId: string | undefined;
try {
  assert.ok((db.options.poolSize ?? 10) >= 2, 'Retry demo requires DB_POOL_MAX >= 2');
  const fixture = await createFixture(db, 0, '1000');
  buyerId = fixture.buyerId;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => rejectTimeout(new Error('Concurrent readers did not reach barrier in 10 seconds')), 10000);
  timer.unref();
  let readers = 0;
  let retries = 0;
  const results = await Promise.allSettled([100n, 200n].map((increment) => retryTransaction(db, async (manager, attempt) => {
    const [row] = await manager.query('SELECT balance_cents FROM users WHERE id=$1', [buyerId]);
    // Both first attempts read the same snapshot before either writes.
    if (attempt === 1) { if (++readers === 2) release(); await Promise.race([barrier, timeout]); }
    await manager.query('UPDATE users SET balance_cents=$2 WHERE id=$1', [buyerId, (BigInt(row.balance_cents) + increment).toString()]);
  }, (code, attempt) => { retries++; console.log(`retry ${attempt}: caught ${code}; repeating entire transaction`); })));
  clearTimeout(timer);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const [row] = await db.query('SELECT balance_cents FROM users WHERE id=$1', [buyerId]);
  console.log(`Фінальний баланс: ${row.balance_cents} = 1000 + 100 + 200; retry: ${retries}`);
  assert.equal(row.balance_cents, '1300'); assert.ok(retries >= 1);
} finally {
  try { if (buyerId) await cleanupFixture(db, buyerId); } finally { await db.destroy(); }
}
