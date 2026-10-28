import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectRedis, requiredUrl } from './connection.js';
import { demoServer, printMetrics, removePrefix } from './demo-utils.js';

const redis = connectRedis(requiredUrl('REDIS_QUEUE_URL'));
const prefix = `hw23:limit:${randomUUID()}:`;
const servers: Awaited<ReturnType<typeof demoServer>>[] = [];
try {
  await redis.connect();
  for (let i = 0; i < 2; i++) servers.push(await demoServer('ratelimit', prefix));
  const requests = 20, limit = 5;
  const responses = await Promise.all(Array.from({ length: requests }, (_, i) => fetch(servers[i % servers.length].url)));
  const allowed = responses.filter(response => response.status === 200).length;
  const blocked = responses.filter(response => response.status === 429);
  assert.equal(allowed, limit); assert.equal(blocked.length, requests - limit);
  const retryAfter = Number(blocked.every(response => Number(response.headers.get('retry-after')) > 0));
  assert.equal(retryAfter, 1);
  await Promise.all(responses.map(response => response.text()));
  printMetrics({ instances: servers.length, limit, requests, allowed, blocked: blocked.length,
    status: blocked.at(-1)!.status, 'retry-after': retryAfter });
} finally {
  for (const server of servers) await server.close();
  if (redis.status === 'ready') await removePrefix(redis, prefix);
  redis.disconnect();
}
