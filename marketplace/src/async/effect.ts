import type { DataSource } from 'typeorm';
import type { OrderPlacedEvent } from './order-placed.js';

export class InvalidEventError extends Error {}

export async function applyOrderPlaced(db: DataSource, event: OrderPlacedEvent): Promise<boolean> {
  const [order] = await db.query('SELECT user_id,total_cents,placed_event_id FROM orders WHERE id=$1', [event.data.orderId]);
  if (!order || order.user_id !== event.data.buyerId || order.total_cents !== event.data.totalCents || order.placed_event_id !== event.eventId) {
    throw new InvalidEventError('Event does not match the committed order');
  }
  // The durable notification IS the effect. Its natural key performs dedup atomically.
  const rows = await db.query(`INSERT INTO order_notifications(event_id,order_id,user_id,total_cents,occurred_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
  [event.eventId, event.data.orderId, event.data.buyerId, event.data.totalCents, event.occurredAt]);
  return rows.length === 1;
}
