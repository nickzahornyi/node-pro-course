\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = btrim(email) AND position('@' IN email) > 1),
    display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seller_id bigint NOT NULL REFERENCES users(id),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    price numeric(12,2) NOT NULL CHECK (price >= 0 AND price <> 'NaN'::numeric),
    stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
    total numeric(14,2) NOT NULL CHECK (total >= 0 AND total <> 'NaN'::numeric),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id bigint NOT NULL REFERENCES orders(id),
    product_id bigint NOT NULL REFERENCES products(id),
    quantity integer NOT NULL CHECK (quantity > 0),
    unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0 AND unit_price <> 'NaN'::numeric),
    UNIQUE (order_id, product_id)
);

COMMIT;
