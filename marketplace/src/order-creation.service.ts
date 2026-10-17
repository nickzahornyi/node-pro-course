import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { OrdersRepository, type ItemInput } from './repositories/orders.repository.js';
import { OrderPublisherService } from './async/order-publisher.service.js';

@Injectable()
export class OrderCreationService {
  constructor(private readonly db: DatabaseService, private readonly publisher: OrderPublisherService) {}

  async create(key: string, body: { items: ItemInput[] }) {
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
      return { order, replay: false };
    });
    // Replay publishes the same persisted eventId too, recovering an uncertain prior confirm.
    if (result.order) await this.publisher.publishOrder(result.order.id);
    return result;
  }
}
