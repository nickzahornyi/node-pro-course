import { BadRequestException, Body, Controller, Get, Headers, HttpException, NotFoundException, Post, Query, Param, Res } from '@nestjs/common';
import { Req, UseGuards, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { AuthGuard, ProductWriteGuard, type AuthRequest } from './auth/http.js';
import type { Response } from 'express';
import { CachedProductsService } from './redis/products.service.js';
import { DatabaseService } from './database.service.js';
import { ProductsRepository, validId } from './repositories/products.repository.js';
import { OrdersRepository, type ItemInput } from './repositories/orders.repository.js';
import { OrderCreationService } from './order-creation.service.js';

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
  constructor(private readonly db: DatabaseService, private readonly products: ProductsRepository, private readonly orders: OrdersRepository, private readonly creation: OrderCreationService, private readonly cachedProducts: CachedProductsService) {}
  @Get('health') health() { return { status: 'ok', uptime_seconds: Math.floor((Date.now() - this.started) / 1000) }; }
  @Get('db-health') async dbHealth() { await this.db.ping(); return { status: 'ok' }; }
  @Get('products') async listProducts(@Query('cursor') cursor?: string, @Query('limit') limit = 20) {
    return page((await this.products.list(afterId(cursor), Number(limit) + 1)).map(productDto), Number(limit));
  }
  @Post('products') @UseGuards(AuthGuard, ProductWriteGuard)
  async createProduct(@Req() req: AuthRequest, @Body() body: {name:string;price_cents:number}) {
    if (!body || typeof body.name !== 'string' || !body.name.trim() || !Number.isSafeInteger(body.price_cents) || body.price_cents < 0 || body.price_cents > 999999999999) throw new UnprocessableEntityException('Invalid product');
    const {rows:[product]} = await this.db.query('INSERT INTO products(seller_id,name,price_cents) VALUES($1,$2,$3) RETURNING id,name,price_cents',[req.identity.userId,body.name,body.price_cents]);
    return productDto(product);
  }
  @Get('products/:productId') async getProduct(@Param('productId') id: string) {
    const product = await this.products.find(id);
    if (!product) throw new NotFoundException('Product not found');
    return productDto(product);
  }
  @Get('products/:productId/card') async getCard(@Param('productId') id: string) {
    const product = await this.cachedProducts.card(id);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }
  @Get('session') getSession(@Res({ passthrough: true }) response: Response) {
    if (!response.locals.session) throw new HttpException('Redis sessions are not configured', 503);
    return response.locals.session;
  }
  @Get('orders') @UseGuards(AuthGuard) async listOrders(@Req() req: AuthRequest, @Query('cursor') cursor?: string, @Query('limit') limit = 20) {
    return page((await this.orders.list(afterId(cursor), Number(limit) + 1, req.identity.userId)).filter(o => o !== null), Number(limit));
  }
  @Get('orders/:orderId') @UseGuards(AuthGuard) async getOrder(@Req() req: AuthRequest, @Param('orderId') id: string) {
    const order = await this.orders.find(id);
    if (!order) throw new NotFoundException('Order not found');
    const {rows:[owner]} = await this.db.query('SELECT user_id FROM orders WHERE id=$1',[id]);
    if (owner.user_id !== req.identity.userId) throw new ForbiddenException('Order belongs to another user');
    return order;
  }
  @Post('orders') @UseGuards(AuthGuard) async createOrder(@Req() req: AuthRequest, @Headers('idempotency-key') key: string, @Body() body: { items: ItemInput[] }, @Res({ passthrough: true }) response: Response) {
    const result = await this.creation.create(key, body, {}, req.identity.userId);
    if (result.replay) response.setHeader('Idempotency-Replay', 'true');
    return result.order;
  }
}
