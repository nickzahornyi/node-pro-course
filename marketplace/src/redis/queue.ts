import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import type { DataSource } from 'typeorm';
import { redisOptions } from './connection.js';
import { orderPlacedSchema, type OrderPlacedEvent, type PlacedPublisher } from '../async/order-placed.js';
import { applyOrderPlaced } from '../async/effect.js';
import { OutboxRelay } from '../outbox/relay.js';

export const QUEUE_NAME = 'shop-order-work';
export const JOB_OPTIONS: JobsOptions = {
  attempts: 5, backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
  // Keep completed IDs for a day. PostgreSQL inbox protects effects beyond this window.
  removeOnComplete: { age: 86400 }, removeOnFail: { age: 604800 },
};

export class BullOrderPublisher implements PlacedPublisher {
  readonly queue: Queue;
  constructor(url: string, name = QUEUE_NAME, options: JobsOptions = {}) {
    this.queue = new Queue(name, { connection: redisOptions(url), defaultJobOptions: { ...JOB_OPTIONS, ...options } });
    this.queue.on('error', () => console.error('queue_connection_error=1'));
  }
  async publish(event: OrderPlacedEvent): Promise<void> {
    const parsed = orderPlacedSchema.parse(event);
    await this.queue.add('order.placed', parsed, { jobId: parsed.eventId });
  }
  async schedule(every = 60000, scope = 'shop') {
    return this.queue.upsertJobScheduler('outbox-sweep-v1', { every },
      { name: 'outbox-sweep', data: { scope }, opts: JOB_OPTIONS });
  }
  close() { return this.queue.close(); }
}

export function orderWorker(url: string, db: DataSource, publisher: BullOrderPublisher,
  beforeProcess?: (job: Job) => Promise<void>): Worker {
  const relay = new OutboxRelay(db);
  const worker = new Worker(publisher.queue.name, async job => {
    await beforeProcess?.(job);
    if (job.name === 'outbox-sweep') {
      return relay.batch(publisher, { scope: String(job.data.scope) });
    }
    if (job.name !== 'order.placed') throw new Error('Unknown order job');
    return { applied: await applyOrderPlaced(db, orderPlacedSchema.parse(job.data)) };
  }, { connection: redisOptions(url, true), concurrency: 5 });
  worker.on('error', () => console.error('worker_connection_error=1'));
  return worker;
}
