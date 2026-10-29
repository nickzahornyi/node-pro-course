import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { configureApp } from '../configure-app.js';
import db from '../data-source.js';
import { authConfig } from './config.js';
import { passwordHash } from './auth.service.js';

// Own UUID fixture and ephemeral listening port: repeated runs never reset shared data.
authConfig();
const mode = process.argv[2];
assert(['auth','reuse','rbac'].includes(mode));
await db.initialize();
let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
const users: string[] = [];
const products: string[] = [];
const orders: string[] = [];
const jtis = new Set<string>();
const password = randomUUID();
let cleaning: Promise<void> | undefined;
function cleanup() {
  return cleaning ??= (async () => {
  await app?.close();
  await db.query('DELETE FROM access_denylist WHERE jti=ANY($1::uuid[])',[[...jtis]]);
  await db.query('DELETE FROM orders WHERE id=ANY($1::bigint[])',[orders]);
  await db.query('DELETE FROM products WHERE id=ANY($1::bigint[])',[products]);
  await db.query('DELETE FROM users WHERE id=ANY($1::bigint[])',[users]);
  await db.destroy();
  })();
}
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => {
  void cleanup().finally(() => process.exit(signal === 'SIGTERM' ? 143 : 130));
});

try {
  await db.runMigrations();
  async function user(role: string) {
    const email = `hw24-${randomUUID()}@example.test`;
    const [row] = await db.query('INSERT INTO users(email,display_name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [email,'HW24 demo',role,passwordHash(password)]);
    users.push(row.id);
    return {id:row.id,email};
  }
  const buyer = await user('buyer');
  const foreign = await user('buyer');
  const seller = await user('seller');
  const [product] = await db.query("INSERT INTO products(seller_id,name,price_cents,stock) VALUES($1,'HW24 demo',100,10) RETURNING id",[seller.id]);
  products.push(product.id);
  for (const owner of [buyer,foreign]) {
    const [order] = await db.query("INSERT INTO orders(user_id,status,total_cents) VALUES($1,'pending',100) RETURNING id",[owner.id]);
    orders.push(order.id);
    await db.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents) VALUES($1,$2,1,100)',[order.id,product.id]);
  }
  app = await NestFactory.create(AppModule,{bodyParser:false,logger:false});
  configureApp(app, false);
  await app.listen(0,'127.0.0.1');
  const base = await app.getUrl();
  async function request(path: string, method = 'GET', body?: unknown, token?: string) {
    const response = await fetch(base+path,{method,headers:{...(body ? {'content-type':'application/json'} : {}),...(token ? {authorization:`Bearer ${token}`} : {})},body:body ? JSON.stringify(body) : undefined});
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (data?.access_token) jtis.add(JSON.parse(Buffer.from(data.access_token.split('.')[1],'base64url').toString()).jti);
    return {status:response.status,data};
  }
  function check(key: string, response: {status:number}, expected: number) {
    console.log(`${key}=${response.status}`);
    assert.equal(response.status,expected,key);
  }
  const login = await request('/auth/login','POST',{email:buyer.email,password});
  if (mode !== 'rbac') check('login',login,200);
  assert.equal(login.status,200);
  const r1 = login.data;
  if (mode === 'auth') {
    check('no-token',await request(`/orders/${orders[0]}`),401);
    check('with-token',await request(`/orders/${orders[0]}`,'GET',undefined,r1.access_token),200);
    const refreshed = await request('/auth/refresh','POST',{refresh_token:r1.refresh_token});
    check('refresh',refreshed,200);
    const r2 = refreshed.data;
    check('logout',await request('/auth/logout','POST',undefined,r2.access_token),204);
    check('after-logout',await request(`/orders/${orders[0]}`,'GET',undefined,r2.access_token),401);
    check('refresh-after-logout',await request('/auth/refresh','POST',{refresh_token:r2.refresh_token}),401);
    // Verify actual denylist row as well as the externally observable rejection.
    const payload = JSON.parse(Buffer.from(r2.access_token.split('.')[1],'base64url').toString());
    const [denied] = await db.query('SELECT extract(epoch FROM expires_at)::bigint AS expiry FROM access_denylist WHERE jti=$1',[payload.jti]);
    assert.equal(Number(denied.expiry),payload.exp);
  } else if (mode === 'reuse') {
    const refreshed = await request('/auth/refresh','POST',{refresh_token:r1.refresh_token});
    check('r1-refresh',refreshed,200);
    check('r1-reuse',await request('/auth/refresh','POST',{refresh_token:r1.refresh_token}),401);
    check('r2-after-reuse',await request('/auth/refresh','POST',{refresh_token:refreshed.data.refresh_token}),401);
    assert.equal((await request(`/orders/${orders[0]}`,'GET',undefined,refreshed.data.access_token)).status,401);
    // Two simultaneous refreshes must not leave the winning descendant active.
    const race = (await request('/auth/login','POST',{email:buyer.email,password})).data;
    const responses = await Promise.all([1,2].map(() => request('/auth/refresh','POST',{refresh_token:race.refresh_token})));
    assert.deepEqual(responses.map(r => r.status).sort(),[200,401]);
    assert.equal((await request('/auth/refresh','POST',{refresh_token:responses.find(r=>r.status===200)!.data.refresh_token})).status,401);
  } else {
    check('anon',await request(`/orders/${orders[0]}`),401);
    check('own',await request(`/orders/${orders[0]}`,'GET',undefined,r1.access_token),200);
    check('foreign',await request(`/orders/${orders[1]}`,'GET',undefined,r1.access_token),403);
    const body = {name:'HW24 allowed',price_cents:123};
    check('role-denied',await request('/products','POST',body,r1.access_token),403);
    const privileged = await request('/auth/login','POST',{email:seller.email,password});
    const created = await request('/products','POST',body,privileged.data.access_token);
    if (created.data?.id) products.push(created.data.id);
    check('role-allowed',created,201);
    const t = r1.access_token.split('.');
    const p = JSON.parse(Buffer.from(t[1],'base64url').toString()); p.role='admin';
    t[1] = Buffer.from(JSON.stringify(p)).toString('base64url');
    check('tampered',await request('/products','POST',body,t.join('.')),401);
    assert.equal((await request('/auth/login','POST',{email:buyer.email,password:'wrong'})).status,401);
  }
} finally {
  await cleanup();
}
