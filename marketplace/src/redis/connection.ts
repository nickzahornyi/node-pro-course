import { Redis, type RedisOptions } from 'ioredis';

export function redisOptions(url: string, worker = false) {
  const parsed = new URL(url);
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('Expected redis:// or rediss:// URL');
  return {
    host: parsed.hostname, port: Number(parsed.port || 6379),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number(parsed.pathname.slice(1) || 0),
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: worker ? null : 1,
    connectTimeout: 2000, enableOfflineQueue: worker,
    // Producers/API fail commands quickly but reconnect in the background after an outage.
    retryStrategy: (times: number) => Math.min(times * 100, 2000),
  };
}

export function connectRedis(url: string, options: RedisOptions = {}): Redis {
  const redis = new Redis({ ...redisOptions(url), ...options, lazyConnect: true });
  // Connection failures are surfaced by commands; never log credential-bearing URLs.
  redis.on('error', () => {});
  return redis;
}

export function requiredUrl(key: 'REDIS_URL' | 'REDIS_QUEUE_URL'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; use scripts/with-secrets.sh dev`);
  return value;
}
