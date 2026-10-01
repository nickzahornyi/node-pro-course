import 'reflect-metadata';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function startDatabase() {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const uri = new URL(container.getConnectionUri());
  const password = decodeURIComponent(uri.password);
  uri.password = '';
  const env = { ...process.env, NODE_ENV: 'test', DB_URL: uri.toString(), DB_PASSWORD: password };
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
  await pool.query('TRUNCATE order_requests,jobs,order_items,orders,products,users RESTART IDENTITY CASCADE');
}
