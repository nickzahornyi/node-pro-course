import { BadRequestException, GoneException, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Subject, filter } from 'rxjs';
import type { OrderStatus } from '../entities/order.entity.js';

export interface OrderStatusEvent {
  id: number;
  order_id: string;
  previous_status: OrderStatus;
  status: OrderStatus;
  occurred_at: string;
}

@Injectable()
export class OrderEventsService implements OnModuleDestroy {
  private sequence = 0;
  private readonly buffer: OrderStatusEvent[] = [];
  private readonly changes = new Subject<OrderStatusEvent>();
  readonly capacity = 500;

  publish(change: Omit<OrderStatusEvent, 'id' | 'occurred_at'>): OrderStatusEvent {
    const event = Object.freeze({ ...change, id: ++this.sequence, occurred_at: new Date().toISOString() });
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.changes.next(event);
    return event;
  }

  observe(orderId: string) { return this.changes.pipe(filter(event => event.order_id === orderId)); }
  observeAll() { return this.changes.asObservable(); }

  replay(orderId: string, lastId: number): OrderStatusEvent[] {
    if (!Number.isSafeInteger(lastId) || lastId < 0 || lastId > this.sequence) throw new BadRequestException('Invalid Last-Event-ID (or server history restarted)');
    if (this.buffer.length === this.capacity && lastId < this.buffer[0].id - 1) throw new GoneException('Last-Event-ID is outside the replay window; reload order state');
    return this.buffer.filter(event => event.order_id === orderId && event.id > lastId);
  }

  onModuleDestroy() { this.changes.complete(); }
}
