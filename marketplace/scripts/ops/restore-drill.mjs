import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { controlSql, run, sha256 } from './common.mjs';

// Offline drill: deliberately never connect to, or mutate, the source database.
const started = performance.now();
const directory = resolve(process.env.BACKUP_DIR || 'backups');
const candidates = (await readdir(directory, { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && entry.name.startsWith('backup-')).map(entry => entry.name).sort();
if (!candidates.length) throw new Error('No completed backup; run scripts/backup.sh first');
const bundle = resolve(directory, candidates.at(-1));
const manifest = JSON.parse(await readFile(resolve(bundle, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, 1);
assert.equal(basename(manifest.dump), manifest.dump, 'Invalid dump filename');
const dump = resolve(bundle, manifest.dump);
assert.equal((await stat(dump)).size, manifest.bytes, 'Dump size mismatch');
assert.equal(await sha256(dump), manifest.sha256, 'Dump checksum mismatch');
const name = `marketplace-drill-${randomUUID()}`;
const volume = `${name}-data`;
let volumeCreated = false;
let containerCreated = false;
const cleanup = async () => {
  if (containerCreated) { await run('docker', ['rm', '-f', name]); containerCreated = false; }
  if (volumeCreated) { await run('docker', ['volume', 'rm', volume]); volumeCreated = false; }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  cleanup().then(() => process.exit(1), error => { console.error(error); process.exit(1); });
});
try {
  await run('docker', ['volume', 'create', '--label', 'marketplace.restore-drill=true', volume]);
  volumeCreated = true;
  await run('docker', ['create', '--name', name, '--network', 'none',
    '--mount', `type=volume,src=${volume},dst=/var/lib/postgresql/data`,
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=restore', '-e', 'POSTGRES_DB=restore',
    'postgres:17-alpine']);
  containerCreated = true;
  await run('docker', ['start', name]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    // TCP excludes the temporary socket-only server used by the image during initdb.
    try { await run('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'restore', '-d', 'restore']); ready = true; break; }
    catch { await delay(500); }
  }
  assert.ok(ready, 'Restore PostgreSQL did not become ready');
  const psql = ['exec', name, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'restore', '-d', 'restore'];
  assert.equal(await run('docker', [...psql, '-c', "SELECT count(*) FROM pg_tables WHERE schemaname='public'"]), '0');
  const restoreStarted = performance.now();
  await run('docker', ['exec', '-i', name, 'pg_restore', '--exit-on-error', '--single-transaction',
    '--no-owner', '--no-acl', '-U', 'restore', '-d', 'restore'], { inputFile: dump });
  const restoreSeconds = (performance.now() - restoreStarted) / 1000;
  const actual = JSON.parse(await run('docker', [...psql, '-c', controlSql]));
  assert.deepEqual(actual, manifest.controls, 'RESTORE MISMATCH');
  const report = { result: 'MATCH', checkedAt: new Date().toISOString(), dump, bytes: manifest.bytes,
    restoreSeconds, rtoSeconds: (performance.now() - started) / 1000,
    rpoHours: 24, controls: actual, container: name, volume };
  await writeFile(resolve(bundle, `restore-${Date.now()}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await cleanup(); }
console.log('MATCH — temporary container and volume removed');
