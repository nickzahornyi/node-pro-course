import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';

let server;
let baseUrl;
before(() => new Promise((resolve) => {
  server = createApp().listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
after(() => new Promise((resolve) => server.close(resolve)));

test('validator requires Idempotency-Key', async () => {
  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ product_id: 'prod-1', quantity: 1 }] }),
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
  assert.match((await response.json()).detail, /idempotency-key/);
});

test('validator rejects empty items', async () => {
  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'empty' },
    body: JSON.stringify({ items: [] }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).detail, /fewer than 1 items/);
});

test('valid request is created and replayed idempotently', async () => {
  const options = {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
    body: JSON.stringify({ items: [{ product_id: 'prod-1', quantity: 2 }] }),
  };
  const created = await fetch(`${baseUrl}/orders`, options);
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.total_cents, 640000);
  const replayed = await fetch(`${baseUrl}/orders`, options);
  assert.equal(replayed.status, 201);
  assert.equal(replayed.headers.get('idempotency-replay'), 'true');
  assert.deepEqual(await replayed.json(), order);
});

test('reusing a key with another body returns 422 problem+json', async () => {
  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
    body: JSON.stringify({ items: [{ product_id: 'prod-2', quantity: 1 }] }),
  });
  assert.equal(response.status, 422);
  assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
});
