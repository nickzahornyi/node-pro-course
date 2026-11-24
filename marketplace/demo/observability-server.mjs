import { generateKeyPairSync, randomBytes } from 'node:crypto';
// Isolated process/registry/ALS/exporter for every run, using production HTTP and domain layers.
if (process.send) process.env.OBS_DEMO = '1';
await import('../dist/observability/telemetry.js');
await import('reflect-metadata');
const { default: express } = await import('express');
const { Pool } = await import('pg');
const { observeHttp, buckets } = await import('../dist/observability/http.js');
const { provider, memoryExporter } = await import('../dist/observability/telemetry.js');
const { MarketplaceController } = await import('../dist/marketplace.controller.js');
const { ProductsRepository } = await import('../dist/repositories/products.repository.js');
const { CachedProductsService } = await import('../dist/redis/products.service.js');
const { AuthController } = await import('../dist/auth/http.js');
const { AuthService, passwordHash } = await import('../dist/auth/auth.service.js');
// Ephemeral fixture keys stay in this process; no production auth secrets are needed.
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
Object.assign(process.env, {
  JWT_KID: 'observability-demo',
  JWT_PRIVATE_KEY: Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
  JWT_PUBLIC_KEY: Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
  REFRESH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
  JWT_PREVIOUS_PUBLIC_KEYS: '',
});
const pool = new Pool({ connectionString: process.env.OBS_DB_URL || 'postgresql://observability:observability@127.0.0.1:22932/observability', max: 12 });
const schema = `demo_${process.pid}_${Date.now()}`;
await pool.query(`CREATE SCHEMA ${schema}`);
await pool.query(`CREATE TABLE ${schema}.users(id bigint PRIMARY KEY, display_name text, email text, password_hash text, role text NOT NULL DEFAULT 'buyer');
CREATE TABLE ${schema}.products(id bigint PRIMARY KEY,name text,price_cents bigint,stock int,seller_id bigint);
CREATE TABLE ${schema}.orders(id bigint PRIMARY KEY,status text);
CREATE TABLE ${schema}.order_items(product_id bigint,order_id bigint,quantity int);
CREATE TABLE ${schema}.auth_families(id uuid PRIMARY KEY, user_id bigint NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ${schema}.refresh_tokens(token_hash text PRIMARY KEY, family_id uuid NOT NULL REFERENCES ${schema}.auth_families(id) ON DELETE CASCADE,
  used_at timestamptz, revoked_at timestamptz, expires_at timestamptz NOT NULL);
CREATE TABLE ${schema}.access_denylist(jti uuid PRIMARY KEY, expires_at timestamptz NOT NULL);
INSERT INTO ${schema}.users(id,display_name,email) VALUES(1,'Demo seller','demo@example.invalid');
INSERT INTO ${schema}.products SELECT id,'Demo product',100,10,1 FROM generate_series(1,1000) AS id`);
await pool.query(`UPDATE ${schema}.users SET password_hash=$1 WHERE id=1`,
  [passwordHash(process.env.OBS_DEMO_PASSWORD || randomBytes(32).toString('hex'))]);
const db = { async transaction(operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${schema}`);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}, async query(sql, args) {
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
// Invoke the real HW-24 controller/service with SQL-backed auth state, like the product route above.
const authService = new AuthService(db);
const authController = new AuthController(authService);
app.post('/auth/login', async (req, res, next) => {
  try { res.status(200).json(await authController.login(req.body)); } catch (error) { next(error); }
});
app.use((error, _req, res, _next) => {
  const status = error.getStatus?.() || 500;
  res.status(status).json({ status });
});
const server = app.listen(Number(process.env.OBS_PORT || 0), '0.0.0.0', () => { if (process.send) process.send({ port: server.address().port, buckets }); else console.error(`Observability API listening on ${server.address().port}`); });
const handleMessage = async message => {
  if (message === 'spans') {
    await provider.forceFlush();
    process.send({ spans: memoryExporter.getFinishedSpans().map(s => ({ traceId: s.spanContext().traceId,
      spanId: s.spanContext().spanId, parentSpanId: s.parentSpanContext?.spanId, kind: s.kind, status: s.status.code })) });
  }
  if (message === 'stop') {
    await new Promise(resolve => server.close(resolve));
    authService.onModuleDestroy();
    await provider.shutdown();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end(); process.exit(0);
  }
};
process.on('message', handleMessage);
process.on('SIGTERM', () => void handleMessage('stop'));
process.on('SIGINT', () => void handleMessage('stop'));
