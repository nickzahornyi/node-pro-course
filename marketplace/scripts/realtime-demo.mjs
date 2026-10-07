import { io } from 'socket.io-client';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.REALTIME_URL || 'http://127.0.0.1:3000';
const orderA = process.env.REALTIME_ORDER_A || '1';
const orderB = process.env.REALTIME_ORDER_B || '2';
const sameRoom = process.argv.includes('--same-room');
const roomB = sameRoom ? orderA : orderB;
const token = (value, userId) => value || execFileSync('docker', ['compose', 'exec', '-T', 'app', 'node', 'dist/realtime/issue-token.js', userId], { encoding: 'utf8', timeout: 15000 }).trim();
const sockets = [];
const received = [[], []];

async function connect(authToken, room, index) {
  const socket = io(base, { transports: ['websocket'], auth: { token: authToken }, autoConnect: false, reconnection: false, timeout: 5000 });
  sockets.push(socket);
  socket.on('order.status', event => received[index].push(event));
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
  const ack = await socket.timeout(5000).emitWithAck('join', { order_id: room });
  if (!ack?.ok || ack.room !== `orders:${room}`) throw new Error(`Join failed: ${JSON.stringify(ack)}`);
  return socket;
}

try {
  if (!sameRoom && orderA === orderB) throw new Error('Different-room mode requires different order IDs');
  const authA = token(process.env.REALTIME_TOKEN_A, process.env.REALTIME_USER_A || '1');
  const authB = sameRoom ? authA : token(process.env.REALTIME_TOKEN_B, process.env.REALTIME_USER_B || '2');
  await Promise.all([connect(authA, orderA, 0), connect(authB, roomB, 1)]);
  const existing = await fetch(`${base}/orders/${encodeURIComponent(orderA)}`, { signal: AbortSignal.timeout(5000) });
  if (!existing.ok) throw new Error(`Read order: HTTP ${existing.status}`);
  const { status } = await existing.json();
  const changed = await fetch(`${base}/orders/${encodeURIComponent(orderA)}/status`, {
    method: 'PATCH', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${authA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status === 'paid' ? 'shipped' : 'paid' }),
  });
  const result = await changed.json();
  if (!changed.ok || !result.changed || !Number.isSafeInteger(result.event_id)) throw new Error(`Status change failed: ${JSON.stringify(result)}`);
  // Measure this exact committed event, not unrelated traffic received by either socket.
  const deadline = Date.now() + 5000;
  const count = index => received[index].filter(event => event.id === result.event_id && event.order_id === orderA && event.status === result.status).length;
  while (Date.now() < deadline && (count(0) === 0 || (sameRoom && count(1) === 0))) await delay(20);
  await delay(400); // Also observe the negative case for a bounded interval.
  const a = count(0), b = count(1);
  console.log(`A_RECEIVED=${a}`);
  console.log(`B_RECEIVED=${b}`);
  if (a !== 1 || b !== (sameRoom ? 1 : 0)) throw new Error('Room delivery does not match the measured expectation');
} catch (error) {
  console.error(`DEMO_ERROR=${error.message}`);
  process.exitCode = 1;
} finally { sockets.forEach(socket => socket.disconnect()); }
