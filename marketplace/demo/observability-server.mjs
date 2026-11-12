// Isolated process/registry/ALS/exporter for every run, using production HTTP and domain layers.
if (process.send) process.env.OBS_DEMO = '1';
await import('../dist/observability/telemetry.js');
await import('reflect-metadata');
const { default: express } = await import('express');
const { Pool } = await import('pg');
const { observeHttp } = await import('../dist/observability/http.js');
const { provider, memoryExporter } = await import('../dist/observability/telemetry.js');
const { MarketplaceController } = await import('../dist/marketplace.controller.js');
const { ProductsRepository } = await import('../dist/repositories/products.repository.js');
const { CachedProductsService } = await import('../dist/redis/products.service.js');
const pool = new Pool({ connectionString: process.env.OBS_DB_URL || 'postgresql://observability:observability@127.0.0.1:22932/observability', max: 12 });
const schema = `demo_${process.pid}_${Date.now()}`;
await pool.query(`CREATE SCHEMA ${schema}`);
await pool.query(`CREATE TABLE ${schema}.users(id bigint PRIMARY KEY, display_name text);
CREATE TABLE ${schema}.products(id bigint PRIMARY KEY,name text,price_cents bigint,stock int,seller_id bigint);
CREATE TABLE ${schema}.orders(id bigint PRIMARY KEY,status text);
CREATE TABLE ${schema}.order_items(product_id bigint,order_id bigint,quantity int);
INSERT INTO ${schema}.users VALUES(1,'Demo seller');
INSERT INTO ${schema}.products SELECT id,'Demo product',100,10,1 FROM generate_series(1,1000) AS id`);
const db = { async query(sql, args) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schema}`);
    if (args?.[0] === '999') await client.query('SELECT 1/0');
    if (args?.[0] === '998') await client.query('SELECT pg_sleep(1.2)');
    return await client.query(sql, args);
  } finally { client.release(); }
} };
const repository = new ProductsRepository(db);
const service = new CachedProductsService(repository, {});
const controller = new MarketplaceController(db, repository, undefined, undefined, service);
const app = express();
app.use(observeHttp);
app.use(express.json());
app.get('/products/:productId/card', async (req, res, next) => {
  try { res.json(await controller.getCard(req.params.productId)); } catch (error) { next(error); }
});
// Same logging policy as production auth: HTTP request log exists, body is never serialized.
app.post('/auth/login', (_req, res) => res.status(401).json({ status: 401 }));
app.use((_error, _req, res, _next) => res.status(500).json({ status: 500 }));
const server = app.listen(Number(process.env.OBS_PORT || 0), '0.0.0.0', () => { if (process.send) process.send({ port: server.address().port }); else console.error(`Observability API listening on ${server.address().port}`); });
const handleMessage = async message => {
  if (message === 'spans') {
    await provider.forceFlush();
    process.send({ spans: memoryExporter.getFinishedSpans().map(s => ({ traceId: s.spanContext().traceId,
      spanId: s.spanContext().spanId, parentSpanId: s.parentSpanContext?.spanId, kind: s.kind, status: s.status.code })) });
  }
  if (message === 'stop') {
    await new Promise(resolve => server.close(resolve));
    await provider.shutdown();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end(); process.exit(0);
  }
};
process.on('message', handleMessage);
process.on('SIGTERM', () => void handleMessage('stop'));
process.on('SIGINT', () => void handleMessage('stop'));
