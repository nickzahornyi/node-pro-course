import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { issueToken, verifyToken } from '../dist/realtime/token.js';
import { OrderEventsService } from '../dist/realtime/order-events.service.js';

const secret = 'test-only-signing-key-with-at-least-32-characters';
test('identity token rejects tampering, expiration and invalid numeric identity', () => {
  const token = issueToken('42', secret);
  assert.equal(verifyToken(token, secret).userId, '42');
  assert.throws(() => verifyToken(token, 'wrong-test-signing-key-with-32-characters'));
  const payload = Buffer.from(JSON.stringify({ sub: '42', aud: 'marketplace-realtime', exp: 1 })).toString('base64url');
  const expired = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  assert.throws(() => verifyToken(expired, secret), /expired/);
  assert.throws(() => issueToken('9223372036854775808', secret));
});

test('bounded replay returns no duplicates, isolates orders and rejects expired history', () => {
  const events = new OrderEventsService();
  const publish = order_id => events.publish({ order_id, previous_status: 'pending', status: 'paid' });
  publish('1'); publish('1');
  for (let n = 0; n < events.capacity + 1; n++) publish('2');
  assert.deepEqual(events.replay('1', 0).map(event => event.id), [1, 2]);
  assert.throws(() => events.replay('2', 0), /replay window/);
  const retained = events.replay('2', 3);
  assert.equal(retained.length, events.capacity);
  assert.equal(retained[0].id, 4);
  assert.equal(retained.at(-1).id, events.capacity + 3);
  assert.equal(new Set(retained.map(event => event.id)).size, events.capacity);
  // Repeated wraps still retain exactly the latest 500 events in chronological order.
  for (let n = 0; n < events.capacity * 2 + 1; n++) publish('1');
  assert.throws(() => events.replay('1', 0), /replay window/);
  const latestId = events.capacity * 3 + 4;
  const replay = events.replay('1', latestId - events.capacity);
  assert.equal(replay.length, events.capacity);
  assert.deepEqual(replay.map(event => event.id), Array.from({ length: events.capacity }, (_, n) => latestId - events.capacity + n + 1));
  assert.deepEqual(events.replay('2', latestId), []);
  assert.deepEqual(events.replay('1', latestId + 1), []);
  assert.throws(() => events.replay('1', -1), /Invalid Last-Event-ID/);
  assert.throws(() => events.replay('1', Number.MAX_SAFE_INTEGER + 1), /Invalid Last-Event-ID/);
  events.onModuleDestroy();
});
