import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSourceUrl } from '../scripts/ops/source-url.mjs';
import { pruneBackups, retentionDays } from '../scripts/ops/retention.mjs';

test('backup supports both published endpoints without changing remote URLs', () => {
  for (const [port, host, targetPort] of [['5432', 'db', '5432'], ['6432', 'pgbouncer', '6432']]) {
    const url = resolveSourceUrl(`postgresql://user@localhost:${port}/shop`, {});
    assert.equal(url.hostname, host); assert.equal(url.port, targetPort);
  }
  const env = { LOCAL_POSTGRES_PORT: '55441', LOCAL_PGBOUNCER_PORT: '56441' };
  assert.equal(resolveSourceUrl('postgresql://user@127.0.0.1:55441/shop', env).hostname, 'db');
  assert.equal(resolveSourceUrl('postgresql://user@[::1]:56441/shop', env).hostname, 'pgbouncer');
  assert.equal(resolveSourceUrl('postgresql://user@remote:5433/shop', env).hostname, 'remote');
  assert.throws(() => resolveSourceUrl('postgresql://user@localhost:1111/shop', env), /published/);
});

test('retention defaults to seven days and rejects unsafe inputs', () => {
  assert.equal(retentionDays(), 7);
  assert.equal(retentionDays('30'), 30);
  for (const value of ['0', '-1', '1.5', '', 'NaN', '36501']) assert.throws(() => retentionDays(value));
});

test('retention removes only expired completed bundles; newest and protected always survive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marketplace-retention-'));
  const name = n => `backup-2000-01-0${n}T00-00-00.000Z-12345678`;
  const dump = 'marketplace-2000-01-01T00-00-00.000Z.dump';
  try {
    for (let n = 1; n <= 4; n++) {
      await mkdir(join(directory, name(n)));
      await writeFile(join(directory, name(n), dump), 'dump');
      await writeFile(join(directory, name(n), 'manifest.json'), JSON.stringify({ version: 1,
        createdAt: `2000-01-0${n}T00:00:00Z`, dump, bytes: 4, sha256: 'a'.repeat(64), controls: {} }));
    }
    await writeFile(join(directory, name(3), 'manifest.json'), 'invalid');
    await mkdir(join(directory, '.partial-example'));
    await mkdir(join(directory, 'unrelated'));
    await symlink(join(directory, name(1)), join(directory, 'backup-1999-01-01T00-00-00.000Z-12345678'));
    assert.deepEqual(await pruneBackups(directory, 7, name(2), Date.parse('2026-09-30')), [name(1)]);
    const remaining = await readdir(directory);
    for (const keep of [name(2), name(3), name(4), '.partial-example', 'unrelated', 'backup-1999-01-01T00-00-00.000Z-12345678']) assert.ok(remaining.includes(keep));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
