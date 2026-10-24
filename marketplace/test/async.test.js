import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { orderPlacedSchema } from '../dist/async/order-placed.js';
import { ConfirmedPublisher } from '../dist/async/publisher.js';

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

test('publisher stops waiting for a stalled confirm after two seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = Object.assign(new EventEmitter(), {
    publish() {},
    waitForConfirms: () => new Promise(() => {}),
    close: async () => {},
  });
  const publisher = new ConfirmedPublisher({ close: async () => {} }, channel, 'test.events');
  const operation = publisher.publish(event());
  let settled = false;
  operation.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(operation, /Publisher confirm timed out/);
  await Promise.resolve(); // Start the serialized publish before advancing timers.
  t.mock.timers.tick(1999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(channel.listenerCount('return'), 0);
  await publisher.close();
});
