import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';
const schema = z.object({
  JWT_KID: z.string().min(1), JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1), REFRESH_TOKEN_PEPPER: z.string().min(16),
  JWT_PREVIOUS_PUBLIC_KEYS: z.string().optional(),
});
export function authConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n'));
  const c = parsed.data;
  const privateKey = createPrivateKey(Buffer.from(c.JWT_PRIVATE_KEY, 'base64').toString());
  const publicKey = createPublicKey(Buffer.from(c.JWT_PUBLIC_KEY, 'base64').toString());
  for (const key of [privateKey, publicKey]) {
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('JWT_PRIVATE_KEY/JWT_PUBLIC_KEY must be ES256 P-256 keys');
  }
  if (!createPublicKey(privateKey).export({type:'spki',format:'der'}).equals(publicKey.export({type:'spki',format:'der'}))) throw new Error('JWT_PRIVATE_KEY/JWT_PUBLIC_KEY mismatch');
  const keys = new Map([[c.JWT_KID, publicKey]]);
  if (c.JWT_PREVIOUS_PUBLIC_KEYS) for (const [kid, pem] of Object.entries(JSON.parse(c.JWT_PREVIOUS_PUBLIC_KEYS))) {
    if (kid === c.JWT_KID || typeof pem !== 'string') throw new Error('Invalid JWT_PREVIOUS_PUBLIC_KEYS');
    const key = createPublicKey(Buffer.from(pem,'base64').toString());
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('JWT_PREVIOUS_PUBLIC_KEYS must contain P-256 keys');
    keys.set(kid,key);
  }
  return { ...c, privateKey, keys };
}
