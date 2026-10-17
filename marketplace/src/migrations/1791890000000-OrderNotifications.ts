import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OrderNotifications1791890000000 implements MigrationInterface {
  name = 'OrderNotifications1791890000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE orders ADD COLUMN placed_event_id uuid NOT NULL DEFAULT gen_random_uuid()');
    await runner.query('CREATE UNIQUE INDEX orders_placed_event_id_idx ON orders(placed_event_id)');
    await runner.query(`CREATE TABLE order_notifications (
      event_id uuid PRIMARY KEY,
      order_id bigint NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      total_cents bigint NOT NULL CHECK (total_cents >= 0 AND total_cents <= 99999999999999),
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    )`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE order_notifications');
    await runner.query('DROP INDEX orders_placed_event_id_idx');
    await runner.query('ALTER TABLE orders DROP COLUMN placed_event_id');
  }
}
