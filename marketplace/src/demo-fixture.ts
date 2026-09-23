import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

export async function createFixture(db: DataSource, stock: number, balance = '1000000000') {
  return db.transaction(async (manager) => {
    const [user] = await manager.query(`INSERT INTO users(email,display_name,balance_cents)
      VALUES ($1,'HW14 demo',$2) RETURNING id`, [`hw14-${randomUUID()}@example.test`, balance]);
    const [product] = await manager.query(`INSERT INTO products(seller_id,name,price_cents,stock)
      VALUES ($1,'HW14 isolated product',100,$2) RETURNING id`, [user.id, stock]);
    return { buyerId: user.id as string, productId: product.id as string };
  });
}

export async function cleanupFixture(db: DataSource, buyerId: string): Promise<void> {
  await db.transaction(async (manager) => {
    // Only this invocation's UUID-owned data; never truncate shared tables.
    await manager.query('DELETE FROM orders WHERE user_id=$1', [buyerId]);
    await manager.query('DELETE FROM products WHERE seller_id=$1', [buyerId]);
    await manager.query('DELETE FROM users WHERE id=$1', [buyerId]);
  });
}
