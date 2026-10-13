import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database.service.js';
import type { OrderStatus } from '../entities/order.entity.js';
import { validId } from '../repositories/products.repository.js';
import { OrderEventsService } from './order-events.service.js';

@Injectable()
export class OrderStatusService {
  constructor(private readonly db: DatabaseService, private readonly events: OrderEventsService) {}

  async change(id: string, userId: string, status: OrderStatus) {
    if (!['pending', 'paid', 'shipped', 'cancelled'].includes(status)) throw new BadRequestException('Invalid order status');
    if (!validId(id)) throw new NotFoundException('Order not found');
    // Keep commit + publication ordered per order, including concurrent HTTP calls.
    return this.inOrder(id, async () => {
      const result = await this.db.transaction(async client => {
        const { rows: [order] } = await client.query('SELECT user_id,status FROM orders WHERE id=$1 FOR UPDATE', [id]);
        if (!order) throw new NotFoundException('Order not found');
        if (order.user_id !== userId) throw new ForbiddenException('Order belongs to another user');
        if (order.status !== status) await client.query('UPDATE orders SET status=$2 WHERE id=$1', [id, status]);
        return { order_id: id, previous_status: order.status as OrderStatus, status, changed: order.status !== status };
      });
      // DatabaseService.transaction has already completed COMMIT: no phantom rollback events.
      const event = result.changed ? this.events.publish({ order_id: id, previous_status: result.previous_status, status }) : null;
      return { ...result, event_id: event?.id ?? null };
    });
  }

  private readonly tails = new Map<string, Promise<void>>();
  private async inOrder<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(id, current);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.tails.get(id) === current) this.tails.delete(id); }
  }
}
