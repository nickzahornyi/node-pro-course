import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { Env } from './config/env.schema.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService<Env, true>) {
    const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });
    const databaseUrl = new URL(config.get('DB_URL', { infer: true }));
    this.pool = new Pool({
      host: databaseUrl.hostname,
      port: databaseUrl.port ? Number(databaseUrl.port) : 5432,
      user: decodeURIComponent(databaseUrl.username),
      database: decodeURIComponent(databaseUrl.pathname.slice(1)),
      max: config.get('DB_POOL_MAX', { infer: true }),
      password: async () => (await readFile(passwordFile, 'utf8')).trim(),
    });
    this.pool.on('error', (error) => {
      this.logger.warn(`PostgreSQL idle connection was closed: ${error.message}`);
    });
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
