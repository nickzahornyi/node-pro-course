import dataSource from './data-source.js';
import { OrderItem } from './entities/order-item.entity.js';

await dataSource.initialize();
try {
  // Historical line prices, not today's product price; ignore unpaid/cancelled orders.
  const rows = await dataSource.getRepository(OrderItem).createQueryBuilder('item')
    .innerJoin('item.order', 'order')
    .innerJoin('item.product', 'product')
    .innerJoin('product.seller', 'seller')
    .select('seller.id', 'seller_id')
    .addSelect('seller.displayName', 'seller_name')
    .addSelect('COUNT(DISTINCT order.id)', 'order_count')
    .addSelect('SUM(item.quantity)', 'units_sold')
    .addSelect('SUM(item.quantity::numeric * item.unitPriceCents)', 'revenue_cents')
    .where('order.status IN (:...statuses)', { statuses: ['paid', 'shipped'] })
    .groupBy('seller.id').addGroupBy('seller.displayName')
    .orderBy('SUM(item.quantity::numeric * item.unitPriceCents)', 'DESC')
    .addOrderBy('seller.id', 'ASC')
    .getRawMany();
  // COUNT/SUM and bigint IDs stay decimal strings to preserve precision.
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await dataSource.destroy();
}
