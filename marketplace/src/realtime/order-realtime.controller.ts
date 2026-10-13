import { BadRequestException, Body, Controller, Get, Headers, Param, Patch, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { OrderStatus } from '../entities/order.entity.js';
import { OrderAccessService } from './order-access.service.js';
import { OrderEventsService, type OrderStatusEvent } from './order-events.service.js';
import { OrderStatusService } from './order-status.service.js';

@Controller('orders')
export class OrderRealtimeController {
  constructor(private readonly access: OrderAccessService, private readonly events: OrderEventsService, private readonly statuses: OrderStatusService) {}

  @Patch(':orderId/status')
  async changeStatus(@Param('orderId') id: string, @Headers('authorization') header: string | undefined, @Body() body: { status: OrderStatus }) {
    const identity = await this.access.authorizeHeader(id, header);
    return this.statuses.change(id, identity.userId, body.status);
  }

  @Get(':orderId/events')
  async stream(@Param('orderId') id: string, @Headers('authorization') header: string | undefined,
    @Headers('last-event-id') lastId: string | undefined, @Res() response: Response) {
    const identity = await this.access.authorizeHeader(id, header);
    if (lastId !== undefined && !/^\d+$/.test(lastId)) throw new BadRequestException('Last-Event-ID must be a non-negative integer');
    const replay = lastId === undefined ? [] : this.events.replay(id, Number(lastId));
    const write = (event: OrderStatusEvent) => {
      if (!response.destroyed) response.write(`id: ${event.id}\nevent: order.status\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // No await between replay snapshot and subscription: publication cannot slip between them.
    response.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    response.write('retry: 1000\n\n');
    replay.forEach(write);
    const subscription = this.events.observe(id).subscribe({ next: write, complete: () => response.end() });
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15000);
    const expiry = setTimeout(() => response.end(), Math.max(0, identity.expiresAt - Date.now()));
    heartbeat.unref(); expiry.unref();
    response.once('close', () => { subscription.unsubscribe(); clearInterval(heartbeat); clearTimeout(expiry); });
  }
}
