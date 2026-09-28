import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const exec = promisify(execFile);
test('backup archive, repeated drill, mismatch and corruption are checked; no leaked drill volumes', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marketplace-ops-test-'));
  const env = { ...process.env, BACKUP_DIR: directory };
  const volumes = async () => (await exec('docker', ['volume', 'ls', '-q', '--filter', 'label=marketplace.restore-drill=true'])).stdout.trim();
  const before = await volumes();
  try {
    const backup = (await exec('bash', ['scripts/backup.sh'], { env })).stdout.trim();
    const manifestPath = join(dirname(backup), 'manifest.json');
    const original = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(original);
    assert.ok(manifest.bytes > 0);
    assert.ok(BigInt(manifest.controls.orders) > 0n, 'Test requires seeded orders');
    for (let i = 0; i < 2; i++) {
      const result = await exec('bash', ['scripts/restore-drill.sh'], { env });
      assert.match(result.stdout, /MATCH — temporary container and volume removed/);
      assert.equal(await volumes(), before);
    }
    manifest.controls.orders = String(BigInt(manifest.controls.orders) + 1n);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(exec('bash', ['scripts/restore-drill.sh'], { env }), error => {
      assert.match(error.stderr, /RESTORE MISMATCH/);
      return error.code !== 0;
    });
    assert.equal(await volumes(), before);
    await writeFile(manifestPath, original);
    const archive = await readFile(backup);
    archive[0] ^= 1;
    await writeFile(backup, archive);
    await assert.rejects(exec('bash', ['scripts/restore-drill.sh'], { env }), error => {
      assert.match(error.stderr, /Dump checksum mismatch/);
      return error.code !== 0;
    });
    assert.equal(await volumes(), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
