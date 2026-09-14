\set ON_ERROR_STOP on
-- Run once after schema.sql on an empty database. Fixed timestamps make plans reproducible.
BEGIN;
INSERT INTO users (email, display_name, created_at)
SELECT 'Buyer' || n || '@example.test', 'Buyer ' || n,
       timestamptz '2025-01-01 00:00:00+00' + n * interval '1 minute'
FROM generate_series(1, 50000) AS s(n);

INSERT INTO products (seller_id, name, price, stock)
SELECT 1 + (n % 2000), 'Product ' || n, (500 + n % 99500)::numeric / 100, n % 100
FROM generate_series(1, 20000) AS s(n);

INSERT INTO orders (user_id, status, total, created_at)
SELECT 1 + ((n * 7919) % 50000),
       CASE WHEN n % 100 = 0 THEN 'pending'
            WHEN n % 100 < 6 THEN 'cancelled'
            WHEN n % 100 < 26 THEN 'paid'
            ELSE 'shipped' END,
       0, timestamptz '2026-01-01 00:00:00+00' + n * interval '1 minute'
FROM generate_series(1, 200000) AS s(n);

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, p.id, 1 + (o.id % 3)::integer, p.price
FROM orders o
CROSS JOIN generate_series(0, 1) AS line(n)
JOIN products p ON p.id = 1 + ((o.id * 17 + line.n) % 20000);

UPDATE orders o SET total = totals.amount
FROM (SELECT order_id, sum(quantity * unit_price) AS amount FROM order_items GROUP BY order_id) totals
WHERE o.id = totals.order_id;
COMMIT;

-- Outside the transaction: populate statistics AND the visibility map.
VACUUM (ANALYZE);
