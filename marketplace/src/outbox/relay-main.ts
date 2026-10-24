import { writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import dataSource from '../data-source.js';
import { ConfirmedPublisher } from '../async/publisher.js';
import { OutboxRelay } from './relay.js';
import { BullOrderPublisher } from '../redis/queue.js';

const marker = '/tmp/outbox-relay-ready';
await unlink(marker).catch(() => {});
const url = process.env.BROKER_URL;
const queueUrl = process.env.REDIS_QUEUE_URL;
if (!url && !queueUrl) throw new Error('REDIS_QUEUE_URL or BROKER_URL is required');
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
let publisher: ConfirmedPublisher | BullOrderPublisher | undefined;
const relay = new OutboxRelay(dataSource);
try {
  await dataSource.initialize();
  while (!stopping) {
    try {
      publisher ??= queueUrl ? new BullOrderPublisher(queueUrl) : await ConfirmedPublisher.open(url!);
      await writeFile(marker, 'ready');
      const published = await relay.batch(publisher);
      if (published) console.log(`relay_published=${published}`);
      if (!published) await delay(250);
    } catch {
      await unlink(marker).catch(() => {});
      console.error('relay_retry=1'); // Never log broker credentials or payloads.
      await publisher?.close(); publisher = undefined;
      if (!stopping) await delay(1000);
    }
  }
} finally {
  await unlink(marker).catch(() => {});
  await publisher?.close();
  if (dataSource.isInitialized) await dataSource.destroy();
}
