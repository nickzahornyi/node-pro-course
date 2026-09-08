import express, { type NextFunction, type Request, type Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

interface DatabaseHealth {
  ping(): Promise<void>;
}

interface Product {
  id: string;
  name: string;
  price_cents: number;
}

interface OrderItemInput {
  product_id: string;
  quantity: number;
}

interface OrderItem extends OrderItemInput {
  unit_price_cents: number;
}

interface Order {
  id: string;
  status: 'created';
  items: OrderItem[];
  total_cents: number;
}

interface HttpError extends Error {
  status?: number;
}

const filename = fileURLToPath(import.meta.url);
const apiSpec = path.join(path.dirname(filename), '..', 'openapi', 'openapi.yaml');
const startedAt = Date.now();

function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

export function createApp(database?: DatabaseHealth) {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  }));
  app.get('/db-health', async (_req, res, next) => {
    try {
      if (!database) throw httpError(503, 'Database is not configured');
      await database.ping();
      res.json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  app.use(OpenApiValidator.middleware({ apiSpec, validateRequests: true, validateResponses: true }));

  const products: Product[] = [
    { id: 'prod-1', name: 'Mechanical keyboard', price_cents: 320000 },
    { id: 'prod-2', name: 'Wireless mouse', price_cents: 145000 },
    { id: 'prod-3', name: 'USB-C hub', price_cents: 210000 },
  ];
  const orders: Order[] = [];
  const idempotencyRecords = new Map<string, { bodyFingerprint: string; order: Order }>();
  const encodeCursor = (id: string) => Buffer.from(JSON.stringify({ after: id })).toString('base64url');
  const decodeCursor = (cursor?: string): string | null => {
    if (!cursor) return null;
    try {
      const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!decoded || typeof decoded !== 'object' || !('after' in decoded)
        || typeof decoded.after !== 'string' || Object.keys(decoded).length !== 1) throw new Error();
      return decoded.after;
    } catch {
      throw httpError(400, 'cursor must be a valid opaque token');
    }
  };
  const page = <T extends { id: string }>(records: T[], query: { cursor?: string; limit?: number }) => {
    const afterId = decodeCursor(query.cursor);
    const afterIndex = afterId === null ? -1 : records.findIndex(({ id }) => id === afterId);
    if (afterId !== null && afterIndex === -1) throw httpError(400, 'cursor does not reference an existing record');
    const limit = query.limit ?? 20;
    const items = records.slice(afterIndex + 1, afterIndex + 1 + limit);
    const hasMore = afterIndex + 1 + items.length < records.length;
    return { items, next_cursor: hasMore ? encodeCursor(items.at(-1)!.id) : null };
  };

  app.get('/products', (req, res) => res.json(page(products, req.query as { cursor?: string; limit?: number })));
  app.get('/products/:productId', (req, res, next) => {
    const product = products.find(({ id }) => id === req.params.productId);
    return product ? res.json(product) : next(httpError(404, 'Product not found'));
  });
  app.get('/orders', (req, res) => res.json(page(orders, req.query as { cursor?: string; limit?: number })));
  app.get('/orders/:orderId', (req, res, next) => {
    const order = orders.find(({ id }) => id === req.params.orderId);
    return order ? res.json(order) : next(httpError(404, 'Order not found'));
  });
  app.post('/orders', (req, res, next) => {
    const key = req.headers['idempotency-key'] as string;
    const body = req.body as { items: OrderItemInput[] };
    const bodyFingerprint = JSON.stringify(body);
    const previous = idempotencyRecords.get(key);
    if (previous && previous.bodyFingerprint !== bodyFingerprint) {
      return next(httpError(422, 'Idempotency-Key was already used with a different request body'));
    }
    if (previous) return res.status(201).set('Idempotency-Replay', 'true').json(previous.order);
    const unknownProductIds = [...new Set(body.items
      .filter((item) => !products.some(({ id }) => id === item.product_id))
      .map((item) => item.product_id))];
    if (unknownProductIds.length > 0) return next(httpError(422, `Unknown product_id: ${unknownProductIds.join(', ')}`));
    const items = body.items.map((item) => {
      const product = products.find(({ id }) => id === item.product_id)!;
      return { ...item, unit_price_cents: product.price_cents };
    });
    const order: Order = {
      id: `order-${orders.length + 1}`,
      status: 'created',
      items,
      total_cents: items.reduce((sum, item) => sum + item.unit_price_cents * item.quantity, 0),
    };
    orders.push(order);
    idempotencyRecords.set(key, { bodyFingerprint, order });
    return res.status(201).json(order);
  });

  app.use((err: HttpError, req: Request, res: Response, _next: NextFunction) => {
    const status = Number.isInteger(err.status) && err.status! >= 400 ? err.status! : 500;
    const title = status === 400 ? 'Bad Request' : status === 404 ? 'Not Found'
      : status === 422 ? 'Unprocessable Entity' : status === 503 ? 'Service Unavailable' : 'Internal Server Error';
    res.status(status).type('application/problem+json').json({
      type: `https://marketplace.example/problems/${status}`,
      title,
      status,
      detail: err.message ?? title,
      instance: req.originalUrl,
    });
  });
  return app;
}
