# HW-12: EXPLAIN (ANALYZE, BUFFERS)

Оновлений прогін після рев'ю, 2026-09-14: Docker Desktop, PostgreSQL 17.11,
aarch64 Linux, ізольований Compose-проєкт marketplace-hw12-review з новим volume.
50 000 users, 20 000 products, 200 000 orders, 400 000 order_items.

Порядок: schema.sql → seed.sql (VACUUM (ANALYZE)) → три EXPLAIN до →
indexes.sql → ANALYZE → ті самі три EXPLAIN після. Налаштування планера
не змінювались. Це одиничні локальні вимірювання, не гарантія такого ж часу
на іншій машині; кеш і паралельні workers впливають на результати.
Нижче повний текст планів psql -At без декоративної рамки.

Початкова схема вже містить UNIQUE lower(email) та два індекси FK;
вони не обслуговують фільтри q1–q3. q3 тепер шукає товар за lower(name).
q1 обмежено березнем 2026: для user_id=42 із 4 замовлень залишається 1,
тобто період реально відсікає 75% замовлень цього покупця.

## q1

Запит: [q1.sql](queries/q1.sql).

До:

```text
Sort  (cost=5773.44..5773.45 rows=1 width=23) (actual time=7.526..9.500 rows=1 loops=1)
  Sort Key: created_at DESC
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=3318
  ->  Gather  (cost=1000.00..5773.43 rows=1 width=23) (actual time=7.384..9.479 rows=1 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=3315
        ->  Parallel Seq Scan on orders  (cost=0.00..4773.33 rows=1 width=23) (actual time=4.514..5.142 rows=0 loops=3)
              Filter: ((created_at >= '2026-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-04-01 00:00:00+00'::timestamp with time zone) AND (user_id = 42))
              Rows Removed by Filter: 66666
              Buffers: shared hit=3315
Planning:
  Buffers: shared hit=94
Planning Time: 0.330 ms
Execution Time: 9.586 ms
```

Після:

```text
Index Only Scan using orders_user_created_idx on orders  (cost=0.42..4.44 rows=1 width=23) (actual time=0.048..0.049 rows=1 loops=1)
  Index Cond: ((user_id = 42) AND (created_at >= '2026-03-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-04-01 00:00:00+00'::timestamp with time zone))
  Heap Fetches: 0
  Buffers: shared hit=4 read=3
Planning:
  Buffers: shared hit=150 read=2
Planning Time: 0.662 ms
Execution Time: 0.088 ms
```

Parallel Seq Scan, Gather і Sort замінено на Index Only Scan за (user_id, created_at): 9.586 → 0.088 мс, буфери виконання 3318 → 7, Heap Fetches = 0; INCLUDE покриває вибрані поля, VACUUM забезпечує visibility map.

## q2

Запит: [q2.sql](queries/q2.sql).

До:

```text
Limit  (cost=5384.66..5390.49 rows=50 width=31) (actual time=5.456..6.801 rows=50 loops=1)
  Buffers: shared hit=3389
  ->  Gather Merge  (cost=5384.66..5581.14 rows=1684 width=31) (actual time=5.454..6.786 rows=50 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=3389
        ->  Sort  (cost=4384.64..4386.74 rows=842 width=31) (actual time=3.814..3.817 rows=38 loops=3)
              Sort Key: created_at DESC
              Sort Method: top-N heapsort  Memory: 30kB
              Buffers: shared hit=3389
              Worker 0:  Sort Method: top-N heapsort  Memory: 32kB
              Worker 1:  Sort Method: top-N heapsort  Memory: 32kB
              ->  Parallel Seq Scan on orders  (cost=0.00..4356.67 rows=842 width=31) (actual time=0.307..3.639 rows=667 loops=3)
                    Filter: (status = 'pending'::text)
                    Rows Removed by Filter: 66000
                    Buffers: shared hit=3315
Planning:
  Buffers: shared hit=92
Planning Time: 0.352 ms
Execution Time: 6.849 ms
```

Після:

```text
Limit  (cost=0.28..2.44 rows=50 width=31) (actual time=0.038..0.046 rows=50 loops=1)
  Buffers: shared hit=1 read=2
  ->  Index Only Scan using orders_pending_created_idx on orders  (cost=0.28..92.28 rows=2133 width=31) (actual time=0.037..0.041 rows=50 loops=1)
        Heap Fetches: 0
        Buffers: shared hit=1 read=2
Planning:
  Buffers: shared hit=144
Planning Time: 0.444 ms
Execution Time: 0.077 ms
```

Partial індекс для 1% pending-замовлень повертає перші 50 записів у потрібному порядку: Parallel Seq Scan і сортування зникли, 6.849 → 0.077 мс, буфери 3389 → 3, Heap Fetches = 0.

## q3

Запит: [q3.sql](queries/q3.sql).

До:

```text
Seq Scan on products  (cost=0.00..497.00 rows=100 width=27) (actual time=0.864..4.200 rows=1 loops=1)
  Filter: (lower(name) = 'product 4242'::text)
  Rows Removed by Filter: 19999
  Buffers: shared hit=197
Planning:
  Buffers: shared hit=78
Planning Time: 0.341 ms
Execution Time: 4.235 ms
```

Після:

```text
Index Scan using products_lower_name_idx on products  (cost=0.29..8.30 rows=1 width=27) (actual time=0.035..0.035 rows=1 loops=1)
  Index Cond: (lower(name) = 'product 4242'::text)
  Buffers: shared hit=1 read=2
Planning:
  Buffers: shared hit=102 read=1
Planning Time: 0.519 ms
Execution Time: 0.072 ms
```

Expression-індекс lower(name) замінив Seq Scan товарів на Index Scan: 4.235 → 0.072 мс, буфери 197 → 3; таблиця читається для полів id, name і price.

## Перевірки рев'ю

- Спроба вставити buyer4242@example.test поруч із Buyer4242@example.test
  відхилена unique_violation; users_lower_email_key існує вже у schema.sql.
- У каталозі підтверджено products_seller_id_idx і order_items_product_id_idx.
  EXPLAIN SELECT 1 із відповідними FK-фільтрами використовує Index Only Scan.
- Збереглися 4 FK та 200 000 orders. pg_stat_user_indexes показав idx_scan=1
  для кожного з трьох індексів оптимізації після вимірювань.
- orders.user_id покриває orders_user_created_idx після indexes.sql;
  order_items.order_id покритий лівим префіксом UNIQUE(order_id, product_id).

До робочого розгортання застосовуються обидва SQL-файли. Індекси PK/UNIQUE
та підтримки FK не видаляються лише через idx_scan=0 у трьох SELECT-сценаріях:
вони забезпечують цілісність і перевірки при DELETE/UPDATE батьківських рядків.
Команди повного відтворення наведено у README.
