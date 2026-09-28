import { Check, Column, Entity, Index, OneToMany, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Product } from './product.entity.js';
import { Order } from './order.entity.js';

@Entity('users')
@Check('users_balance_cents_check', 'balance_cents >= 0')
@Index('users_lower_email_key', { synchronize: false })
@Check('users_email_check', "email = btrim(email) AND position('@' IN email) > 1")
@Check('users_display_name_check', 'length(btrim(display_name)) > 0')
export class User {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column({ type: 'text' })
  email!: string;

  @Column({ name: 'display_name', type: 'text' })
  displayName!: string;

  @Column({ name: 'balance_cents', type: 'bigint', default: 0 })
  balanceCents!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @OneToMany(() => Product, (product) => product.seller)
  products!: Relation<Product[]>;

  @OneToMany(() => Order, (order) => order.user)
  orders!: Relation<Order[]>;
}
