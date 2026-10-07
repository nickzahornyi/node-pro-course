import type { MigrationInterface, QueryRunner } from 'typeorm';
export class OrderRequests1790800000000 implements MigrationInterface {
  name = 'OrderRequests1790800000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE order_requests (key text PRIMARY KEY, fingerprint text NOT NULL,
      order_id bigint NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE)`);
  }
  async down(runner: QueryRunner): Promise<void> { await runner.query('DROP TABLE order_requests'); }
}
