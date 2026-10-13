import type { Channel } from 'amqplib';

export const PREFETCH = 10;
export type DemoMode = 'publish' | 'dlq' | 'duplicate';
export function topology(mode?: DemoMode) {
  if (mode && !['publish', 'dlq', 'duplicate'].includes(mode)) throw new Error('Unknown demo scope');
  const prefix = mode ? `shop.demo.hw19.${mode}` : 'shop';
  return { exchange: `${prefix}.events`, work: `${prefix}.orders.placed`, dlx: `${prefix}.events.dlx`, dlq: `${prefix}.orders.placed.dlq` };
}
export type Topology = ReturnType<typeof topology>;

// Called ONLY by bootstrap/consumers. Publishers do not declare queues or bindings.
export async function declareTopology(channel: Channel, names: Topology): Promise<void> {
  await channel.assertExchange(names.exchange, 'topic', { durable: true });
  await channel.assertExchange(names.dlx, 'direct', { durable: true });
  await channel.assertQueue(names.dlq, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await channel.bindQueue(names.dlq, names.dlx, 'order.placed.failed');
  await channel.assertQueue(names.work, { durable: true, arguments: {
    'x-queue-type': 'quorum', 'x-delivery-limit': 20,
    'x-dead-letter-exchange': names.dlx, 'x-dead-letter-routing-key': 'order.placed.failed',
  } });
  await channel.bindQueue(names.work, names.exchange, 'order.placed');
}
