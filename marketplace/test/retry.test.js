import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryTransaction } from '../dist/retry.js';

for (const code of ['40001', '40P01']) {
  test(`retries entire transaction for ${code}`, async () => {
    let transactions = 0;
    let reads = 0;
    const db = { transaction: async (isolation, operation) => {
      assert.equal(isolation, 'REPEATABLE READ');
      transactions++;
      return operation({});
    } };
    const logs = [];
    const result = await retryTransaction(db, async () => {
      reads++;
      if (reads === 1) throw { driverError: { code } };
      return 42;
    }, (...args) => logs.push(args));
    assert.equal(result, 42); assert.equal(reads, 2); assert.equal(transactions, 2);
    assert.deepEqual(logs, [[code, 1]]);
  });
}

test('does not retry business, constraint or connection errors', async () => {
  for (const code of ['23514', '23505', '08006', 'INSUFFICIENT_FUNDS', undefined]) {
    let calls = 0;
    const error = Object.assign(new Error('failure'), { code });
    const db = { transaction: async () => { calls++; throw error; } };
    await assert.rejects(retryTransaction(db, async () => {}, () => assert.fail('unexpected retry')), e => e === error);
    assert.equal(calls, 1);
  }
});

test('retry attempts are bounded', async () => {
  let calls = 0;
  const db = { transaction: async () => { calls++; throw { code: '40001' }; } };
  await assert.rejects(retryTransaction(db, async () => {}, () => {}, 2), e => e.code === '40001');
  assert.equal(calls, 2);
});
