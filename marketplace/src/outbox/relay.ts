import type { DataSource } from 'typeorm';
import { orderPlacedSchema, type PlacedPublisher } from '../async/order-placed.js';

export interface RelayOptions {
  scope?: string;
  batchSize?: number;
  // Fault boundary is AFTER confirmed publish, BEFORE published_at. Not an API option.
  afterPublish?: () => void | Promise<void>;
}
export class OutboxRelay {
  private readonly failedAttempts = new Map<string, number>();

  constructor(private readonly db: DataSource) {}

  async batch(publisher: PlacedPublisher, options: RelayOptions = {}): Promise<number> {
    const size = options.batchSize ?? 5;
    if (!Number.isSafeInteger(size) || size < 1 || size > 5) throw new Error('batchSize must be 1..5');
    // Retry diagnostics only on the next call, in a short transaction. Rows held
    // by another relay are skipped, even if that relay has already published them.
    if (this.failedAttempts.size) {
      const pending = [...this.failedAttempts];
      const ids = pending.map(([id]) => id);
      const counts = pending.map(([, count]) => count);
      const recorded = await this.db.transaction(async manager => {
        const [updated]: [{ id: string }[], number] = await manager.query(`WITH locked AS (
          SELECT o.id,f.count FROM outbox o
          JOIN unnest($1::uuid[],$2::int[]) AS f(id,count) ON o.id=f.id
          ORDER BY o.id LIMIT $3 FOR UPDATE OF o SKIP LOCKED
        ) UPDATE outbox o SET attempts=o.attempts+locked.count
          FROM locked WHERE o.id=locked.id RETURNING o.id`, [ids, counts, size]);
        // Retention or demo cleanup may have deleted a deferred row.
        const remaining = await manager.query('SELECT id FROM outbox WHERE id=ANY($1::uuid[])', [ids]);
        const existing = new Set(remaining.map((row: { id: string }) => row.id));
        return new Set([...updated.map((row: { id: string }) => row.id), ...ids.filter(id => !existing.has(id))]);
      });
      for (const id of recorded) this.failedAttempts.delete(id);
    }
    const attempted: string[] = [];
    try {
      return await this.db.transaction(async manager => {
        const rows = await manager.query(`SELECT id,payload FROM outbox
          WHERE relay_scope=$1 AND published_at IS NULL
          ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`, [options.scope ?? 'shop', size]);
        for (const row of rows) {
          attempted.push(row.id);
          await publisher.publish(orderPlacedSchema.parse(row.payload));
          await options.afterPublish?.();
          await manager.query('UPDATE outbox SET published_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1', [row.id]);
        }
        return rows.length;
      });
    } catch (error) {
      // No database work after rollback: preserve observations for the next call.
      // Restart/SIGKILL can lose these diagnostics; attempts is not a delivery ledger.
      for (const id of attempted) this.failedAttempts.set(id, (this.failedAttempts.get(id) ?? 0) + 1);
      throw error;
    }
  }
}
