import { writeFile, unlink } from 'node:fs/promises';
import dataSource from '../data-source.js';
import { OrderConsumer } from './consumer.js';
import { topology, type DemoMode } from './topology.js';

const demo = process.argv.find(argument => argument.startsWith('--demo='))?.slice(7) as DemoMode | undefined;
const url = process.env.BROKER_URL;
if (!url) throw new Error('BROKER_URL is required');
const marker = '/tmp/order-consumer-ready';
if (!demo) await unlink(marker).catch(() => {});
let stopping = false;
const fail = () => { if (!stopping) { console.error('consumer_unavailable=1'); process.exit(1); } };
await dataSource.initialize();
const consumer = new OrderConsumer(dataSource, topology(demo), notice => {
  if (process.send) process.send(notice);
}, process.argv.includes('--crash-after-effect'), fail);

async function stop() {
  if (stopping) return;
  stopping = true;
  if (!demo) await unlink(marker).catch(() => {});
  await consumer.stop();
  await dataSource.destroy();
  if (process.send) process.send({ kind: 'stopped', stats: consumer.stats });
  process.disconnect?.();
}
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.once('disconnect', () => { if (!stopping) void stop().then(() => process.exit(0)); });
process.on('message', message => { if ((message as { kind?: string }).kind === 'stop') void stop().then(() => process.exit(0)); });

try {
  await consumer.start(url);
  if (!demo) { await writeFile(marker, 'ready'); console.log('consumer_ready=1'); }
} catch (error) {
  stopping = true;
  await consumer.stop(); await dataSource.destroy();
  throw error;
}
