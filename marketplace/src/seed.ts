import dataSource from './data-source.js';
import { User } from './entities/user.entity.js';
import { Product } from './entities/product.entity.js';
import { Order } from './entities/order.entity.js';
import { OrderItem } from './entities/order-item.entity.js';

await dataSource.initialize();
try {
  await dataSource.transaction(async (manager) => {
    // Serialize concurrent seed invocations without changing the business schema.
    await manager.query('SELECT pg_advisory_xact_lock(130013)');
    const users: User[] = [];
    const products: Product[] = [];
    for (let n = 1; n <= 10; n++) {
      const email = `seed${n}@example.test`;
      let user = await manager.getRepository(User).createQueryBuilder('user')
        .where('lower(user.email) = :email', { email }).getOne();
      if (!user) {
        user = await manager.save(User, manager.create(User, {
          email, displayName: `Seed user ${n}`, balanceCents: '1000000000', createdAt: new Date('2026-01-01T00:00:00Z'),
        }));
      }
      users.push(user);
    }
    for (let n = 0; n < 10; n++) {
      const sellerId = users[n].id;
      const name = `Seed product ${n + 1}`;
      let product = await manager.findOneBy(Product, { sellerId, name });
      if (!product) {
        product = await manager.save(Product, manager.create(Product, {
          sellerId, name, priceCents: String(1000 + n * 250), stock: 100,
          createdAt: new Date('2026-01-02T00:00:00Z'),
        }));
      }
      products.push(product);
    }
    for (let n = 0; n < 10; n++) {
      const userId = users[n].id;
      const createdAt = new Date(Date.UTC(2026, 2, n + 1, 12));
      const exists = await manager.findOneBy(Order, { userId, createdAt });
      if (exists) continue;
      const first = products[n];
      const second = products[(n + 1) % products.length];
      const totalCents = (BigInt(first.priceCents) + 2n * BigInt(second.priceCents)).toString();
      const order = await manager.save(Order, manager.create(Order, {
        userId, createdAt, status: n % 5 === 0 ? 'pending' : 'paid', totalCents,
      }));
      await manager.save(OrderItem, [
        manager.create(OrderItem, { orderId: order.id, productId: first.id, quantity: 1, unitPriceCents: first.priceCents }),
        manager.create(OrderItem, { orderId: order.id, productId: second.id, quantity: 2, unitPriceCents: second.priceCents }),
      ]);
    }
  });
  console.log('Seed counts:', {
    users: await dataSource.getRepository(User).count(),
    products: await dataSource.getRepository(Product).count(),
    orders: await dataSource.getRepository(Order).count(),
    order_items: await dataSource.getRepository(OrderItem).count(),
  });
} finally {
  await dataSource.destroy();
}
