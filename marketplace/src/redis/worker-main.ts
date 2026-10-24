import { writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import dataSource from '../data-source.js';
import { requiredUrl } from './connection.js';
import { BullOrderPublisher, orderWorker } from './queue.js';

const marker = '/tmp/redis-worker-ready';
await unlink(marker).catch(() => {});
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const publisher = new BullOrderPublisher(requiredUrl('REDIS_QUEUE_URL'));
let worker: ReturnType<typeof orderWorker> | undefined;
try {
  await dataSource.initialize();
  await publisher.queue.waitUntilReady();
  worker = orderWorker(requiredUrl('REDIS_QUEUE_URL'), dataSource, publisher);
  await worker.waitUntilReady();
  await publisher.schedule();
  worker.on('error', () => { void unlink(marker).catch(() => {}); });
  worker.on('ioredis:close', () => { void unlink(marker).catch(() => {}); });
  worker.on('ready', () => { void writeFile(marker, 'ready').catch(() => {}); });
  await writeFile(marker, 'ready');
  while (!stopping) await delay(250);
} finally {
  await unlink(marker).catch(() => {});
  await worker?.close();
  await publisher.close();
  if (dataSource.isInitialized) await dataSource.destroy();
}
