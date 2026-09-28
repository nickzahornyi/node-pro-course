import pg from 'pg';
import { mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { controlSql, run, sha256 } from './common.mjs';

const url = new URL(process.env.DB_URL);
if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected PostgreSQL DB_URL');
if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  if ((url.port || '5432') !== (process.env.LOCAL_PGBOUNCER_PORT || '6432')) {
    throw new Error('Local DB_URL must point to the published PgBouncer port');
  }
  url.hostname = 'pgbouncer'; url.port = '6432';
}
const password = process.env.DB_PASSWORD || decodeURIComponent(url.password);
url.password = '';
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username), PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' };
if (url.search) throw new Error('URL query parameters are unsupported by this local dev backup runner');
const client = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT), user: env.PGUSER,
  database: env.PGDATABASE, password, connectionTimeoutMillis: 10000 });
const snapshotAt = new Date().toISOString();
const stamp = snapshotAt.replaceAll(':', '-');
const name = `backup-${stamp}-${randomUUID().slice(0, 8)}`;
const staging = `/backups/.partial-${name}`;
const dumpName = `marketplace-${stamp}.dump`;
await mkdir(staging, { mode: 0o700 });
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: [snapshot] } = await client.query('SELECT pg_export_snapshot() AS id');
  const { rows: [{ controls }] } = await client.query(controlSql);
  await run('pg_dump', ['-Fc', '--no-owner', '--no-acl', `--snapshot=${snapshot.id}`, '-f', `${staging}/${dumpName}`], { env });
  await client.query('COMMIT');
  await run('pg_restore', ['--list', `${staging}/${dumpName}`]);
  const manifest = { version: 1, createdAt: new Date().toISOString(), snapshotAt,
    dump: dumpName, bytes: (await stat(`${staging}/${dumpName}`)).size,
    sha256: await sha256(`${staging}/${dumpName}`), controls };
  await writeFile(`${staging}/manifest.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await rename(staging, `/backups/${name}`);
  console.log(JSON.stringify({ artifact: `${name}/${dumpName}` }));
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
} finally { await client.end(); }
