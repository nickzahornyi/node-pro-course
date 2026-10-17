import { mkdir, open, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { Channel, GetMessage } from 'amqplib';
import { connectBroker } from './publisher.js';
import { topology } from './topology.js';

// One durable local archive per delivery. Never ACK before file and directory fsync.
async function archiveMessage(directory: string, queue: string, message: GetMessage) {
  const filename = `${Date.now()}-${randomUUID()}.json`;
  const temporary = join(directory, `.${filename}.partial`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ archivedAt: new Date().toISOString(), queue,
      reason: message.properties.headers?.['x-death']?.[0]?.reason
        ?? message.properties.headers?.['x-first-death-reason'] ?? null,
      fields: message.fields, properties: message.properties,
      contentBase64: message.content.toString('base64'),
    }) + '\n');
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, join(directory, filename));
  const folder = await open(directory, 'r');
  try { await folder.sync(); } finally { await folder.close(); }
}

export async function drainDlq(channel: Channel, queue: string, archive: string, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit must be 1..10000');
  const directory = resolve(archive);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const initial = await channel.checkQueue(queue); // Passive: never creates or purges queues.
  const budget = Math.min(initial.messageCount, limit);
  let archived = 0;
  for (let index = 0; index < budget; index++) {
    const message = await channel.get(queue, { noAck: false });
    if (!message) break;
    // On any write failure leave delivery unacked; CLI closes channel -> broker requeues.
    await archiveMessage(directory, queue, message);
    channel.ack(message);
    archived++;
  }
  const remaining = (await channel.checkQueue(queue)).messageCount;
  return { archived, remaining, archive: directory };
}

async function main() {
  const { values } = parseArgs({ options: {
    archive: { type: 'string' }, limit: { type: 'string', default: '100' },
    queue: { type: 'string', default: topology().dlq },
  } });
  if (!values.archive) throw new Error('--archive <directory> is required (durable storage)');
  const allowed = [topology().dlq, ...(['publish', 'dlq', 'duplicate'] as const).map(mode => topology(mode).dlq)];
  if (!allowed.includes(values.queue!)) throw new Error('Only the application or HW19 demo DLQs may be drained');
  const url = process.env.BROKER_URL;
  if (!url) throw new Error('BROKER_URL is required');
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('--limit must be 1..10000');
  const connection = await connectBroker(url);
  try {
    const channel = await connection.createChannel();
    channel.on('error', () => {});
    try {
      const result = await drainDlq(channel, values.queue!, values.archive, limit);
      for (const [key, value] of Object.entries(result)) console.log(`${key}=${value}`);
    } finally { await channel.close().catch(() => {}); }
  } finally { await connection.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => { console.error('dlq_drain_failed=1 (check broker, arguments and archive storage; unacked messages are requeued)'); process.exitCode = 1; });
}
