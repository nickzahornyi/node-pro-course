import express from 'express';
import { connectRedis, requiredUrl } from './connection.js';
import { RedisSessions } from './session.js';
import { RedisRateLimiter } from './ratelimit.js';
import { sessionMiddleware, rateLimitMiddleware } from './http.js';

const [mode, prefix] = process.argv.slice(2);
const redis = connectRedis(requiredUrl('REDIS_QUEUE_URL'));
await redis.connect();
const app = express();
if (mode === 'session') {
  app.use(sessionMiddleware(new RedisSessions(redis, prefix, 10)));
  app.get('/', (_request, response) => response.json(response.locals.session));
} else if (mode === 'ratelimit') {
  app.use(rateLimitMiddleware(new RedisRateLimiter(redis, prefix, 5, 30000)));
  app.get('/', (_request, response) => response.json({ ok: true }));
} else throw new Error('Unknown demo server mode');
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  process.send?.({ url: `http://127.0.0.1:${address.port}/` });
});
process.once('message', () => {
  server.close(() => { redis.disconnect(); process.disconnect?.(); });
  server.closeIdleConnections();
});
