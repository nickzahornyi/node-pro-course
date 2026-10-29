import {beforeAll, afterAll, beforeEach, it, expect} from '@jest/globals';
import {createHmac, randomUUID} from 'node:crypto';
import {startDatabase, startApplication, truncate} from './testkit.js';
import {insertUser} from './builders.js';
import {AuthService} from '../../dist/auth/auth.service.js';

let database, app, auth, user;
const ago = minutes => new Date(Date.now() - minutes * 60000);
beforeAll(async () => {
  database = await startDatabase();
  app = await startApplication(database);
  auth = app.get(AuthService);
});
afterAll(async () => { try { await app?.close(); } finally { await database?.stop(); } });
beforeEach(async () => {
  await truncate(database.pool);
  await database.pool.query('TRUNCATE access_denylist');
  user = await insertUser(database.pool);
});
async function family(age = 11, revokedAge) {
  const id = randomUUID();
  await database.pool.query('INSERT INTO auth_families(id,user_id,created_at,revoked_at) VALUES($1,$2,$3,$4)',[id,user.id,ago(age),revokedAge === undefined ? null : ago(revokedAge)]);
  return id;
}
async function refresh(id, expiryMinutesAgo, used = false) {
  const token = randomUUID();
  const hash = createHmac('sha256',database.env.REFRESH_TOKEN_PEPPER).update(token).digest('hex');
  await database.pool.query('INSERT INTO refresh_tokens(token_hash,family_id,expires_at,used_at) VALUES($1,$2,$3,$4)',[hash,id,ago(expiryMinutesAgo),used ? ago(60) : null]);
  return token;
}
const exists = async id => (await database.pool.query('SELECT id FROM auth_families WHERE id=$1',[id])).rowCount > 0;

it('removes expired families and refresh rows, expires denylist but preserves live entries', async () => {
  const id = await family();
  const token = await refresh(id,1);
  const expired = randomUUID(), live = randomUUID();
  await database.pool.query('INSERT INTO access_denylist VALUES($1,$2),($3,$4)',[expired,ago(1),live,ago(-1)]);
  await auth.cleanupExpiredAuth();
  expect(await exists(id)).toBe(false);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM refresh_tokens')).rows[0].n).toBe(0);
  expect((await database.pool.query('SELECT jti FROM access_denylist')).rows.map(r=>r.jti)).toEqual([live]);
  await expect(auth.refresh(token)).rejects.toMatchObject({status:401});
});

it('keeps expired used ancestors while a descendant lives, preserving reuse detection', async () => {
  const id = await family();
  const ancestor = await refresh(id,1,true), descendant = await refresh(id,-60);
  await auth.cleanupExpiredAuth();
  expect(await exists(id)).toBe(true);
  expect((await database.pool.query('SELECT count(*)::int AS n FROM refresh_tokens')).rows[0].n).toBe(2);
  await expect(auth.refresh(ancestor)).rejects.toMatchObject({status:401});
  await expect(auth.refresh(descendant)).rejects.toMatchObject({status:401});
  expect((await database.pool.query('SELECT revoked_at FROM auth_families WHERE id=$1',[id])).rows[0].revoked_at).not.toBeNull();
});

it('retains ten-minute grace for revoked and access-only families', async () => {
  const old = await family(60,11), recent = await family(60,9);
  await refresh(old,-60); await refresh(recent,-60);
  const emptyOld = await family(11), emptyRecent = await family(9);
  const revokedExpired = await family(60,9);
  await refresh(revokedExpired,1);
  await auth.cleanupExpiredAuth();
  expect(await exists(old)).toBe(false);
  expect(await exists(recent)).toBe(true);
  expect(await exists(emptyOld)).toBe(false);
  expect(await exists(emptyRecent)).toBe(true);
  expect(await exists(revokedExpired)).toBe(true);
});

it('skips families locked by refresh/logout, then collects them after release', async () => {
  const id = await family();
  await refresh(id,1);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM auth_families WHERE id=$1 FOR UPDATE',[id]);
    await auth.cleanupExpiredAuth();
    expect(await exists(id)).toBe(true);
  } finally { await client.query('ROLLBACK'); client.release(); }
  await auth.cleanupExpiredAuth();
  expect(await exists(id)).toBe(false);
});
