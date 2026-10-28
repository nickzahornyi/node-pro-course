import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export class RedisSessions {
  constructor(private readonly redis: Redis, readonly prefix = 'shop:session:', readonly ttlSeconds = 1800) {}
  key(id: string) { return `${this.prefix}${id}`; }
  async touch(id?: string, create = true): Promise<{ id: string; createdAt: string } | null> {
    if (id && /^[a-f0-9]{64}$/.test(id)) {
      const stored = await this.redis.getex(this.key(id), 'EX', this.ttlSeconds);
      if (stored !== null) return { id, createdAt: stored };
    }
    if (!create) return null;
    for (;;) {
      const freshId = randomBytes(32).toString('hex'), createdAt = new Date().toISOString();
      if (await this.redis.set(this.key(freshId), createdAt, 'EX', this.ttlSeconds, 'NX')) {
        return { id: freshId, createdAt };
      }
    }
  }
}
