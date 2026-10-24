import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Redis } from 'ioredis';

export function printMetrics(metrics: Record<string, number>) {
  for (const [key, value] of Object.entries(metrics)) console.log(`${key}=${value}`);
}

export async function until(condition: () => Promise<boolean>, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error('Demo timed out');
    await delay(25);
  }
}

export async function removePrefix(redis: Redis, prefix: string) {
  let cursor = '0';
  do {
    const page = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
    cursor = page[0];
    if (page[1].length) await redis.del(...page[1]);
  } while (cursor !== '0');
}

export async function demoServer(mode: 'session' | 'ratelimit', prefix: string) {
  const child = fork(fileURLToPath(new URL('./demo-http-server.js', import.meta.url)), [mode, prefix],
    { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let settled = false;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { if (!settled) reject(new Error('HTTP child startup timed out')); }, 10000);
      child.once('message', (message: unknown) => {
        const value = message as { url: string };
        clearTimeout(timeout); settled = true; resolve(value.url);
      });
      child.once('error', error => { clearTimeout(timeout); settled = true; reject(error); });
      child.once('exit', () => { clearTimeout(timeout); if (!settled) reject(new Error('HTTP child exited before ready')); });
    });
    return { url, async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.send('stop');
      const [code] = await exited;
      assert.equal(code, 0);
    } };
  } catch (error) { child.kill(); throw error; }
}
