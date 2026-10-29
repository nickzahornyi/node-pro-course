import 'reflect-metadata';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

export async function startDatabase() {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const uri = new URL(container.getConnectionUri());
  const password = decodeURIComponent(uri.password);
  uri.password = '';
  const keys = generateKeyPairSync('ec',{namedCurve:'P-256'});
  const env = { JWT_KID:'test', JWT_PRIVATE_KEY:Buffer.from(keys.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'), JWT_PUBLIC_KEY:Buffer.from(keys.publicKey.export({type:'spki',format:'pem'})).toString('base64'), REFRESH_TOKEN_PEPPER:randomBytes(32).toString('hex'), ...process.env, NODE_ENV: 'test', DB_URL: uri.toString(), DB_PASSWORD: password, AUTH_SECRET: randomBytes(32).toString('hex'), BROKER_URL: '' };
  const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  try {
    await promisify(execFile)(process.execPath, ['node_modules/typeorm/cli.js', 'migration:run', '-d', 'dist/data-source.js'], { env });
    return { pool, env, container, async stop() { try { await pool.end(); } finally { await container.stop(); } } };
  } catch (error) { await pool.end(); await container.stop(); throw error; }
}

export async function startApplication(database) {
  // Set environment before importing AppModule: ConfigModule evaluates on import.
  Object.assign(process.env, database.env);
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../../dist/app.module.js');
  const { configureApp } = await import('../../dist/configure-app.js');
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication({ bodyParser: false, logger: false });
  configureApp(app);
  try { await app.listen(0, '127.0.0.1'); return app; }
  catch (error) { await app.close(); throw error; }
}

export async function truncate(pool) {
  await pool.query('TRUNCATE outbox,processed_messages,order_requests,jobs,order_items,orders,products,users RESTART IDENTITY CASCADE');
}

export async function accessFor(database, app, userId) {
  const {AuthService,passwordHash} = await import('../../dist/auth/auth.service.js');
  const password = randomBytes(24).toString('hex');
  const {rows:[user]} = await database.pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING email',[passwordHash(password),userId]);
  return (await app.get(AuthService).login(user.email,password)).access_token;
}
