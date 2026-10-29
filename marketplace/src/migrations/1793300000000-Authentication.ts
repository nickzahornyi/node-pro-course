import type { MigrationInterface, QueryRunner } from 'typeorm';
export class Authentication1793300000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE users ADD COLUMN password_hash text, ADD COLUMN role text NOT NULL DEFAULT 'buyer' CHECK(role IN ('buyer','seller','admin'));
      CREATE TABLE auth_families(id uuid PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, revoked_at timestamptz);
      CREATE TABLE refresh_tokens(token_hash text PRIMARY KEY, family_id uuid NOT NULL REFERENCES auth_families(id) ON DELETE CASCADE,
        used_at timestamptz, revoked_at timestamptz, expires_at timestamptz NOT NULL);
      CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);
      CREATE TABLE access_denylist(jti uuid PRIMARY KEY, expires_at timestamptz NOT NULL);
      CREATE INDEX access_denylist_expiry_idx ON access_denylist(expires_at)`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE access_denylist, refresh_tokens, auth_families; ALTER TABLE users DROP COLUMN password_hash, DROP COLUMN role');
  }
}
