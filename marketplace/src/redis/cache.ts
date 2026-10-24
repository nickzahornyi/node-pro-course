import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Redis } from 'ioredis';

export const RELEASE_LOCK = `if redis.call('GET',KEYS[1]) == ARGV[1] then
  return redis.call('DEL',KEYS[1]) else return 0 end`;

export class AsideCache {
  constructor(private readonly redis: Redis, readonly prefix = 'shop:card:v1:',
    private readonly lockMs = 10000, private readonly waitMs = 12000) {}

  key(id: string) { return `${this.prefix}${id}`; }

  async get<T>(id: string, load: () => Promise<T>): Promise<T> {
    const key = this.key(id), lock = `lock:${key}`, token = randomUUID();
    const deadline = Date.now() + this.waitMs;
    while (Date.now() < deadline) {
      let acquired: boolean;
      try {
        const hit = await this.redis.get(key);
        if (hit !== null) return JSON.parse(hit) as T;
        acquired = await this.redis.set(lock, token, 'PX', this.lockMs, 'NX') === 'OK';
      } catch { return load(); } // Cache outages never turn a valid DB read into an HTTP error.
      if (acquired) {
        try {
          // Another owner may have populated the cache between our GET and SET NX.
          let hit: string | null = null;
          try { hit = await this.redis.get(key); } catch {}
          if (hit !== null) return JSON.parse(hit) as T;
          const value = await load();
          try { await this.redis.set(key, JSON.stringify(value), 'EX', 300 + randomInt(61)); } catch {}
          return value;
        } finally {
          try { await this.redis.eval(RELEASE_LOCK, 1, lock, token); } catch {}
        }
      }
      await delay(20 + randomInt(21));
    }
    // Bounded waiting: a lost/evicted lease is an extra DB read, never a business lock.
    return load();
  }
}
