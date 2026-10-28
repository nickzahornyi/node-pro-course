import { connectRedis } from './connection.js';

// Call only AFTER COMMIT. Cache failure must never turn a committed order into an error.
export async function invalidateProductCards(ids: string[]): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url || !ids.length) return;
  let redis: ReturnType<typeof connectRedis> | undefined;
  try {
    redis = connectRedis(url, { connectTimeout: 1000, commandTimeout: 1000, retryStrategy: () => null });
    await redis.connect();
    await redis.del(...[...new Set(ids)].flatMap(id => {
      const key = `shop:card:v1:${id}`;
      return [key, `lock:${key}`];
    }));
  } catch { /* TTL remains the fallback if Redis is unavailable. */ }
  finally { redis?.disconnect(); }
}
