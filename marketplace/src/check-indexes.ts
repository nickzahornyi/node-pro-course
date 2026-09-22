import dataSource from './data-source.js';
import { checkIndexContract } from './index-contract.js';

await dataSource.initialize();
try {
  await checkIndexContract(dataSource);
  console.log('Manual index contract: 4/4 OK');
} finally {
  await dataSource.destroy();
}
