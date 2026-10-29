// Operator-only helper for the realtime demo; never exposed as an HTTP route.
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { authConfig } from '../auth/config.js';
import dataSource from '../data-source.js';
const config = authConfig();
const id = process.argv[2];
if (!id || !/^[1-9]\d*$/.test(id)) throw new Error('A numeric user ID is required');
await dataSource.initialize();
try {
  const [user] = await dataSource.query('SELECT id,role FROM users WHERE id=$1',[id]);
  if (!user) throw new Error('User not found');
  const family = randomUUID();
  const token = await new SignJWT({role:user.role,family_id:family})
    .setProtectedHeader({alg:'ES256',kid:config.JWT_KID,typ:'JWT'}).setSubject(id)
    .setIssuer('marketplace').setAudience('marketplace-api').setJti(randomUUID())
    .setIssuedAt().setExpirationTime('10m').sign(config.privateKey);
  await dataSource.query('INSERT INTO auth_families(id,user_id) VALUES($1,$2)',[family,id]);
  // Explicit token output is the purpose of this operator command; application logs never contain it.
  console.log(token);
} finally { await dataSource.destroy(); }
