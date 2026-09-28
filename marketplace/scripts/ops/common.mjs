import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

// Both sides use the same SQL; bigint/numeric values remain exact decimal strings.
export const controlSql = `SELECT json_build_object(
  'users', (SELECT count(*)::text FROM public.users),
  'products', (SELECT count(*)::text FROM public.products),
  'orders', (SELECT count(*)::text FROM public.orders),
  'order_items', (SELECT count(*)::text FROM public.order_items),
  'jobs', (SELECT count(*)::text FROM public.jobs),
  'order_total_cents', (SELECT coalesce(sum(total_cents),0)::text FROM public.orders),
  'balance_cents', (SELECT coalesce(sum(balance_cents),0)::text FROM public.users),
  'stock', (SELECT coalesce(sum(stock),0)::text FROM public.products)
) AS controls`;

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function run(command, args, { env = process.env, inputFile, echo = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: [inputFile ? 'pipe' : 'ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (echo) process.stdout.write(chunk); });
    child.on('error', reject);
    let stream;
    if (inputFile) {
      stream = createReadStream(inputFile);
      stream.on('error', error => { child.kill(); reject(error); });
      child.stdin.on('error', () => {}); // Child exit status reports restore failures (including EPIPE).
      stream.pipe(child.stdin);
    }
    child.on('close', code => {
      stream?.destroy();
      if (code !== 0) reject(new Error(`${command} failed (exit ${code})`));
      else resolve(stdout.trim());
    });
  });
}
