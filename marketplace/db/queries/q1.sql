SELECT id, created_at, total
FROM orders
WHERE user_id = 42
  AND created_at >= timestamptz '2026-03-01 00:00:00+00'
  AND created_at < timestamptz '2026-04-01 00:00:00+00'
ORDER BY created_at DESC;
