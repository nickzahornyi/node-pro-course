import type { DataSource, EntityManager } from 'typeorm';
import { setTimeout as delay } from 'node:timers/promises';

export async function retryTransaction<T>(db: DataSource,
  operation: (manager: EntityManager, attempt: number) => Promise<T>,
  onRetry: (code: string, attempt: number) => void = (code, attempt) => console.log(`retry ${attempt}: ${code}`),
  maxAttempts = 5): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be positive');
  for (let attempt = 1; ; attempt++) {
    try { return await db.transaction('REPEATABLE READ', (manager) => operation(manager, attempt)); }
    catch (error) {
      const code = (error as { code?: string; driverError?: { code?: string } })?.driverError?.code
        ?? (error as { code?: string })?.code;
      if ((code !== '40001' && code !== '40P01') || attempt >= maxAttempts) throw error;
      onRetry(code, attempt);
      await delay(Math.min(500, 10 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 10));
    }
  }
}
