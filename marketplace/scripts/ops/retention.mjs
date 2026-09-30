import { readdir, readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

const bundlePattern = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}$/;
const dumpPattern = /^marketplace-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.dump$/;

export function retentionDays(value = '7') {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 36500) {
    throw new Error('BACKUP_RETENTION_DAYS must be an integer from 1 to 36500');
  }
  return Number(value);
}

export async function pruneBackups(directory, days, protectedBundle, now = Date.now()) {
  retentionDays(String(days));
  const completed = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // Never follow symlinks, enter partial bundles or delete unrelated directories.
    if (!entry.isDirectory() || !bundlePattern.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      if (!(await lstat(join(path, 'manifest.json'))).isFile()) continue;
      const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
      const created = Date.parse(manifest.createdAt);
      if (manifest.version !== 1 || !Number.isFinite(created) || !dumpPattern.test(manifest.dump)
        || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !manifest.controls) continue;
      const dump = await lstat(join(path, manifest.dump));
      if (!dump.isFile() || dump.size !== manifest.bytes || dump.size === 0) continue;
      completed.push({ name: entry.name, path, created });
    } catch { /* Incomplete/malformed artifacts are not retention candidates. */ }
  }
  completed.sort((a, b) => b.created - a.created || b.name.localeCompare(a.name));
  const newest = completed[0]?.name;
  const removed = [];
  for (const bundle of completed) {
    if (bundle.name === newest || bundle.name === protectedBundle || bundle.created >= now - days * 86400000) continue;
    await rm(bundle.path, { recursive: true });
    removed.push(bundle.name);
  }
  return removed;
}
