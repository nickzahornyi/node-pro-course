import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {appendFileSync} from 'node:fs';
if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
const k = generateKeyPairSync('ec',{namedCurve:'P-256'});
const values = {
 JWT_KID:'ci-ephemeral',
 JWT_PRIVATE_KEY:Buffer.from(k.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'),
 JWT_PUBLIC_KEY:Buffer.from(k.publicKey.export({type:'spki',format:'pem'})).toString('base64'),
 REFRESH_TOKEN_PEPPER:randomBytes(32).toString('base64'),
};
for (const [name,value] of Object.entries(values)) {
 console.log(`::add-mask::${value}`);
 appendFileSync(process.env.GITHUB_ENV,`${name}=${value}\n`);
}
