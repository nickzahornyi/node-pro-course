import { FilesController } from './files/http.js';
import { FilesService } from './files/service.js';
import { AuthService } from './auth/auth.service.js';
import { AuthController, AuthGuard, ProductWriteGuard } from './auth/http.js';
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
import { OrderCreationService } from './order-creation.service.js';
import { RedisService } from './redis/service.js';
import { CachedProductsService } from './redis/products.service.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate, ignoreEnvFile: process.env.NODE_ENV === 'test' })],
  controllers: [FilesController, AuthController, MarketplaceController, OrderRealtimeController],
  providers: [FilesService, AuthService, AuthGuard, ProductWriteGuard, DatabaseService, ProductsRepository, OrdersRepository, OrderAccessService, OrderEventsService, OrderStatusService, OrdersGateway, OrderCreationService, RedisService, CachedProductsService],
  exports: [DatabaseService],
})
export class AppModule {}
