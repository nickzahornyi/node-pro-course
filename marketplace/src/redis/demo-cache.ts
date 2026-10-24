import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AdvancedConsoleLogger } from 'typeorm';
import dataSource from '../data-source.js';
import { ProductsRepository } from '../repositories/products.repository.js';
import { AsideCache, RELEASE_LOCK } from './cache.js';
import { connectRedis, requiredUrl } from './connection.js';
import { printMetrics, removePrefix } from './demo-utils.js';

// TypeORM invokes this for every SQL statement actually sent, including cache misses.
class Counter extends AdvancedConsoleLogger {
  count = 0;
  override logQuery() { this.count++; }
}
const counter = new Counter(['query']);
dataSource.setOptions({ logger: counter, logging: ['query'] });
const prefix = `hw23:cache:${randomUUID()}:`;
const clients = Array.from({ length: 4 }, () => connectRedis(requiredUrl('REDIS_URL')));
let sellerId: string | undefined;
try {
  await Promise.all(clients.map(client => client.connect()));
  await dataSource.initialize();
  const [seller] = await dataSource.query(`INSERT INTO users(email,display_name)
    VALUES($1,'HW23 cache demo') RETURNING id`, [`${randomUUID()}@hw23.invalid`]);
  sellerId = seller.id;
  const products: { id: string }[] = await dataSource.query(`INSERT INTO products(seller_id,name,price_cents,stock)
    SELECT $1,'HW23 card '||n,100,10 FROM generate_series(1,64) n RETURNING id`, [sellerId]);
  const repository = new ProductsRepository({ query: async (sql, parameters) => ({ rows: await dataSource.query(sql, parameters) }) });
  const caches = clients.map(client => new AsideCache(client, prefix));
  await Promise.all(products.map(product => caches[0].get(product.id, () => repository.card(product.id))));
  const ttls = await Promise.all(products.map(product => clients[0].ttl(caches[0].key(product.id))));
  assert(ttls.every(ttl => ttl > 0 && ttl <= 360));
  const distinct = new Set(ttls).size;
  assert(distinct >= 5);

  const id = products[0].id, key = caches[0].key(id);
  await clients[0].del(key);
  counter.count = 0;
  const concurrent = 30;
  const cards = await Promise.all(Array.from({ length: concurrent }, (_, i) => caches[i % caches.length].get(id, () => repository.card(id))));
  const coldCalls = counter.count;
  assert(cards.every(card => card?.id === id));
  assert.equal(coldCalls, 1);
  counter.count = 0;
  await Promise.all(Array.from({ length: 100 }, (_, i) => caches[i % caches.length].get(id, () => repository.card(id))));
  assert.equal(counter.count, 0);

  // A stale owner cannot release a successor's lease.
  await clients[0].set(`lock:${key}`, 'successor', 'PX', 10000);
  assert.equal(await clients[0].eval(RELEASE_LOCK, 1, `lock:${key}`, 'expired-owner'), 0);
  assert.equal(await clients[0].get(`lock:${key}`), 'successor');
  const policy = await clients[0].config('GET', 'maxmemory-policy') as string[];
  const memory = await clients[0].config('GET', 'maxmemory') as string[];
  assert.equal(policy[1], 'allkeys-lru'); assert(Number(memory[1]) > 0);
  printMetrics({ 'cache-lru': Number(policy[1] === 'allkeys-lru'), 'cache-maxmemory': Number(Number(memory[1]) > 0),
    warmed: products.length, 'ttl-distinct': distinct, concurrent, 'db-calls': coldCalls, 'db-calls-warm': counter.count });
} finally {
  if (clients[0].status === 'ready') {
    await removePrefix(clients[0], prefix);
    await removePrefix(clients[0], `lock:${prefix}`);
  }
  clients.forEach(client => client.disconnect());
  if (dataSource.isInitialized) {
    if (sellerId) {
      await dataSource.query('DELETE FROM products WHERE seller_id=$1', [sellerId]);
      await dataSource.query('DELETE FROM users WHERE id=$1', [sellerId]);
    }
    await dataSource.destroy();
  }
}
