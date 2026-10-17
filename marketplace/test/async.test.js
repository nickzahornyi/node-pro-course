import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderPlacedSchema } from '../dist/async/order-placed.js';

const event = () => ({ eventId: randomUUID(), type: 'order.placed', version: 1,
  occurredAt: new Date().toISOString(), data: { orderId: '1', buyerId: '2', totalCents: '1000' } });
test('event schema rejects malformed IDs without throwing a conversion error', () => {
  for (const orderId of ['invalid', '', '-1', '0', '9223372036854775808', '1.2', '99999999999999999999']) {
    const value = event(); value.data.orderId = orderId;
    assert.equal(orderPlacedSchema.safeParse(value).success, false);
  }
  assert.equal(orderPlacedSchema.safeParse(event()).success, true);
});
test('event contract rejects entity spreads, wrong version and invalid money', () => {
  assert.equal(orderPlacedSchema.safeParse({ ...event(), stock: 10 }).success, false);
  assert.equal(orderPlacedSchema.safeParse({ ...event(), version: 2 }).success, false);
  const value = event(); value.data.totalCents = '-1';
  assert.equal(orderPlacedSchema.safeParse(value).success, false);
});
