import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database.service.js';
import { validId } from '../repositories/products.repository.js';
import { AuthService } from '../auth/auth.service.js';

@Injectable()
export class OrderAccessService {
  constructor(private readonly db: DatabaseService, private readonly auth: AuthService) {}

  async authenticate(token: unknown) {
    const identity = await this.auth.authenticate(token);
    return identity;
  }

  async authorizeHeader(id: string, header?: string) {
    const identity = await this.authenticate(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
    await this.assertOwner(id, identity.userId);
    return identity;
  }

  async assertOwner(id: string, userId: string): Promise<void> {
    if (!validId(id)) throw new NotFoundException('Order not found');
    const { rows: [order] } = await this.db.query('SELECT user_id FROM orders WHERE id=$1', [id]);
    if (!order) throw new NotFoundException('Order not found');
    if (order.user_id !== userId) throw new ForbiddenException('Order belongs to another user');
  }
}
