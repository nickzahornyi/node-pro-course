import type { Request, Response, NextFunction } from 'express';
import { context, propagation, trace, SpanKind, SpanStatusCode, ROOT_CONTEXT } from '@opentelemetry/api';
import { Counter, Histogram, Registry } from 'prom-client';
import { requestContext, log } from './logger.js';

export const registry = new Registry();
export const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
export const requests = new Counter({ name: 'http_requests_total', help: 'Completed HTTP requests',
  labelNames: ['method', 'route', 'status'], registers: [registry] });
export const duration = new Histogram({ name: 'http_request_duration_seconds', help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'], buckets, registers: [registry] });
export const tracer = trace.getTracer('marketplace');
const httpLog = log('http');
export function observeHttp(req: Request, res: Response, next: NextFunction) {
  if (req.path === '/metrics') return void registry.metrics().then(value => res.type(registry.contentType).send(value)).catch(next);
  const parent = propagation.extract(ROOT_CONTEXT, req.headers);
  const span = tracer.startSpan('HTTP request', { kind: SpanKind.SERVER }, parent);
  const active = trace.setSpan(parent, span);
  const started = performance.now();
  const store = { tenant: req.get('x-tenant-id'), idempotencyKey: req.get('idempotency-key') };
  context.with(active, () => requestContext.run(store, () => {
    res.setHeader('traceparent', `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    // Never serialize raw URLs, auth request bodies, cookies or bearer credentials.
    httpLog.info({ event: 'request', method: req.method, headers: { authorization: req.get('authorization') }, body: req.body });
    let finished = false;
    const finish = () => context.with(active, () => requestContext.run(store, () => {
      if (finished) return; finished = true;
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      const status = res.writableFinished ? res.statusCode : 499;
      const method = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(req.method) ? req.method : 'OTHER';
      const labels = { method, route, status: String(status) };
      requests.inc(labels); duration.observe(labels, (performance.now() - started) / 1000);
      span.updateName(`${method} ${route}`);
      span.setAttributes({ 'http.request.method': method, 'http.route': route, 'http.response.status_code': status });
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      httpLog.info({ event: 'response', ...labels });
      span.end();
    }));
    res.once('finish', finish); res.once('close', finish);
    next();
  }));
}
