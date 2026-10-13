import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.schema.js';
import { DatabaseService } from './database.service.js';
import { ProductsRepository } from './repositories/products.repository.js';
import { OrdersRepository } from './repositories/orders.repository.js';
import { MarketplaceController } from './marketplace.controller.js';
import { OrderAccessService } from './realtime/order-access.service.js';
import { OrderEventsService } from './realtime/order-events.service.js';
import { OrderStatusService } from './realtime/order-status.service.js';
import { OrdersGateway } from './realtime/orders.gateway.js';
import { OrderRealtimeController } from './realtime/order-realtime.controller.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate, ignoreEnvFile: process.env.NODE_ENV === 'test' })],
  controllers: [MarketplaceController, OrderRealtimeController],
  providers: [DatabaseService, ProductsRepository, OrdersRepository, OrderAccessService, OrderEventsService, OrderStatusService, OrdersGateway],
  exports: [DatabaseService],
})
export class AppModule {}
