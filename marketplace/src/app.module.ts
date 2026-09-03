import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.schema.js';
import { DatabaseService } from './database.service.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate })],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class AppModule {}
