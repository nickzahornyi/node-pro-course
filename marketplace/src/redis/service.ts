import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { connectRedis } from './connection.js';
import { AsideCache } from './cache.js';
import { RedisSessions } from './session.js';
import { RedisRateLimiter } from './ratelimit.js';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly cacheConnection;
  readonly stateConnection;
  readonly cache;
  readonly sessions;
  readonly limiter;
  constructor(config: ConfigService<Env, true>) {
    const cacheUrl = config.get('REDIS_URL', { infer: true });
    const stateUrl = config.get('REDIS_QUEUE_URL', { infer: true });
    this.cacheConnection = cacheUrl ? connectRedis(cacheUrl) : undefined;
    this.stateConnection = stateUrl ? connectRedis(stateUrl) : undefined;
    this.cache = this.cacheConnection ? new AsideCache(this.cacheConnection) : undefined;
    this.sessions = this.stateConnection ? new RedisSessions(this.stateConnection) : undefined;
    this.limiter = this.stateConnection ? new RedisRateLimiter(this.stateConnection) : undefined;
  }
  async onModuleInit() {
    // Optional cache may fail open; sessions/limits fail startup when configured but unavailable.
    await this.cacheConnection?.connect().catch(() => {});
    await this.stateConnection?.connect();
  }
  onModuleDestroy() {
    this.cacheConnection?.disconnect();
    this.stateConnection?.disconnect();
  }
}
