import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { DatabaseService } from '../database.service.js';
import { validId } from '../repositories/products.repository.js';
import { verifyToken } from './token.js';

@Injectable()
export class OrderAccessService {
  constructor(private readonly db: DatabaseService, private readonly config: ConfigService) {}

  async authenticate(token: unknown) {
    // Do not turn secret-file/configuration errors into misleading authentication errors.
    const secret = this.config.get<string>('AUTH_SECRET')
      ?? (await readFile(this.config.getOrThrow<string>('AUTH_SECRET_FILE'), 'utf8')).trim();
    try { return verifyToken(token, secret); }
    catch { throw new UnauthorizedException('A valid realtime bearer token is required'); }
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
