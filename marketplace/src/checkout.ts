import type { DataSource } from 'typeorm';

export class CheckoutError extends Error {
  constructor(public readonly code: 'OUT_OF_STOCK' | 'INSUFFICIENT_FUNDS') { super(code); }
}

// All statements use the same transaction-bound manager/connection.
export async function checkout(db: DataSource, buyerId: string, productId: string, quantity = 1): Promise<string> {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) {
    throw new RangeError('quantity must be a positive PostgreSQL integer');
  }
  return db.transaction(async (manager) => {
    const [product] = await manager.query(`UPDATE products SET stock = stock - $2
      WHERE id = $1 AND stock >= $2 RETURNING price_cents`, [productId, quantity]);
    // TypeORM UPDATE query returns [rows, affectedCount].
    if (product.length === 0) throw new CheckoutError('OUT_OF_STOCK');
    const price = product[0].price_cents as string;
    const total = (BigInt(price) * BigInt(quantity)).toString();
    const [buyers] = await manager.query(`UPDATE users SET balance_cents = balance_cents - $2
      WHERE id = $1 AND balance_cents >= $2 RETURNING id`, [buyerId, total]);
    if (buyers.length === 0) throw new CheckoutError('INSUFFICIENT_FUNDS');
    const [order] = await manager.query(`INSERT INTO orders(user_id, status, total_cents)
      VALUES ($1, 'paid', $2) RETURNING id`, [buyerId, total]);
    await manager.query(`INSERT INTO order_items(order_id, product_id, quantity, unit_price_cents)
      VALUES ($1, $2, $3, $4)`, [order.id, productId, quantity, price]);
    await manager.query('INSERT INTO jobs(order_id) VALUES ($1)', [order.id]);
    return order.id;
  });
}
