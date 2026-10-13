import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import type { DataSource } from 'typeorm';
import { orderPlacedSchema } from './order-placed.js';
import { applyOrderPlaced, InvalidEventError } from './effect.js';
import { connectBroker } from './publisher.js';
import { declareTopology, PREFETCH, type Topology } from './topology.js';

export interface ConsumerStats { delivered: number; effect: number; skipped: number; acked: number; rejected: number; redelivered: number; processing_ms: number }
export interface ConsumerNotice { kind: 'ready' | 'handled' | 'effect-before-ack'; stats: ConsumerStats; eventId?: string }

export class OrderConsumer {
  readonly stats: ConsumerStats = { delivered: 0, effect: 0, skipped: 0, acked: 0, rejected: 0, redelivered: 0, processing_ms: 0 };
  private connection?: ChannelModel;
  private channel?: Channel;
  private consumerTag?: string;
  private readonly inFlight = new Set<Promise<void>>(); // Tracks work only, never deduplicates events.
  private stopping = false;

  constructor(private readonly db: DataSource, private readonly names: Topology,
    private readonly notify: (notice: ConsumerNotice) => void = () => {},
    private readonly crashAfterEffect = false, private readonly fatal: () => void = () => {}) {}

  async start(url: string): Promise<void> {
    this.connection = await connectBroker(url);
    this.connection.on('close', () => { if (!this.stopping) this.fatal(); });
    this.channel = await this.connection.createChannel();
    this.channel.on('error', () => { if (!this.stopping) this.fatal(); });
    await declareTopology(this.channel, this.names);
    await this.channel.prefetch(PREFETCH);
    const reply = await this.channel.consume(this.names.work, message => {
      if (!message) { if (!this.stopping) this.fatal(); return; } // basic.cancel is a failure, not silence.
      const operation = this.handle(message).catch(() => { if (!this.stopping) this.fatal(); });
      this.inFlight.add(operation);
      void operation.finally(() => this.inFlight.delete(operation));
    }, { noAck: false });
    this.consumerTag = reply.consumerTag;
    this.notify({ kind: 'ready', stats: { ...this.stats } });
  }

  private async handle(message: ConsumeMessage): Promise<void> {
    const channel = this.channel!;
    const started = performance.now();
    this.stats.delivered++;
    if (message.fields.redelivered) this.stats.redelivered++;
    let eventId: string | undefined;
    try {
      let value: unknown;
      try { value = JSON.parse(message.content.toString()); }
      catch { throw new InvalidEventError('Malformed JSON'); }
      const result = orderPlacedSchema.safeParse(value);
      if (!result.success) throw new InvalidEventError('Invalid order.placed contract');
      eventId = result.data.eventId;
      const applied = await applyOrderPlaced(this.db, result.data);
      if (applied) this.stats.effect++; else this.stats.skipped++;
      if (applied && this.crashAfterEffect) {
        this.notify({ kind: 'effect-before-ack', stats: { ...this.stats }, eventId });
        await new Promise<never>(() => {}); // Parent demo SIGKILLs this process, not channel.close().
      }
      channel.ack(message); // Only after the durable INSERT committed (or the durable duplicate was found).
      this.stats.acked++;
    } catch (error) {
      if (error instanceof InvalidEventError) { channel.reject(message, false); this.stats.rejected++; }
      else {
        channel.reject(message, true); // Transient DB fault: retry, quorum delivery-limit caps poison loops.
        console.error('consumer_retry=1');
      }
    }
    this.stats.processing_ms += Math.ceil(performance.now() - started);
    this.notify({ kind: 'handled', stats: { ...this.stats }, eventId });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.consumerTag) await this.channel?.cancel(this.consumerTag).catch(() => {});
    await Promise.all(this.inFlight);
    await this.channel?.close().catch(() => {});
    await this.connection?.close().catch(() => {});
  }
}
