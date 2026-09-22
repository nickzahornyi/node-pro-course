import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, type Relation } from 'typeorm';
import { Order } from './order.entity.js';
import { Product } from './product.entity.js';

@Entity('order_items')
@Unique('order_items_order_id_product_id_key', ['orderId', 'productId'])
@Index('order_items_product_id_idx', ['productId'])
@Check('order_items_quantity_check', 'quantity > 0')
@Check('order_items_unit_price_cents_check', 'unit_price_cents >= 0 AND unit_price_cents <= 999999999999')
export class OrderItem {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column({ name: 'order_id', type: 'bigint' })
  orderId!: string;

  @ManyToOne(() => Order, (order) => order.items, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'order_items_order_id_fkey' })
  order!: Relation<Order>;

  @Column({ name: 'product_id', type: 'bigint' })
  productId!: string;

  @ManyToOne(() => Product, (product) => product.orderItems, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id', foreignKeyConstraintName: 'order_items_product_id_fkey' })
  product!: Relation<Product>;

  @Column({ type: 'integer' })
  quantity!: number;

  @Column({ name: 'unit_price_cents', type: 'bigint' })
  unitPriceCents!: string;
}
