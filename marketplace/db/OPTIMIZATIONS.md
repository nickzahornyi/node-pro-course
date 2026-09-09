# HW-12: EXPLAIN (ANALYZE, BUFFERS)

Виміряно 2026-09-09 у Docker Desktop, PostgreSQL 17.11, aarch64 Linux.
Стенд: marketplace-hw12-check; 50 000 users, 20 000 products, 200 000 orders,
400 000 order_items. Seed завершено VACUUM (ANALYZE).

Порядок: чиста схема → seed → q1/q2/q3 без додаткових індексів → indexes.sql
→ ANALYZE → ті самі q1/q2/q3. Налаштування планера не змінювались.
Нижче повний текст планів із psql -At (без декоративної рамки таблиці).
Це одиничні вимірювання, не статистичний benchmark: кеш і паралельні workers
впливають на час; особливо q3 до індексу мав 515 read buffers. Висновок базується
також на вузлах плану й кількості буферів, а не лише на коефіцієнті прискорення.

## q1

Запит: [q1.sql](queries/q1.sql).

До:

```text
Sort  (cost=5773.77..5773.78 rows=4 width=23) (actual time=8.910..10.349 rows=4 loops=1)
  Sort Key: created_at DESC
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=3318
  ->  Gather  (cost=1000.00..5773.73 rows=4 width=23) (actual time=5.540..10.303 rows=4 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=3315
        ->  Parallel Seq Scan on orders  (cost=0.00..4773.33 rows=2 width=23) (actual time=4.235..6.149 rows=1 loops=3)
              Filter: ((created_at >= '2026-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-06-01 00:00:00+00'::timestamp with time zone) AND (user_id = 42))
              Rows Removed by Filter: 66665
              Buffers: shared hit=3315
Planning:
  Buffers: shared hit=91 read=3
Planning Time: 0.397 ms
Execution Time: 10.428 ms
```

Після:

```text
Index Only Scan using orders_user_created_idx on orders  (cost=0.42..4.51 rows=4 width=23) (actual time=0.045..0.050 rows=4 loops=1)
  Index Cond: ((user_id = 42) AND (created_at >= '2026-01-01 00:00:00+00'::timestamp with time zone) AND (created_at < '2026-06-01 00:00:00+00'::timestamp with time zone))
  Heap Fetches: 0
  Buffers: shared hit=4 read=4
Planning:
  Buffers: shared hit=148 read=2
Planning Time: 0.447 ms
Execution Time: 0.096 ms
```

Parallel Seq Scan, Gather і Sort замінив covering Index Only Scan за (user_id, created_at): виконання 10.428 → 0.096 мс, буфери 3318 → 8, Heap Fetches = 0 завдяки visibility map після VACUUM.

## q2

Запит: [q2.sql](queries/q2.sql).

До:

```text
Limit  (cost=5385.03..5390.86 rows=50 width=31) (actual time=5.105..6.353 rows=50 loops=1)
  Buffers: shared hit=3389
  ->  Gather Merge  (cost=5385.03..5584.07 rows=1706 width=31) (actual time=5.103..6.347 rows=50 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=3389
        ->  Sort  (cost=4385.00..4387.14 rows=853 width=31) (actual time=3.449..3.452 rows=38 loops=3)
              Sort Key: created_at DESC
              Sort Method: top-N heapsort  Memory: 30kB
              Buffers: shared hit=3389
              Worker 0:  Sort Method: top-N heapsort  Memory: 30kB
              Worker 1:  Sort Method: top-N heapsort  Memory: 32kB
              ->  Parallel Seq Scan on orders  (cost=0.00..4356.67 rows=853 width=31) (actual time=0.260..3.296 rows=667 loops=3)
                    Filter: (status = 'pending'::text)
                    Rows Removed by Filter: 66000
                    Buffers: shared hit=3315
Planning:
  Buffers: shared hit=92
Planning Time: 0.278 ms
Execution Time: 6.420 ms
```

Після:

```text
Limit  (cost=0.28..2.59 rows=50 width=31) (actual time=0.032..0.039 rows=50 loops=1)
  Buffers: shared hit=1 read=2
  ->  Index Only Scan using orders_pending_created_idx on orders  (cost=0.28..89.08 rows=1920 width=31) (actual time=0.031..0.034 rows=50 loops=1)
        Heap Fetches: 0
        Buffers: shared hit=1 read=2
Planning:
  Buffers: shared hit=142
Planning Time: 0.436 ms
Execution Time: 0.060 ms
```

Partial індекс лише для pending дозволив читати перші 50 записів у потрібному порядку: Parallel Seq Scan і сортування зникли, 6.420 → 0.060 мс, буфери 3389 → 3, Heap Fetches = 0.

## q3

Запит: [q3.sql](queries/q3.sql).

До:

```text
Seq Scan on users  (cost=0.00..1265.00 rows=250 width=42) (actual time=1.908..14.973 rows=1 loops=1)
  Filter: (lower(email) = 'buyer4242@example.test'::text)
  Rows Removed by Filter: 49999
  Buffers: shared read=515
Planning:
  Buffers: shared hit=80 read=4
Planning Time: 1.234 ms
Execution Time: 15.003 ms
```

Після:

```text
Index Scan using users_lower_email_idx on users  (cost=0.41..8.43 rows=1 width=42) (actual time=0.035..0.035 rows=1 loops=1)
  Index Cond: (lower(email) = 'buyer4242@example.test'::text)
  Buffers: shared hit=1 read=3
Planning:
  Buffers: shared hit=103 read=1
Planning Time: 0.324 ms
Execution Time: 0.062 ms
```

Expression-індекс lower(email) замінив Seq Scan на Index Scan: 15.003 → 0.062 мс, буфери 515 → 4; одна знайдена строка потребує читання таблиці для display_name.

## Інтерпретація індексів

Додано рівно три індекси оптимізації: orders_user_created_idx,
orders_pending_created_idx (partial), users_lower_email_idx (expression).
Перевірка pg_stat_user_indexes після прогону підтверджує їх використання.
PK та UNIQUE індекси з idx_scan = 0 не видаляємо: вони забезпечують цілісність.
Повний відтворюваний цикл наведений у README; фактичні timings на іншій машині відрізнятимуться.

