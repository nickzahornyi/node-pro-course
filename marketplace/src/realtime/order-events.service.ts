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

interface OrderHistory {
  events: Array<OrderStatusEvent | undefined>;
  start: number;
  size: number;
  evictedThrough: number;
}

@Injectable()
export class OrderEventsService implements OnModuleDestroy {
  private sequence = 0;
  private readonly histories = new Map<string, OrderHistory>();
  private readonly changes = new Subject<OrderStatusEvent>();
  readonly capacity = 500;

  publish(change: Omit<OrderStatusEvent, 'id' | 'occurred_at'>): OrderStatusEvent {
    const event = Object.freeze({ ...change, id: ++this.sequence, occurred_at: new Date().toISOString() });
    let history = this.histories.get(event.order_id);
    if (!history) {
      history = { events: new Array(this.capacity), start: 0, size: 0, evictedThrough: 0 };
      this.histories.set(event.order_id, history);
    }
    if (history.size === this.capacity) {
      history.evictedThrough = history.events[history.start]!.id;
      history.events[history.start] = event;
      history.start = (history.start + 1) % this.capacity;
    } else {
      history.events[(history.start + history.size) % this.capacity] = event;
      history.size++;
    }
    this.changes.next(event);
    return event;
  }

  observe(orderId: string) { return this.changes.pipe(filter(event => event.order_id === orderId)); }
  observeAll() { return this.changes.asObservable(); }

  replay(orderId: string, lastId: number): OrderStatusEvent[] {
    if (!Number.isSafeInteger(lastId) || lastId < 0) throw new BadRequestException('Invalid Last-Event-ID');
    // A browser can reconnect with an ID from before a process restart.
    // Keep HTTP 200 and deliver the next live event, even if its ID is lower.
    if (lastId > this.sequence) return [];
    const history = this.histories.get(orderId);
    if (!history) return [];
    if (lastId < history.evictedThrough) throw new GoneException('Last-Event-ID is outside the replay window; reload order state');
    const replay: OrderStatusEvent[] = [];
    for (let n = 0; n < history.size; n++) {
      const event = history.events[(history.start + n) % this.capacity]!;
      if (event.id > lastId) replay.push(event);
    }
    return replay;
  }

  onModuleDestroy() { this.changes.complete(); this.histories.clear(); }
}
