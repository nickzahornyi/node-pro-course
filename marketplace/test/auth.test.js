import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {SignJWT} from 'jose';
import {AuthService} from '../dist/auth/auth.service.js';

const pair = () => generateKeyPairSync('ec',{namedCurve:'P-256'});
const keys = pair(), previous = pair();
Object.assign(process.env,{
 JWT_KID:'current-test',
 JWT_PRIVATE_KEY:Buffer.from(keys.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'),
 JWT_PUBLIC_KEY:Buffer.from(keys.publicKey.export({type:'spki',format:'pem'})).toString('base64'),
 JWT_PREVIOUS_PUBLIC_KEYS:JSON.stringify({'previous-test':Buffer.from(previous.publicKey.export({type:'spki',format:'pem'})).toString('base64')}),
 REFRESH_TOKEN_PEPPER:'test-only-pepper-more-than-16-characters',
});

test('JWT verification rejects expired tokens, algorithm confusion, wrong audience and unknown kid; accepts overlap key', async () => {
 let reads = 0;
 const auth = new AuthService({async query() { reads++; return {rows:[{revoked_at:null,denied:false}]}; }});
 async function token({alg='ES256',kid='current-test',aud='marketplace-api',exp='10m',key=keys.privateKey}={}) {
  return new SignJWT({role:'buyer',family_id:randomUUID()}).setProtectedHeader({alg,kid,typ:'JWT'})
   .setSubject('42').setIssuer('marketplace').setAudience(aud).setJti(randomUUID()).setIssuedAt().setExpirationTime(exp).sign(key);
 }
 try {
  for (const options of [{exp:1},{alg:'HS256',key:Buffer.alloc(32,1)},{aud:'another-api'},{kid:'unknown'}]) {
   await assert.rejects(auth.authenticate(await token(options)),e=>e.getStatus()===401);
  }
  assert.equal(reads,0,'invalid JWT must never reach authorization storage');
  assert.equal((await auth.authenticate(await token())).userId,'42');
  assert.equal((await auth.authenticate(await token({kid:'previous-test',key:previous.privateKey}))).userId,'42');
 } finally { auth.onModuleDestroy(); }
});

test('bare entrypoint names missing auth configuration before any database connection', () => {
 const env = {...process.env};
 for (const name of ['JWT_KID','JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','REFRESH_TOKEN_PEPPER','DB_URL']) delete env[name];
 const result = spawnSync(process.execPath,['dist/main.js'],{env,encoding:'utf8',timeout:10000});
 assert.notEqual(result.status,null);
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/JWT_PRIVATE_KEY/);
 assert.doesNotMatch(result.stderr,/ECONNREFUSED/);
});
