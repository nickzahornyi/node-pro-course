import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import pino from 'pino';

export const requestContext = new AsyncLocalStorage<{ userId?: string; tenant?: string; idempotencyKey?: string }>();
export const logger = pino({
  redact: { paths: ['authorization', 'password', 'token', 'refresh_token', 'headers.authorization',
    'req.headers.authorization', 'req.body', 'body', 'credentials.password', 'user.password'], remove: true },
  mixin: () => ({ ...requestContext.getStore(), trace_id: trace.getActiveSpan()?.spanContext().traceId }),
});
// Do not log arbitrary input objects. Redaction is defense in depth for explicitly known shapes.
export const log = (layer: string) => logger.child({ layer });
