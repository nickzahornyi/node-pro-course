import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from '@jest/globals';
import { startDatabase } from './testkit.js';
import { aUser, aProduct, insertUser } from './builders.js';
import { ProductsRepository } from '../../dist/repositories/products.repository.js';
import { OrdersRepository } from '../../dist/repositories/orders.repository.js';

let database, client, products, orders, user;
beforeAll(async () => { database = await startDatabase(); });
afterAll(async () => { await database?.stop(); });
beforeEach(async () => {
  client = await database.pool.connect();
  await client.query('BEGIN');
  products = new ProductsRepository(client); orders = new OrdersRepository(client);
  user = await insertUser(client);
});
afterEach(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } });

describe('ProductsRepository / PostgreSQL', () => {
  it('creates and reads exact bigint price', async () => {
    const row = await products.create(aProduct(user.id));
    expect(await products.find(row.id)).toMatchObject({ id: row.id, price_cents: '1250', stock: 10 });
  });
  it('enforces seller foreign key constraint 23503', async () => {
    await expect(products.create(aProduct('999999999'))).rejects.toMatchObject({ code: '23503' });
  });
  it('joins the real seller and excludes another seller', async () => {
    await products.create(aProduct(user.id));
    const other = await insertUser(client);
    await products.create(aProduct(other.id));
    const result = await products.bySeller(user.id);
    expect(result).toHaveLength(1); expect(result[0].seller_name).toBe(user.display_name);
  });
  it('enforces case-insensitive unique seller email 23505', async () => {
    await expect(insertUser(client, aUser({ email: user.email.toUpperCase() }))).rejects.toMatchObject({ code: '23505' });
  });
});
describe('OrdersRepository / PostgreSQL', () => {
  it('creates an order and reads the full JOIN graph', async () => {
    const p = await products.create(aProduct(user.id));
    const order = await orders.create(user.id, [{ product_id: p.id, quantity: 2 }]);
    expect(await orders.find(order.id)).toEqual({ id: order.id, status: 'created', total_cents: 2500,
      items: [{ product_id: p.id, quantity: 2, unit_price_cents: 1250 }] });
  });
  it('aggregates totals with SQL SUM without float arithmetic', async () => {
    const p = await products.create(aProduct(user.id));
    await orders.create(user.id, [{ product_id: p.id, quantity: 2 }]);
    await orders.create(user.id, [{ product_id: p.id, quantity: 3 }]);
    expect(await orders.totalForUser(user.id)).toBe('6250');
    const page = await orders.list('0', 1);
    expect(page).toHaveLength(1); expect(page[0].items[0].quantity).toBe(2);
  });
  it('rejects an unknown buyer via foreign key 23503', async () => {
    const p = await products.create(aProduct(user.id));
    await expect(orders.create('999999999', [{ product_id: p.id, quantity: 1 }])).rejects.toMatchObject({ code: '23503' });
  });
  it('returns null for absent and malformed IDs', async () => {
    expect(await orders.find('999999999')).toBeNull(); expect(await orders.find('not-an-id')).toBeNull();
  });
});
