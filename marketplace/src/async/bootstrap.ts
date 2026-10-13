import { connectBroker } from './publisher.js';
import { declareTopology, topology } from './topology.js';

const url = process.env.BROKER_URL;
if (!url) throw new Error('BROKER_URL is required');
const connection = await connectBroker(url);
try {
  const channel = await connection.createChannel();
  channel.on('error', () => {});
  await declareTopology(channel, topology());
  await channel.close();
  console.log('topology_ready=1');
} finally { await connection.close(); }
