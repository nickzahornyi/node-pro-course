import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service.js';

export interface Queryable { query(sql: string, parameters?: unknown[]): Promise<{ rows: any[] }> }
export const validId = (id: string) => /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;

@Injectable()
export class ProductsRepository {
  constructor(@Inject(DatabaseService) private readonly db: Queryable) {}
  async create(input: { sellerId: string; name: string; priceCents: string; stock: number }) {
    const { rows: [product] } = await this.db.query(`INSERT INTO products(seller_id,name,price_cents,stock)
      VALUES($1,$2,$3,$4) RETURNING *`, [input.sellerId, input.name, input.priceCents, input.stock]);
    return product;
  }
  async find(id: string) {
    if (!validId(id)) return null;
    return (await this.db.query('SELECT * FROM products WHERE id=$1', [id])).rows[0] ?? null;
  }
  async list(after: string, limit: number) {
    return (await this.db.query('SELECT * FROM products WHERE id > $1 ORDER BY id LIMIT $2', [after, limit])).rows;
  }
  async bySeller(sellerId: string) {
    return (await this.db.query(`SELECT p.*, u.display_name AS seller_name FROM products p
      JOIN users u ON u.id=p.seller_id WHERE p.seller_id=$1 ORDER BY p.id`, [sellerId])).rows;
  }
}
