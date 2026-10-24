import { connect, type ChannelModel, type ConfirmChannel, type Message } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { orderPlacedSchema, type OrderPlacedEvent, type PlacedPublisher } from './order-placed.js';

export async function connectBroker(url: string): Promise<ChannelModel> {
  const connection = await connect(url, { timeout: 5000 });
  // Every caller handles closure; avoid an uncaught EventEmitter error leaking credentials.
  connection.on('error', () => {});
  return connection;
}

export class ConfirmedPublisher implements PlacedPublisher {
  private tail: Promise<void> = Promise.resolve();
  private constructor(private readonly connection: ChannelModel, private readonly channel: ConfirmChannel, private readonly exchange: string) {}

  static async open(url: string, exchange = 'shop.events'): Promise<ConfirmedPublisher> {
    const connection = await connectBroker(url);
    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => {});
      return new ConfirmedPublisher(connection, channel, exchange);
    } catch (error) { await connection.close().catch(() => {}); throw error; }
  }

  publish(event: OrderPlacedEvent) { return this.publishRaw(orderPlacedSchema.parse(event)); }

  // Poison-message demos use the same confirm + mandatory transport with an invalid payload.
  publishRaw(payload: unknown, routingKey = 'order.placed'): Promise<void> {
    const operation = this.tail.then(async () => {
      const eventId = (payload as { eventId?: string } | null)?.eventId ?? randomUUID();
      let returned = false;
      const onReturn = (message: Message) => { if (message.properties.messageId === eventId) returned = true; };
      this.channel.on('return', onReturn);
      let timer: NodeJS.Timeout | undefined;
      try {
        this.channel.publish(this.exchange, routingKey, Buffer.from(JSON.stringify(payload)), {
          persistent: true, mandatory: true, contentType: 'application/json', messageId: eventId, type: 'order.placed',
        });
        await Promise.race([this.channel.waitForConfirms(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Publisher confirm timed out')), 2000);
        })]);
        if (returned) throw new Error('Unroutable order.placed event (mandatory return)');
      } finally { if (timer) clearTimeout(timer); this.channel.off('return', onReturn); }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async close() {
    await this.tail;
    await this.channel.close().catch(() => {});
    await this.connection.close().catch(() => {});
  }
}
