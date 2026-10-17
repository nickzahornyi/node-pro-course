import { Injectable, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database.service.js';
import { orderPlaced, type PlacedOrderRow } from './order-placed.js';
import { ConfirmedPublisher } from './publisher.js';

@Injectable()
export class OrderPublisherService implements OnModuleDestroy {
  private pending?: Promise<ConfirmedPublisher>;
  constructor(private readonly config: ConfigService, private readonly db: DatabaseService) {}

  async publishOrder(id: string): Promise<void> {
    const url = this.config.get<string>('BROKER_URL');
    if (!url) return; // Legacy/test HTTP mode; Compose enables the async channel explicitly.
    const { rows: [row] } = await this.db.query('SELECT id,user_id,total_cents,placed_event_id,created_at FROM orders WHERE id=$1', [id]);
    try {
      this.pending ??= ConfirmedPublisher.open(url);
      const publisher = await this.pending;
      await publisher.publish(orderPlaced(row as PlacedOrderRow));
    } catch {
      const failed = this.pending; this.pending = undefined;
      await failed?.then(publisher => publisher.close(), () => {}).catch(() => {});
      throw new ServiceUnavailableException('Order committed but broker publication is unconfirmed; retry with the same Idempotency-Key');
    }
  }

  async onModuleDestroy() { await this.pending?.then(publisher => publisher.close(), () => {}); }
}
