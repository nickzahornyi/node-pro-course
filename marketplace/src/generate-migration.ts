import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dataSource from './data-source.js';
import { checkIndexContract } from './index-contract.js';

await dataSource.initialize();
try {
  await checkIndexContract(dataSource, true);
} finally {
  await dataSource.destroy();
}
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/typeorm/cli.js', import.meta.url)),
  'migration:generate', '-d', 'dist/data-source.js', ...process.argv.slice(2),
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
