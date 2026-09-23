import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CheckoutQueue1790110000000 implements MigrationInterface {
  name = 'CheckoutQueue1790110000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE users ADD COLUMN balance_cents bigint NOT NULL DEFAULT 0,
      ADD CONSTRAINT users_balance_cents_check CHECK (balance_cents >= 0)`);
    await runner.query(`CREATE TABLE jobs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id bigint NOT NULL CONSTRAINT jobs_order_id_fkey REFERENCES orders(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending', processed integer NOT NULL DEFAULT 0,
      worker_id text, result text,
      CONSTRAINT jobs_state_check CHECK (
        (status = 'pending' AND processed = 0 AND worker_id IS NULL AND result IS NULL) OR
        (status = 'done' AND processed = 1 AND worker_id IS NOT NULL AND result IS NOT NULL))
    )`);
    await runner.query('CREATE UNIQUE INDEX jobs_order_id_key ON jobs(order_id)');
    await runner.query("CREATE INDEX jobs_pending_idx ON jobs(id) WHERE status = 'pending'");
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE jobs');
    await runner.query('ALTER TABLE users DROP CONSTRAINT users_balance_cents_check, DROP COLUMN balance_cents');
  }
}
