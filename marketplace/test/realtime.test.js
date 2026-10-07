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
  for (let n = 0; n < events.capacity + 1; n++) events.publish({ order_id: n % 2 ? '2' : '1', previous_status: 'pending', status: 'paid' });
  assert.throws(() => events.replay('1', 0), /replay window/);
  const replay = events.replay('1', events.capacity - 2);
  assert.deepEqual(replay.map(event => event.id), [499, 501]);
  assert.ok(replay.every(event => event.order_id === '1'));
  assert.throws(() => events.replay('1', events.capacity + 2), /Invalid Last-Event-ID/);
  events.onModuleDestroy();
});
