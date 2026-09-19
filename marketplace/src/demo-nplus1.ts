import assert from 'node:assert/strict';
import dataSource from './data-source.js';
import { Order } from './entities/order.entity.js';
import { OrderItem } from './entities/order-item.entity.js';
import { Product } from './entities/product.entity.js';
import { QueryCountLogger } from './query-count-logger.js';

const logger = new QueryCountLogger();
dataSource.setOptions({ logging: ['query'], logger });
await dataSource.initialize();
try {
  const ordersRepo = dataSource.getRepository(Order);
  assert.ok(await ordersRepo.count() >= 10, 'Run npm run seed first (at least 10 orders required)');
  for (const size of [5, 10]) {
    // Exclude connection setup/seed checks; count all SELECTs for each strategy.
    logger.reset();
    const naive = await ordersRepo.find({ order: { id: 'ASC' }, take: size });
    for (const order of naive) {
      order.items = await dataSource.getRepository(OrderItem).findBy({ orderId: order.id });
      for (const item of order.items) {
        item.product = await dataSource.getRepository(Product).findOneByOrFail({ id: item.productId });
      }
    }
    const before = logger.count;

    logger.reset();
    // Limit the root collection in a subquery, not the joined rows (which would truncate items).
    const ids = ordersRepo.createQueryBuilder('page').select('page.id')
      .orderBy('page.id', 'ASC').limit(size);
    const fixed = await ordersRepo.createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'item')
      .leftJoinAndSelect('item.product', 'product')
      .where(`order.id IN (${ids.getQuery()})`)
      .setParameters(ids.getParameters())
      .orderBy('order.id', 'ASC').addOrderBy('item.id', 'ASC')
      .getMany();
    const after = logger.count;

    const snapshot = (orders: Order[]) => orders.map((order) => ({
      id: order.id, totalCents: order.totalCents,
      items: [...order.items].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
        .map((item) => ({ id: item.id, quantity: item.quantity, unitPriceCents: item.unitPriceCents, product: item.product })),
    }));
    assert.deepEqual(snapshot(fixed), snapshot(naive), 'Both strategies must load the same complete graph');
    assert.equal(fixed.length, size);
    assert.ok(before >= size);
    assert.equal(after, 1, 'The joined strategy must execute one SQL query regardless of N');
    console.log(`N=${size}: before=${before}, after=${after} (order -> items -> product)`);
  }
} finally {
  await dataSource.destroy();
}
