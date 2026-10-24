import { orderPlaced, type PlacedOrderRow, type OrderPlacedEvent } from '../async/order-placed.js';

type TransactionQuery = (sql: string, args: unknown[]) => Promise<unknown>;

export interface WriteOptions {
  scope?: string;
  // In-process fault injection for tests/demos only; never accepted from HTTP input.
  afterOutbox?: (query: TransactionQuery, event: OrderPlacedEvent) => void | Promise<void>;
}
export async function enqueueOrder(query: TransactionQuery, order: PlacedOrderRow, options: WriteOptions = {}) {
  const event = orderPlaced(order);
  await query(`INSERT INTO outbox(id,aggregate_type,aggregate_id,type,payload,relay_scope)
    VALUES($1,'order',$2,$3,$4::jsonb,$5)`,
  [event.eventId, event.data.orderId, event.type, JSON.stringify(event), options.scope ?? 'shop']);
  await options.afterOutbox?.(query, event);
}
