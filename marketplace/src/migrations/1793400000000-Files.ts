import type { MigrationInterface, QueryRunner } from 'typeorm';
export class Files1793400000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE files (
      id uuid PRIMARY KEY, key text NOT NULL UNIQUE, owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED')),
      size bigint NOT NULL CHECK(size>0), content_type text NOT NULL, upload_id text,
      part_size bigint NOT NULL, request_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(owner_id,request_key))`);
    await q.query('CREATE INDEX files_owner_idx ON files(owner_id,created_at)');
  }
  async down(q: QueryRunner) { await q.query('DROP TABLE files'); }
}
