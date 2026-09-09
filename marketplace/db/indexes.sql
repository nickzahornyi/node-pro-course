\set ON_ERROR_STOP on
-- q1: equality on buyer, range and ordering on creation time; cover projected fields.
CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC) INCLUDE (id, total);
-- q2: only the 1% of orders waiting for payment, already ordered for LIMIT.
CREATE INDEX orders_pending_created_idx ON orders (created_at DESC) INCLUDE (id, user_id, total)
WHERE status = 'pending';
-- q3: ordinary email uniqueness does not support lower(email).
CREATE INDEX users_lower_email_idx ON users (lower(email));
