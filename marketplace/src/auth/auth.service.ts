import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database.service.js';
import { authConfig } from './config.js';

export function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
export interface Identity { userId: string; role: string; familyId: string; jti: string; expiresAt: number }
@Injectable()
export class AuthService {
  private readonly config = authConfig();
  private readonly logger = new Logger(AuthService.name);
  private readonly cleanup = setInterval(() => {
    void this.db.query('DELETE FROM access_denylist WHERE expires_at <= now()').catch(() => this.logger.warn('Denylist cleanup failed'));
  }, 30000).unref();
  constructor(private readonly db: DatabaseService) {}
  onModuleDestroy() { clearInterval(this.cleanup); }
  private hash(token: string) { return createHmac('sha256',this.config.REFRESH_TOKEN_PEPPER).update(token).digest('hex'); }
  private async pair(client: PoolClient, user: {id: string; role: string}, familyId: string) {
    const refresh_token = randomBytes(48).toString('base64url');
    const access_token = await new SignJWT({role:user.role, family_id:familyId})
      .setProtectedHeader({alg:'ES256',kid:this.config.JWT_KID,typ:'JWT'}).setSubject(user.id)
      .setIssuer('marketplace').setAudience('marketplace-api').setJti(randomUUID()).setIssuedAt().setExpirationTime('10m')
      .sign(this.config.privateKey);
    await client.query(`INSERT INTO refresh_tokens(token_hash,family_id,expires_at) VALUES($1,$2,now()+interval '30 days')`,[this.hash(refresh_token),familyId]);
    return {access_token,refresh_token,token_type:'Bearer',expires_in:600};
  }
  async login(email: unknown, password: unknown) {
    if (typeof email !== 'string' || typeof password !== 'string' || password.length > 1024) throw new UnauthorizedException();
    const {rows:[user]} = await this.db.query('SELECT id,role,password_hash FROM users WHERE lower(email)=lower($1)',[email]);
    const [salt,hash] = (user?.password_hash ?? 'invalid:').split(':');
    const actual = scryptSync(password,salt,64);
    const expected = Buffer.from(hash,'hex');
    if (!user || actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw new UnauthorizedException('Invalid credentials');
    return this.db.transaction(async client => {
      const family = randomUUID();
      await client.query('INSERT INTO auth_families(id,user_id) VALUES($1,$2)',[family,user.id]);
      return this.pair(client,user,family);
    });
  }
  async refresh(token: unknown) {
    if (typeof token !== 'string' || token.length > 512) throw new UnauthorizedException();
    const result = await this.db.transaction(async client => {
      const {rows:[lookup]} = await client.query('SELECT family_id FROM refresh_tokens WHERE token_hash=$1',[this.hash(token)]);
      if (!lookup) return null;
      // Family lock serializes refresh, reuse detection and logout, including different generations.
      const {rows:[family]} = await client.query('SELECT * FROM auth_families WHERE id=$1 FOR UPDATE',[lookup.family_id]);
      const {rows:[old]} = await client.query('SELECT * FROM refresh_tokens WHERE token_hash=$1',[this.hash(token)]);
      if (family.revoked_at) return null;
      if (old.used_at) {
        await this.revoke(client,family.id);
        this.logger.warn(`refresh_reuse family_id=${family.id}`);
        return null; // Commit revocation BEFORE raising 401.
      }
      if (old.revoked_at || new Date(old.expires_at).getTime() <= Date.now()) return null;
      await client.query('UPDATE refresh_tokens SET used_at=now() WHERE token_hash=$1',[this.hash(token)]);
      const {rows:[user]} = await client.query('SELECT id,role FROM users WHERE id=$1',[family.user_id]);
      return this.pair(client,user,family.id);
    });
    if (!result) throw new UnauthorizedException('Invalid refresh token');
    return result;
  }
  private async revoke(client: PoolClient, family: string) {
    await client.query('UPDATE auth_families SET revoked_at=now() WHERE id=$1',[family]);
    await client.query('UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=$1',[family]);
  }
  async authenticate(token: unknown): Promise<Identity> {
    if (typeof token !== 'string' || token.length > 8192) throw new UnauthorizedException();
    let p;
    try {
      const verified = await jwtVerify(token, header => {
        const key = this.config.keys.get(header.kid ?? '');
        if (!key) throw new Error('Unknown kid');
        return key;
      }, {algorithms:['ES256'],issuer:'marketplace',audience:'marketplace-api',typ:'JWT',requiredClaims:['sub','jti','exp','iat','family_id','role']});
      p = verified.payload;
      if (!/^\d+$/.test(p.sub!) || typeof p.jti !== 'string' || !/^[0-9a-f-]{36}$/.test(p.jti) || typeof p.family_id !== 'string' || !/^[0-9a-f-]{36}$/.test(p.family_id) || !['buyer','seller','admin'].includes(String(p.role))) throw new Error();
    } catch { throw new UnauthorizedException('Invalid access token'); }
    const {rows:[state]} = await this.db.query(`SELECT f.revoked_at, EXISTS(SELECT 1 FROM access_denylist WHERE jti=$2 AND expires_at>now()) AS denied
      FROM auth_families f WHERE f.id=$1 AND f.user_id=$3`,[p.family_id,p.jti,p.sub]);
    if (!state || state.revoked_at || state.denied) throw new UnauthorizedException('Revoked access token');
    return {userId:p.sub!,role:String(p.role),familyId:String(p.family_id),jti:p.jti!,expiresAt:p.exp!*1000};
  }
  async logout(identity: Identity) {
    await this.db.transaction(async client => {
      await client.query('SELECT id FROM auth_families WHERE id=$1 FOR UPDATE',[identity.familyId]);
      await this.revoke(client,identity.familyId);
      await client.query('INSERT INTO access_denylist(jti,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING',[identity.jti,new Date(identity.expiresAt)]);
      await client.query('DELETE FROM access_denylist WHERE expires_at<=now()');
    });
  }
}
