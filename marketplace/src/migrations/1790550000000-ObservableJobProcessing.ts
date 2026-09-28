import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ObservableJobProcessing1790550000000 implements MigrationInterface {
  name = 'ObservableJobProcessing1790550000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE jobs DROP CONSTRAINT jobs_state_check,
      ADD CONSTRAINT jobs_state_check CHECK (
        (status = 'pending' AND processed = 0 AND worker_id IS NULL AND result IS NULL) OR
        (status = 'done' AND processed >= 1 AND worker_id IS NOT NULL AND result IS NOT NULL))`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Refuse rollback if duplicates exist; never erase diagnostic counts to fit the old constraint.
    await runner.query(`ALTER TABLE jobs DROP CONSTRAINT jobs_state_check,
      ADD CONSTRAINT jobs_state_check CHECK (
        (status = 'pending' AND processed = 0 AND worker_id IS NULL AND result IS NULL) OR
        (status = 'done' AND processed = 1 AND worker_id IS NOT NULL AND result IS NOT NULL))`);
  }
}
