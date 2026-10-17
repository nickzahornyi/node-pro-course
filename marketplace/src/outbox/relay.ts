import type { DataSource } from 'typeorm';
import { orderPlacedSchema, type PlacedPublisher } from '../async/order-placed.js';

export interface RelayOptions {
  scope?: string;
  batchSize?: number;
  // Fault boundary is AFTER confirmed publish, BEFORE published_at. Not an API option.
  afterPublish?: () => void | Promise<void>;
}
export async function relayBatch(db: DataSource, publisher: PlacedPublisher, options: RelayOptions = {}): Promise<number> {
  const size = options.batchSize ?? 10;
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error('batchSize must be 1..100');
  const attempted: string[] = [];
  try {
    return await db.transaction(async manager => {
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
    // The publishing transaction rolled back. Record observed failures separately;
    // a SIGKILL cannot update this diagnostic counter (it is not a delivery ledger).
    if (attempted.length) await db.query('UPDATE outbox SET attempts=attempts+1 WHERE id=ANY($1::uuid[])', [attempted]).catch(() => {});
    throw error;
  }
}
