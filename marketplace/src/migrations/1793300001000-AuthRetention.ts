import type { MigrationInterface, QueryRunner } from 'typeorm';
export class AuthRetention1793300001000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Existing families get a fresh grace period, so migration cannot cut off access JWTs.
    await q.query('ALTER TABLE auth_families ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()');
    await q.query('CREATE INDEX auth_families_created_idx ON auth_families(created_at)');
    await q.query('CREATE INDEX auth_families_revoked_idx ON auth_families(revoked_at) WHERE revoked_at IS NOT NULL');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX auth_families_created_idx, auth_families_revoked_idx');
    await q.query('ALTER TABLE auth_families DROP COLUMN created_at');
  }
}
