import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { createApp } from './app.js';
import type { Env } from './config/env.schema.js';
import { DatabaseService } from './database.service.js';

const context = await NestFactory.createApplicationContext(AppModule);
const config = context.get<ConfigService<Env, true>>(ConfigService);
const database = context.get(DatabaseService);
const port = config.get('PORT', { infer: true });
const server = createApp(database).listen(port, () => {
  console.log(`Marketplace API listening on http://localhost:${port}`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await context.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
