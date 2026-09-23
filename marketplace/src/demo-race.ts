import assert from 'node:assert/strict';
import db from './data-source.js';
import { checkout, CheckoutError } from './checkout.js';
import { createFixture, cleanupFixture } from './demo-fixture.js';

await db.initialize();
let buyerId: string | undefined;
try {
  const fixture = await createFixture(db, 10);
  buyerId = fixture.buyerId;
  const attempts = 50;
  const results = await Promise.allSettled(Array.from({ length: attempts }, () => checkout(db, fixture.buyerId, fixture.productId)));
  const successes = results.filter((r) => r.status === 'fulfilled').length;
  for (const result of results) if (result.status === 'rejected') {
    assert.ok(result.reason instanceof CheckoutError && result.reason.code === 'OUT_OF_STOCK');
  }
  const [{ stock }] = await db.query('SELECT stock FROM products WHERE id=$1', [fixture.productId]);
  const [{ negative }] = await db.query('SELECT count(*)::int AS negative FROM products WHERE stock < 0');
  const [{ orders, jobs, items, balance }] = await db.query(`SELECT
    (SELECT count(*)::int FROM orders WHERE user_id=$1) AS orders,
    (SELECT count(*)::int FROM jobs j JOIN orders o ON o.id=j.order_id WHERE o.user_id=$1) AS jobs,
    (SELECT count(*)::int FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.user_id=$1) AS items,
    balance_cents AS balance FROM users WHERE id=$1`, [buyerId]);
  console.log(`Спроб: ${attempts}; успішних: ${successes}; фінальний stock: ${stock}; від'ємний stock: ${negative}`);
  assert.equal(successes, 10); assert.equal(stock, 0); assert.equal(negative, 0);
  assert.equal(orders, 10); assert.equal(jobs, 10); assert.equal(items, 10);
  assert.equal(balance, '999999000');
} finally {
  try { if (buyerId) await cleanupFixture(db, buyerId); } finally { await db.destroy(); }
}
