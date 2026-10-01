import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

const app = await NestFactory.create(AppModule, { bodyParser: false });
configureApp(app);
await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'), '0.0.0.0');
