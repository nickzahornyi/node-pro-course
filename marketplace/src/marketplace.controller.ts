import { BadRequestException, Body, Controller, Get, Headers, NotFoundException, Post, Query, Param, Res, UnprocessableEntityException } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from './database.service.js';
import { ProductsRepository, validId } from './repositories/products.repository.js';
import { OrdersRepository, type ItemInput } from './repositories/orders.repository.js';

function afterId(cursor?: string): string {
  if (!cursor) return '0';
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Object.keys(value).length !== 1 || typeof value.after !== 'string' || !validId(value.after)) throw new Error();
    return value.after;
  } catch { throw new BadRequestException('Invalid opaque cursor'); }
}
function page<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({ after: items.at(-1)!.id })).toString('base64url') : null };
}
const productDto = (p: any) => ({ id: p.id, name: p.name, price_cents: Number(p.price_cents) });

@Controller()
export class MarketplaceController {
  private readonly started = Date.now();
  constructor(private readonly db: DatabaseService, private readonly products: ProductsRepository, private readonly orders: OrdersRepository) {}
  @Get('health') health() { return { status: 'ok', uptime_seconds: Math.floor((Date.now() - this.started) / 1000) }; }
  @Get('db-health') async dbHealth() { await this.db.ping(); return { status: 'ok' }; }
  @Get('products') async listProducts(@Query('cursor') cursor?: string, @Query('limit') limit = 20) {
    return page((await this.products.list(afterId(cursor), Number(limit) + 1)).map(productDto), Number(limit));
  }
  @Get('products/:productId') async getProduct(@Param('productId') id: string) {
    const product = await this.products.find(id);
    if (!product) throw new NotFoundException('Product not found');
    return productDto(product);
  }
  @Get('orders') async listOrders(@Query('cursor') cursor?: string, @Query('limit') limit = 20) {
    return page((await this.orders.list(afterId(cursor), Number(limit) + 1)).filter(o => o !== null), Number(limit));
  }
  @Get('orders/:orderId') async getOrder(@Param('orderId') id: string) {
    const order = await this.orders.find(id);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }
  @Post('orders') async createOrder(@Headers('idempotency-key') key: string, @Body() body: { items: ItemInput[] }, @Res({ passthrough: true }) response: Response) {
    const result = await this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const fingerprint = JSON.stringify(body);
      const { rows: [previous] } = await client.query('SELECT * FROM order_requests WHERE key=$1', [key]);
      const repository = new OrdersRepository(client);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new UnprocessableEntityException('Idempotency-Key already used with a different body');
        return { order: await repository.find(previous.order_id), replay: true };
      }
      // Existing public contract has no buyer/auth/payment field: create a draft, not a debit.
      const { rows: [guest] } = await client.query(`INSERT INTO users(email,display_name)
        VALUES('public-drafts@marketplace.invalid','Public draft orders')
        ON CONFLICT (lower(email)) DO UPDATE SET display_name=users.display_name RETURNING id`);
      const order = await repository.create(guest.id, body.items);
      await client.query('INSERT INTO order_requests(key,fingerprint,order_id) VALUES($1,$2,$3)', [key, fingerprint, order!.id]);
      return { order, replay: false };
    });
    if (result.replay) response.setHeader('Idempotency-Replay', 'true');
    return result.order;
  }
}
