import type { MigrationInterface, QueryRunner } from 'typeorm';

export class TransactionalOutbox1792230000000 implements MigrationInterface {
  name = 'TransactionalOutbox1792230000000';
  async up(runner: QueryRunner) {
    await runner.query(`CREATE TABLE outbox (
      id uuid PRIMARY KEY,
      aggregate_type text NOT NULL,
      aggregate_id text NOT NULL,
      type text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      relay_scope text NOT NULL DEFAULT 'shop'
    )`);
    await runner.query('CREATE INDEX outbox_pending_idx ON outbox(relay_scope,created_at,id) WHERE published_at IS NULL');
    await runner.query(`CREATE TABLE processed_messages (
      message_id uuid NOT NULL,
      consumer text NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(message_id,consumer)
    )`);
  }
  async down(runner: QueryRunner) {
    await runner.query('DROP TABLE processed_messages');
    await runner.query('DROP TABLE outbox');
  }
}
