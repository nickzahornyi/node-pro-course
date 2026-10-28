import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// Redis TIME prevents clock skew between pods. Prune, count, add and expiry are atomic.
const SLIDING_WINDOW = `
local t = redis.call('TIME')
local now = tonumber(t[1])*1000 + math.floor(tonumber(t[2])/1000)
local window = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-window)
local n = redis.call('ZCARD',KEYS[1])
if n < tonumber(ARGV[2]) then
  redis.call('ZADD',KEYS[1],now,ARGV[3])
  redis.call('PEXPIRE',KEYS[1],window)
  return {1,0}
end
local first = redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES')
return {0,math.max(1,math.ceil((tonumber(first[2])+window-now)/1000))}`;

export class RedisRateLimiter {
  constructor(private readonly redis: Redis, readonly prefix = 'shop:limit:',
    readonly limit = 100, readonly windowMs = 60000) {}
  async consume(client: string): Promise<{ allowed: boolean; retryAfter: number }> {
    const result = await this.redis.eval(SLIDING_WINDOW, 1, `${this.prefix}${client}`,
      this.windowMs, this.limit, randomUUID()) as [number, number];
    return { allowed: result[0] === 1, retryAfter: result[1] };
  }
}
