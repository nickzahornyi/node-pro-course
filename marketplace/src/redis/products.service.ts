import { Injectable } from '@nestjs/common';
import { ProductsRepository } from '../repositories/products.repository.js';
import { RedisService } from './service.js';

@Injectable()
export class CachedProductsService {
  constructor(private readonly products: ProductsRepository, private readonly redis: RedisService) {}
  card(id: string) {
    const load = () => this.products.card(id);
    return this.redis.cache ? this.redis.cache.get(id, load) : load();
  }
}
