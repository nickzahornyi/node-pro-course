import type { DataSource } from 'typeorm';
import type { OrderPlacedEvent } from './order-placed.js';

export class InvalidEventError extends Error {}
export const NOTIFICATION_CONSUMER = 'order-notifications.v1';

export async function applyOrderPlaced(db: DataSource, event: OrderPlacedEvent, afterInbox?: () => void): Promise<boolean> {
  return db.transaction(async manager => {
    const [order] = await manager.query('SELECT user_id,total_cents,placed_event_id FROM orders WHERE id=$1', [event.data.orderId]);
    if (!order || order.user_id !== event.data.buyerId || order.total_cents !== event.data.totalCents || order.placed_event_id !== event.eventId) {
      throw new InvalidEventError('Event does not match the committed order');
    }
    const inbox = await manager.query(`INSERT INTO processed_messages(message_id,consumer)
      VALUES($1,$2) ON CONFLICT(message_id,consumer) DO NOTHING RETURNING message_id`, [event.eventId, NOTIFICATION_CONSUMER]);
    if (!inbox.length) return false;
    afterInbox?.();
    // Natural business key and inbox are independent safeguards in the SAME COMMIT.
    const rows = await manager.query(`INSERT INTO order_notifications(event_id,order_id,user_id,total_cents,occurred_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id) DO NOTHING RETURNING event_id`,
    [event.eventId, event.data.orderId, event.data.buyerId, event.data.totalCents, event.occurredAt]);
    return rows.length === 1;
  });
}
