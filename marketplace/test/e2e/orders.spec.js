import { beforeAll, afterAll, beforeEach, it, expect } from '@jest/globals';
import request from 'supertest';
import { startDatabase, startApplication, truncate, accessFor } from '../integration/testkit.js';
import { aProduct, insertUser } from '../integration/builders.js';
import { ProductsRepository } from '../../dist/repositories/products.repository.js';

let database, app, product, token;
beforeAll(async () => { database = await startDatabase(); app = await startApplication(database); });
afterAll(async () => { try { await app?.close(); } finally { await database?.stop(); } });
beforeEach(async () => {
  await truncate(database.pool);
  const user = await insertUser(database.pool);
  token = await accessFor(database, app, user.id);
  product = await new ProductsRepository(database.pool).create(aProduct(user.id));
});
it('POST creates a persisted order; GET reads it; replay survives application restart', async () => {
  const body = { items: [{ product_id: product.id, quantity: 2 }] };
  const created = await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'e2e-create').send(body).expect(201);
  expect(created.body.total_cents).toBe(2500);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(1);
  await app.close(); app = await startApplication(database);
  const read = await request(app.getHttpServer()).get(`/orders/${created.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
  expect(read.body).toEqual(created.body);
  const replay = await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'e2e-create').send(body).expect(201);
  expect(replay.headers['idempotency-replay']).toBe('true'); expect(replay.body).toEqual(created.body);
});
it('unknown order returns documented 404 problem', async () => {
  const response = await request(app.getHttpServer()).get('/orders/999999').set('Authorization', `Bearer ${token}`).expect(404);
  expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
});
it('OpenAPI rejects an invalid body with 400 and creates no order', async () => {
  await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'invalid').send({ items: [] }).expect(400);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(0);
});
it('concurrent identical keys create only one order; changed body returns 422', async () => {
  const body = { items: [{ product_id: product.id, quantity: 1 }] };
  const responses = await Promise.all(Array.from({ length: 5 }, () => request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'race').send(body).expect(201)));
  expect(new Set(responses.map(r => r.body.id)).size).toBe(1);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(1);
  await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'race').send({ items: [{ product_id: product.id, quantity: 2 }] }).expect(422);
});

it('different intent keys preserve two legitimate identical orders and two events', async () => {
  const body = { items: [{ product_id: product.id, quantity: 1 }] };
  const first = await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'intent-one').send(body).expect(201);
  const second = await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'intent-two').send(body).expect(201);
  expect(first.body.id).not.toBe(second.body.id);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(2);
});
