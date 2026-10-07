import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.schema.js';
import { DatabaseService } from './database.service.js';
import { ProductsRepository } from './repositories/products.repository.js';
import { OrdersRepository } from './repositories/orders.repository.js';
import { MarketplaceController } from './marketplace.controller.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate, ignoreEnvFile: process.env.NODE_ENV === 'test' })],
  controllers: [MarketplaceController],
  providers: [DatabaseService, ProductsRepository, OrdersRepository],
  exports: [DatabaseService],
})
export class AppModule {}
