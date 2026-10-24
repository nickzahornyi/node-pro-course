import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { drainDlq } from '../dist/async/drain-dlq.js';

test('parallel Compose builds never export different services to the same tag', async () => {
  const { services } = yaml.load(await readFile('docker-compose.yml', 'utf8'));
  const tags = Object.values(services).filter(s => s.build && s.image).map(s => s.image);
  assert.equal(tags.length, new Set(tags).size);
});

test('CI runs each HW19/HW22 demo twice and the live async tests, with unconditional cleanup', async () => {
  const workflow = yaml.load(await readFile('../.github/workflows/contracts.yml', 'utf8'));
  const job = workflow.jobs.async;
  assert.equal(job.env.SKIP_VAULT, '1');
  const commands = job.steps.map(step => step.run ?? '').join('\n');
  for (const script of ['demo:publish', 'demo:dlq', 'demo:duplicate', 'demo:outbox', 'demo:crash-write', 'demo:crash-relay', 'test:async']) assert.ok(commands.includes(`npm run ${script}`));
  assert.match(commands, /for round in 1 2/);
  assert.ok(job.steps.some(step => step.if === 'always()' && step.run.includes('docker compose down')));
});

test('DLQ drain rejects invalid budgets without touching broker or filesystem', async () => {
  for (const limit of [0, -1, 1.5, 10001, NaN]) {
    await assert.rejects(drainDlq({}, 'queue', '/unused', limit), /limit must be/);
  }
});
