import { mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { run } from './common.mjs';
import { retentionDays, pruneBackups } from './retention.mjs';

const source = process.env.DB_URL || process.env.DATABASE_URL;
if (!source) throw new Error('Set DB_URL via with-secrets.sh or the Grading exports');
const directory = resolve(process.env.BACKUP_DIR || 'backups');
const days = retentionDays(process.env.BACKUP_RETENTION_DAYS);
await mkdir(directory, { recursive: true, mode: 0o700 });
const env = { ...process.env, DB_URL: source, BACKUP_DIR: directory };
if (!env.DB_PASSWORD && env.DB_PASSWORD_FILE) env.DB_PASSWORD = (await readFile(env.DB_PASSWORD_FILE, 'utf8')).trim();
const result = await run('docker', ['compose', 'run', '--rm', '-T', '--no-deps',
  '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'DB_URL', '-e', 'DB_PASSWORD',
  'ops', 'node', 'scripts/ops/backup.mjs'], { env });
// The container returns a relative artifact name, not a host-inaccessible container path.
const relative = JSON.parse(result).artifact;
console.log(resolve(directory, relative));
const removed = await pruneBackups(directory, days, basename(dirname(relative)));
console.error(`Retention (${days} days): removed ${removed.length} completed backup bundle(s)`);
for (const name of removed) console.error(`Removed: ${name}`);
