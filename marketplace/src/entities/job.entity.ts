import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Order } from './order.entity.js';

@Entity('jobs')
@Index('jobs_order_id_key', ['orderId'], { unique: true })
@Index('jobs_pending_idx', ['id'], { where: "status = 'pending'" })
@Check('jobs_state_check', "(status = 'pending' AND processed = 0 AND worker_id IS NULL AND result IS NULL) OR (status = 'done' AND processed = 1 AND worker_id IS NOT NULL AND result IS NOT NULL)")
export class Job {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column({ name: 'order_id', type: 'bigint' })
  orderId!: string;

  @ManyToOne(() => Order, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'jobs_order_id_fkey' })
  order!: Relation<Order>;

  @Column({ type: 'text', default: 'pending' })
  status!: string;

  @Column({ type: 'integer', default: 0 })
  processed!: number;

  @Column({ name: 'worker_id', type: 'text', nullable: true })
  workerId!: string | null;

  @Column({ type: 'text', nullable: true })
  result!: string | null;
}
