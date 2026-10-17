import { z } from 'zod';

const idPattern = /^[1-9]\d{0,18}$/;
const id = z.string().regex(idPattern).refine(value => idPattern.test(value) && BigInt(value) <= 9223372036854775807n);
export const orderPlacedSchema = z.object({
  eventId: z.uuid(),
  type: z.literal('order.placed'),
  version: z.literal(1),
  occurredAt: z.iso.datetime(),
  data: z.object({ orderId: id, buyerId: id, totalCents: z.string().regex(/^\d{1,14}$/) }).strict(),
}).strict();
export type OrderPlacedEvent = z.infer<typeof orderPlacedSchema>;
export interface PlacedPublisher { publish(event: OrderPlacedEvent): Promise<void> }
export interface PlacedOrderRow { id: string; user_id: string; total_cents: string; placed_event_id: string; created_at: Date }

export function orderPlaced(row: PlacedOrderRow): OrderPlacedEvent {
  return orderPlacedSchema.parse({ eventId: row.placed_event_id, type: 'order.placed', version: 1,
    occurredAt: row.created_at.toISOString(), data: { orderId: row.id, buyerId: row.user_id, totalCents: row.total_cents } });
}
