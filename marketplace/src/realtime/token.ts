import { createHmac, timingSafeEqual } from 'node:crypto';
import { validId } from '../repositories/products.repository.js';

// An opaque HMAC-signed identity token, issued by an operator (no public mint endpoint).
export function issueToken(userId: string, secret: string, ttlSeconds = 3600): string {
  if (!validId(userId) || secret.length < 32 || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error('Invalid token configuration');
  const body = Buffer.from(JSON.stringify({ sub: userId, aud: 'marketplace-realtime', exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyToken(token: unknown, secret: string): { userId: string; expiresAt: number } {
  if (typeof token !== 'string' || token.length > 2048 || secret.length < 32) throw new Error('Invalid token');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid token');
  const [body, signature] = parts;
  const expected = createHmac('sha256', secret).update(body).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid token');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (typeof claims.sub !== 'string' || !validId(claims.sub) || claims.aud !== 'marketplace-realtime'
    || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('Invalid or expired token');
  return { userId: claims.sub, expiresAt: claims.exp * 1000 };
}
