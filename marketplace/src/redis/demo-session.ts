import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectRedis, requiredUrl } from './connection.js';
import { demoServer, printMetrics, removePrefix } from './demo-utils.js';

const redis = connectRedis(requiredUrl('REDIS_QUEUE_URL'));
const prefix = `hw23:session:${randomUUID()}:`;
let server: Awaited<ReturnType<typeof demoServer>> | undefined;
try {
  await redis.connect();
  server = await demoServer('session', prefix);
  const first = await fetch(server.url);
  assert.equal(first.status, 200);
  const initial = await first.json() as { id: string; createdAt: string };
  const cookie = first.headers.get('set-cookie')!.split(';')[0];
  const ids = new Set([initial.id]);
  const key = `${prefix}${initial.id}`;
  assert.equal(await redis.exists(key), 1);
  await delay(1500);
  const before = await redis.pttl(key);
  const second = await fetch(server.url, { headers: { cookie } });
  assert.equal(second.status, 200);
  const secondBody = await second.json() as typeof initial;
  ids.add(secondBody.id);
  const after = await redis.pttl(key);
  assert(after > before + 1000);
  await server.close(); // Actual process restart: no in-memory session can survive this.
  server = await demoServer('session', prefix);
  await delay(1100);
  const third = await fetch(server.url, { headers: { cookie } });
  assert.equal(third.status, 200);
  const thirdBody = await third.json() as typeof initial;
  ids.add(thirdBody.id);
  assert.deepEqual(thirdBody, initial); assert.equal(ids.size, 1);
  printMetrics({ requests: 3, sessions: ids.size, 'in-redis': await redis.exists(key), 'ttl-renewed': Number(after > before) });
} finally {
  await server?.close();
  if (redis.status === 'ready') await removePrefix(redis, prefix);
  redis.disconnect();
}
