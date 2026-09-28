import type { DataSource } from 'typeorm';
import { Product } from './entities/product.entity.js';
import { User } from './entities/user.entity.js';
import { Order } from './entities/order.entity.js';

export class CheckoutError extends Error {
  constructor(public readonly code: 'OUT_OF_STOCK' | 'INSUFFICIENT_FUNDS') { super(code); }
}

// All statements use the same transaction-bound manager/connection.
export async function checkout(db: DataSource, buyerId: string, productId: string, quantity = 1): Promise<string> {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) {
    throw new RangeError('quantity must be a positive PostgreSQL integer');
  }
  return db.transaction(async (manager) => {
    const product = await manager.createQueryBuilder().update(Product)
      .set({ stock: () => 'stock - :quantity' })
      .where('id = :productId AND stock >= :quantity', { productId, quantity })
      .returning(['priceCents']).execute();
    // QueryBuilder exposes returned rows through the same result.raw API for UPDATE/INSERT.
    if (product.raw.length === 0) throw new CheckoutError('OUT_OF_STOCK');
    const price = product.raw[0].price_cents as string;
    const total = (BigInt(price) * BigInt(quantity)).toString();
    const buyers = await manager.createQueryBuilder().update(User)
      .set({ balanceCents: () => 'balance_cents - :total' })
      .where('id = :buyerId AND balance_cents >= :total', { buyerId, total })
      .returning(['id']).execute();
    if (buyers.raw.length === 0) throw new CheckoutError('INSUFFICIENT_FUNDS');
    const inserted = await manager.createQueryBuilder().insert().into(Order)
      .values({ userId: buyerId, status: 'paid', totalCents: total })
      .returning(['id']).execute();
    const order = inserted.raw[0] as { id: string };
    await manager.query(`INSERT INTO order_items(order_id, product_id, quantity, unit_price_cents)
      VALUES ($1, $2, $3, $4)`, [order.id, productId, quantity, price]);
    await manager.query('INSERT INTO jobs(order_id) VALUES ($1)', [order.id]);
    return order.id;
  });
}
