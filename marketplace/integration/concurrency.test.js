import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import db from '../dist/data-source.js';
import { checkout } from '../dist/checkout.js';
import { createFixture, cleanupFixture } from '../dist/demo-fixture.js';
import { runWorker } from '../dist/worker.js';

before(() => db.initialize());
after(() => db.destroy());

for (const scenario of ['funds', 'stock', 'order constraint']) {
  test(`checkout rolls back entirely: ${scenario}`, async () => {
    const balance = scenario === 'funds' ? '0' : '999999999999999';
    const fixture = await createFixture(db, 200, balance);
    try {
      if (scenario === 'order constraint') await db.query('UPDATE products SET price_cents=999999999999 WHERE id=$1', [fixture.productId]);
      const quantity = scenario === 'stock' ? 201 : scenario === 'order constraint' ? 200 : 1;
      await assert.rejects(checkout(db, fixture.buyerId, fixture.productId, quantity), (error) =>
        error.code === (scenario === 'funds' ? 'INSUFFICIENT_FUNDS' : scenario === 'stock' ? 'OUT_OF_STOCK' : '23514'));
      const [row] = await db.query(`SELECT balance_cents, (SELECT stock FROM products WHERE id=$2) AS stock,
        (SELECT count(*)::int FROM orders WHERE user_id=$1) AS orders,
        (SELECT count(*)::int FROM jobs j JOIN orders o ON o.id=j.order_id WHERE o.user_id=$1) AS jobs
        FROM users WHERE id=$1`, [fixture.buyerId, fixture.productId]);
      assert.deepEqual(row, { balance_cents: balance, stock: 200, orders: 0, jobs: 0 });
    } finally { await cleanupFixture(db, fixture.buyerId); }
  });
}

test('queue insert failure rolls back stock, debit, order and items', async () => {
  const fixture = await createFixture(db, 1, '1000');
  try {
    const failingDb = { transaction: operation => db.transaction(manager => operation({
      query: (sql, parameters) => {
        if (sql.startsWith('INSERT INTO jobs')) throw new Error('simulated queue insert failure');
        return manager.query(sql, parameters);
      },
    })) };
    await assert.rejects(checkout(failingDb, fixture.buyerId, fixture.productId), /queue insert failure/);
    const [row] = await db.query(`SELECT balance_cents,
      (SELECT stock FROM products WHERE id=$2) AS stock,
      (SELECT count(*)::int FROM orders WHERE user_id=$1) AS orders,
      (SELECT count(*)::int FROM order_items WHERE product_id=$2) AS items
      FROM users WHERE id=$1`, [fixture.buyerId, fixture.productId]);
    assert.deepEqual(row, { balance_cents: '1000', stock: 1, orders: 0, items: 0 });
  } finally { await cleanupFixture(db, fixture.buyerId); }
});

test('concurrent purchases of different products cannot overspend shared balance', async () => {
  const fixture = await createFixture(db, 20, '1000');
  try {
    const [other] = await db.query(`INSERT INTO products(seller_id,name,price_cents,stock)
      VALUES($1,'Second concurrent product',100,20) RETURNING id`, [fixture.buyerId]);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      checkout(db, fixture.buyerId, i % 2 ? other.id : fixture.productId)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 10);
    for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'INSUFFICIENT_FUNDS');
    const [row] = await db.query(`SELECT balance_cents,
      (SELECT sum(stock)::int FROM products WHERE seller_id=$1) AS stock FROM users WHERE id=$1`, [fixture.buyerId]);
    assert.deepEqual(row, { balance_cents: '0', stock: 30 });
  } finally { await cleanupFixture(db, fixture.buyerId); }
});

test('locked pending task is retried after failing worker rolls back', { timeout: 10000 }, async () => {
  const fixture = await createFixture(db, 1);
  try {
    const orderId = await checkout(db, fixture.buyerId, fixture.productId);
    let claimed;
    const locked = new Promise(resolve => { claimed = resolve; });
    const failed = assert.rejects(runWorker(db, 'failing', [orderId], async () => {
      claimed();
      await delay(150);
      throw new Error('simulated crash before commit');
    }), /simulated crash/);
    await locked;
    const survivor = runWorker(db, 'survivor', [orderId]);
    await failed;
    assert.equal(await survivor, 1);
    const [row] = await db.query('SELECT status,processed,worker_id,result FROM jobs WHERE order_id=$1', [orderId]);
    assert.deepEqual(row, { status: 'done', processed: 1, worker_id: 'survivor', result: `Receipt for order ${orderId}` });
  } finally { await cleanupFixture(db, fixture.buyerId); }
});
