SELECT id, user_id, created_at, total
FROM orders
WHERE status = 'pending'
ORDER BY created_at DESC
LIMIT 50;
