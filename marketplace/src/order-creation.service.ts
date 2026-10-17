import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { OrdersRepository, type ItemInput } from './repositories/orders.repository.js';
import { enqueueOrder, type WriteOptions } from './outbox/write.js';

@Injectable()
export class OrderCreationService {
  constructor(private readonly db: DatabaseService) {}

  async create(key: string, body: { items: ItemInput[] }, options: WriteOptions = {}) {
    const result = await this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const fingerprint = JSON.stringify(body);
      const { rows: [previous] } = await client.query('SELECT * FROM order_requests WHERE key=$1', [key]);
      const repository = new OrdersRepository(client);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new UnprocessableEntityException('Idempotency-Key already used with a different body');
        const order = await repository.find(previous.order_id);
        return { order: order ? { ...order, status: 'created' } : null, replay: true };
      }
      const { rows: [guest] } = await client.query(`INSERT INTO users(email,display_name)
        VALUES('public-drafts@marketplace.invalid','Public draft orders')
        ON CONFLICT (lower(email)) DO UPDATE SET display_name=users.display_name RETURNING id`);
      const order = await repository.create(guest.id, body.items);
      await client.query('INSERT INTO order_requests(key,fingerprint,order_id) VALUES($1,$2,$3)', [key, fingerprint, order!.id]);
      const { rows: [row] } = await client.query('SELECT id,user_id,total_cents,placed_event_id,created_at FROM orders WHERE id=$1', [order!.id]);
      await enqueueOrder((sql, args) => client.query(sql, args), row, options);
      return { order, replay: false };
    });
    return result;
  }
}
