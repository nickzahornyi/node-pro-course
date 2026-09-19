import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { User } from './user.entity.js';
import { OrderItem } from './order-item.entity.js';

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'cancelled';

@Entity('orders')
@Index('orders_user_created_idx', { synchronize: false })
@Index('orders_pending_created_idx', { synchronize: false })
@Check('orders_status_check', "status IN ('pending', 'paid', 'shipped', 'cancelled')")
@Check('orders_total_cents_check', 'total_cents >= 0 AND total_cents <= 99999999999999')
export class Order {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column({ name: 'user_id', type: 'bigint' })
  userId!: string;

  @ManyToOne(() => User, (user) => user.orders, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'orders_user_id_fkey' })
  user!: Relation<User>;

  @Column({ type: 'text', default: 'pending' })
  status!: OrderStatus;

  @Column({ name: 'total_cents', type: 'bigint' })
  totalCents!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @OneToMany(() => OrderItem, (item) => item.order)
  items!: Relation<OrderItem[]>;
}
