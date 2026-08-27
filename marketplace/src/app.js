import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const filename = fileURLToPath(import.meta.url);
const apiSpec = path.join(path.dirname(filename), '..', 'openapi', 'openapi.yaml');

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(OpenApiValidator.middleware({ apiSpec, validateRequests: true, validateResponses: true }));

  const products = [
    { id: 'prod-1', name: 'Mechanical keyboard', price_cents: 320000 },
    { id: 'prod-2', name: 'Wireless mouse', price_cents: 145000 },
    { id: 'prod-3', name: 'USB-C hub', price_cents: 210000 },
  ];
  const orders = [];
  const idempotencyRecords = new Map();
  const encodeCursor = (offset) => Buffer.from(String(offset)).toString('base64url');
  const decodeCursor = (cursor) => {
    if (!cursor) return 0;
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^\d+$/.test(decoded)) throw Object.assign(new Error('cursor must be a valid opaque token'), { status: 400 });
    return Number(decoded);
  };
  const page = (records, query) => {
    const offset = decodeCursor(query.cursor);
    const limit = query.limit ?? 20;
    const items = records.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return { items, next_cursor: nextOffset < records.length ? encodeCursor(nextOffset) : null };
  };

  app.get('/products', (req, res) => res.json(page(products, req.query)));
  app.get('/products/:productId', (req, res, next) => {
    const product = products.find(({ id }) => id === req.params.productId);
    return product ? res.json(product) : next(Object.assign(new Error('Product not found'), { status: 404 }));
  });
  app.get('/orders', (req, res) => res.json(page(orders, req.query)));
  app.get('/orders/:orderId', (req, res, next) => {
    const order = orders.find(({ id }) => id === req.params.orderId);
    return order ? res.json(order) : next(Object.assign(new Error('Order not found'), { status: 404 }));
  });
  app.post('/orders', (req, res, next) => {
    const key = req.headers['idempotency-key'];
    const bodyFingerprint = JSON.stringify(req.body);
    const previous = idempotencyRecords.get(key);
    if (previous && previous.bodyFingerprint !== bodyFingerprint) {
      return next(Object.assign(new Error('Idempotency-Key was already used with a different request body'), { status: 422 }));
    }
    if (previous) return res.status(201).set('Idempotency-Replay', 'true').json(previous.order);
    const items = req.body.items.map((item) => {
      const product = products.find(({ id }) => id === item.product_id);
      return { ...item, unit_price_cents: product?.price_cents ?? 0 };
    });
    const order = {
      id: `order-${orders.length + 1}`,
      status: 'created',
      items,
      total_cents: items.reduce((sum, item) => sum + item.unit_price_cents * item.quantity, 0),
    };
    orders.push(order);
    idempotencyRecords.set(key, { bodyFingerprint, order });
    return res.status(201).json(order);
  });

  app.use((err, req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 ? err.status : 500;
    const title = status === 400 ? 'Bad Request' : status === 404 ? 'Not Found'
      : status === 422 ? 'Unprocessable Entity' : 'Internal Server Error';
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

if (process.argv[1] === filename) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`Marketplace API listening on http://localhost:${port}`));
}
