import type { RequestHandler } from 'express';
import type { RedisSessions } from './session.js';
import type { RedisRateLimiter } from './ratelimit.js';

export function rateLimitMiddleware(limiter: RedisRateLimiter): RequestHandler {
  return (request, response, next) => {
    // Do not trust X-Forwarded-For without an explicitly configured trusted proxy.
    void limiter.consume(request.ip ?? request.socket.remoteAddress ?? 'unknown').then(result => {
      if (result.allowed) { next(); return; }
      response.setHeader('Retry-After', result.retryAfter);
      response.status(429).type('application/problem+json').json({
        type: 'https://marketplace.example/problems/429', title: 'Too Many Requests',
        status: 429, detail: 'Shared request limit exceeded', instance: request.originalUrl,
      });
    }).catch(() => response.status(503).json({ status: 503, title: 'Rate limiter unavailable' }));
  };
}

export function sessionMiddleware(sessions: RedisSessions): RequestHandler {
  return (request, response, next) => {
    const id = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('sid='))?.slice(4);
    void sessions.touch(id).then(session => {
      response.cookie('sid', session.id, { httpOnly: true, sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production', maxAge: sessions.ttlSeconds * 1000, path: '/' });
      response.locals.session = session;
      next();
    }).catch(() => response.status(503).json({ status: 503, title: 'Session store unavailable' }));
  };
}
