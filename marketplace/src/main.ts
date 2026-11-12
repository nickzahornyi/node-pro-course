import './observability/telemetry.js';
import 'reflect-metadata';
import './auth/validate-startup.js';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setTimeout as delay } from 'node:timers/promises';
import { healthRoutes } from './kubernetes/health.js';
import { logger } from './observability/logger.js';
import { provider } from './observability/telemetry.js';
import { configureApp } from './configure-app.js';

const app = await NestFactory.create(AppModule, { bodyParser: false, logger: { log: message => logger.info({ layer: 'nest' }, String(message)), error: message => logger.error({ layer: 'nest' }, String(message)), warn: message => logger.warn({ layer: 'nest' }, String(message)) } });
const health=healthRoutes(app);
configureApp(app,false);
// Configurable operational warmup makes rolling-update behavior observable.
await delay(Number(process.env.STARTUP_DELAY_MS || 0));
await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'), '0.0.0.0');

health.markReady();
let draining=false;
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{
  if(draining) return;
  draining=true;
  void health.drain(Number(process.env.DRAIN_MS || 5000)).then(()=>provider.shutdown()).then(()=>process.exit(0)).catch(()=>process.exit(1));
});
