import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer, type OnGatewayInit } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Subscription } from 'rxjs';
import { OrderAccessService } from './order-access.service.js';
import { OrderEventsService } from './order-events.service.js';

@WebSocketGateway({ transports: ['websocket'] })
export class OrdersGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private subscription?: Subscription;
  private readonly logger = new Logger(OrdersGateway.name);

  constructor(private readonly access: OrderAccessService, private readonly events: OrderEventsService) {}

  afterInit(server: Server) {
    server.use((socket, next) => {
      void this.access.authenticate(socket.handshake.auth?.token).then(identity => {
        socket.data.identity = identity;
        next();
      }).catch(() => next(new Error('Unauthorized')));
    });
    server.on('connection', socket => {
      // Expired credentials must not retain access to an already joined room.
      const timer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.identity.expiresAt - Date.now()));
      timer.unref();
      socket.once('disconnect', () => clearTimeout(timer));
    });
    this.subscription = this.events.observeAll().subscribe(event => {
      server.to(`orders:${event.order_id}`).emit('order.status', event);
    });
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() data: unknown) {
    try {
      const id = typeof data === 'string' ? data : (data as { order_id?: unknown } | null)?.order_id;
      if (typeof id !== 'string') return { ok: false, status: 400, error: 'order_id must be a string' };
      const identity = socket.data.identity;
      if (!identity || identity.expiresAt <= Date.now()) return { ok: false, status: 401, error: 'Unauthorized' };
      await this.access.assertOwner(id, identity.userId);
      if (!socket.connected) return { ok: false, status: 401, error: 'Disconnected' };
      await socket.join(`orders:${id}`);
      return { ok: true, room: `orders:${id}` };
    } catch (error: any) {
      const status = typeof error.getStatus === 'function' ? error.getStatus() : 500;
      if (status === 500) this.logger.error('Room authorization failed');
      return { ok: false, status, error: status === 500 ? 'Internal Server Error' : error.message };
    }
  }

  onModuleDestroy() { this.subscription?.unsubscribe(); }
}
