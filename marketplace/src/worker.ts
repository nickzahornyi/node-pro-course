import type { DataSource, EntityManager } from 'typeorm';
import { setTimeout as delay } from 'node:timers/promises';

export async function runWorker(db: DataSource, workerId: string, orderIds?: string[],
  processJob: (id: string, manager: EntityManager) => Promise<string> = async (id) => `Receipt for order ${id}`): Promise<number> {
  let processed = 0;
  for (;;) {
    const claimed = await db.transaction(async (manager) => {
      const [job] = await manager.query(`SELECT id, order_id FROM jobs
        WHERE status = 'pending' AND ($1::bigint[] IS NULL OR order_id = ANY($1))
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`, [orderIds ?? null]);
      if (!job) return false;
      const result = await processJob(job.order_id, manager);
      await manager.query(`UPDATE jobs SET status = 'done', processed = processed + 1,
        worker_id = $2, result = $3 WHERE id = $1`, [job.id, workerId, result]);
      return true;
    });
    if (claimed) { processed++; continue; }
    // Locked pending rows remain visible: empty SKIP LOCKED is not queue exhaustion.
    const [{ pending }] = await db.query(`SELECT count(*)::int AS pending FROM jobs
      WHERE status = 'pending' AND ($1::bigint[] IS NULL OR order_id = ANY($1))`, [orderIds ?? null]);
    if (pending === 0) return processed;
    await delay(10);
  }
}
