import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { User } from './user.entity.js';
import { OrderItem } from './order-item.entity.js';

@Entity('products')
@Index('products_seller_id_idx', ['sellerId'])
@Index('products_lower_name_idx', { synchronize: false })
@Check('products_name_check', 'length(btrim(name)) > 0')
@Check('products_price_cents_check', 'price_cents >= 0 AND price_cents <= 999999999999')
@Check('products_stock_check', 'stock >= 0')
export class Product {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column({ name: 'seller_id', type: 'bigint' })
  sellerId!: string;

  @ManyToOne(() => User, (user) => user.products, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'seller_id', foreignKeyConstraintName: 'products_seller_id_fkey' })
  seller!: Relation<User>;

  @Column({ type: 'text' })
  name!: string;

  // pg returns bigint as a string; do not round money through JavaScript Number.
  @Column({ name: 'price_cents', type: 'bigint' })
  priceCents!: string;

  @Column({ type: 'integer', default: 0 })
  stock!: number;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems!: Relation<OrderItem[]>;
}
