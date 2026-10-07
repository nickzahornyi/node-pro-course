import { Verifier } from '@pact-foundation/pact';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startDatabase, startApplication, truncate } from '../integration/testkit.js';

const database = await startDatabase();
let app;
try {
  app = await startApplication(database);
  const brokerUrl = process.env.PACT_BROKER_URL;
  const options = brokerUrl ? {
    pactBrokerUrl: brokerUrl,
    ...(process.env.PACT_BROKER_TOKEN ? { pactBrokerToken: process.env.PACT_BROKER_TOKEN } : {}),
    consumerVersionSelectors: [{ latest: true }], publishVerificationResult: true,
    providerVersion: process.env.PROVIDER_VERSION || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  } : { pactUrls: [resolve('pacts/MarketplaceWeb-MarketplaceAPI.json')] };
  await new Verifier({ ...options, provider: 'MarketplaceAPI', providerBaseUrl: await app.getUrl(),
    stateHandlers: {
      'a product with ID 7 exists': async () => {
        await truncate(database.pool);
        await database.pool.query(`INSERT INTO users(id,email,display_name) OVERRIDING SYSTEM VALUE
          VALUES(1,'pact-seller@example.test','Pact seller') ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name`);
        await database.pool.query(`INSERT INTO products(id,seller_id,name,price_cents,stock) OVERRIDING SYSTEM VALUE
          VALUES(7,1,'Mechanical keyboard',320000,10) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,price_cents=EXCLUDED.price_cents`);
      },
    },
  }).verifyProvider();
} finally { try { await app?.close(); } finally { await database.stop(); } }
