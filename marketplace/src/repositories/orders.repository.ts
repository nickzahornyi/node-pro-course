import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { DatabaseService } from '../database.service.js';
import { type Queryable, validId } from './products.repository.js';

export interface ItemInput { product_id: string; quantity: number }
@Injectable()
export class OrdersRepository {
  constructor(@Inject(DatabaseService) private readonly db: Queryable) {}
  // Caller owns the transaction; accepts a Pool or a transaction-bound Client.
  async create(userId: string, items: ItemInput[]) {
    if (!items.length || items.some(i => !validId(i.product_id) || !Number.isSafeInteger(i.quantity) || i.quantity < 1 || i.quantity > 2147483647)
      || new Set(items.map(i => i.product_id)).size !== items.length) throw new UnprocessableEntityException('Invalid or duplicate product_id/quantity');
    const { rows: products } = await this.db.query('SELECT id,price_cents FROM products WHERE id=ANY($1::bigint[])', [items.map(i => i.product_id)]);
    if (products.length !== items.length) throw new UnprocessableEntityException('Unknown product_id');
    const prices = new Map(products.map(p => [p.id, p.price_cents]));
    const total = items.reduce((sum, item) => sum + BigInt(prices.get(item.product_id)!) * BigInt(item.quantity), 0n);
    if (total > 99999999999999n) throw new UnprocessableEntityException('Order total exceeds allowed maximum');
    const { rows: [order] } = await this.db.query(`INSERT INTO orders(user_id,status,total_cents) VALUES($1,'pending',$2) RETURNING id`, [userId, total.toString()]);
    for (const item of items) await this.db.query(`INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents)
      VALUES($1,$2,$3,$4)`, [order.id, item.product_id, item.quantity, prices.get(item.product_id)]);
    return this.find(order.id);
  }
  async find(id: string) {
    if (!validId(id)) return null;
    const { rows } = await this.db.query(`SELECT o.id,o.status,o.total_cents,i.product_id,i.quantity,i.unit_price_cents
      FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.id=$1 ORDER BY i.id`, [id]);
    if (!rows.length) return null;
    return { id: rows[0].id as string, status: rows[0].status === 'pending' ? 'created' : rows[0].status, total_cents: Number(rows[0].total_cents),
      items: rows.map(row => ({ product_id: row.product_id as string, quantity: row.quantity as number, unit_price_cents: Number(row.unit_price_cents) })) };
  }
  async list(after: string, limit: number) {
    const { rows } = await this.db.query(`SELECT o.id,o.status,o.total_cents,
      json_agg(json_build_object('product_id',i.product_id::text,'quantity',i.quantity,
        'unit_price_cents',i.unit_price_cents) ORDER BY i.id) AS items
      FROM (SELECT id,status,total_cents FROM orders WHERE id > $1 ORDER BY id LIMIT $2) o
      JOIN order_items i ON i.order_id=o.id GROUP BY o.id,o.status,o.total_cents ORDER BY o.id`, [after, limit]);
    return rows.map(row => ({ id: row.id as string, status: row.status === 'pending' ? 'created' : row.status,
      total_cents: Number(row.total_cents), items: row.items }));
  }
  async totalForUser(userId: string): Promise<string> {
    return (await this.db.query('SELECT coalesce(sum(total_cents),0)::text AS total FROM orders WHERE user_id=$1', [userId])).rows[0].total;
  }
}
