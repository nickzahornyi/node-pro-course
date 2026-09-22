import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('secret bootstrap creates missing file and preserves rotated password', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-secret-test-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'db'));
    await copyFile(new URL('../scripts/prepare-secret.sh', import.meta.url), join(root, 'scripts/prepare-secret.sh'));
    await writeFile(join(root, 'db/db_password.example'), 'example-password\n');
    const run = () => execFileSync('sh', [join(root, 'scripts/prepare-secret.sh')]);
    run();
    assert.equal(await readFile(join(root, 'secrets/db_password'), 'utf8'), 'example-password\n');
    await writeFile(join(root, 'secrets/db_password'), 'rotated-password\n');
    run();
    assert.equal(await readFile(join(root, 'secrets/db_password'), 'utf8'), 'rotated-password\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
