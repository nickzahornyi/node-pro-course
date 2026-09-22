import { isDeepStrictEqual } from 'node:util';

interface IndexDefinition {
  name: string;
  table_name: string;
  is_unique: boolean;
  is_valid: boolean;
  method: string;
  keys: string[];
  included: string[];
  predicate: string | null;
}

// PostgreSQL features deliberately owned by SQL migrations, not TypeORM schema sync.
const expected: IndexDefinition[] = [
  { name: 'users_lower_email_key', table_name: 'users', is_unique: true, is_valid: true, method: 'btree', keys: ['lower(email)'], included: [], predicate: null },
  { name: 'products_lower_name_idx', table_name: 'products', is_unique: false, is_valid: true, method: 'btree', keys: ['lower(name)'], included: [], predicate: null },
  { name: 'orders_user_created_idx', table_name: 'orders', is_unique: false, is_valid: true, method: 'btree', keys: ['user_id', 'created_at'], included: ['id', 'total_cents'], predicate: null },
  { name: 'orders_pending_created_idx', table_name: 'orders', is_unique: false, is_valid: true, method: 'btree', keys: ['created_at'], included: ['id', 'user_id', 'total_cents'], predicate: "(status = 'pending'::text)" },
];

interface Queryable {
  query(sql: string, parameters?: unknown[]): Promise<any>;
}

export async function checkIndexContract(db: Queryable, allowEmpty = false): Promise<void> {
  if (allowEmpty) {
    const [row] = await db.query(`SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1)`, [['users', 'products', 'orders', 'order_items']]);
    if (row.count === 0) return;
  }
  const actual: (IndexDefinition & { options: number[] })[] = await db.query(`
    SELECT c.relname AS name, t.relname AS table_name, i.indisunique AS is_unique,
           (i.indisvalid AND i.indisready) AS is_valid, am.amname AS method,
           ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, true)
                 FROM generate_series(1, i.indnkeyatts) n ORDER BY n) AS keys,
           ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, true)
                 FROM generate_series(i.indnkeyatts + 1, i.indnatts) n ORDER BY n) AS included,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           i.indoption::smallint[] AS options
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
    JOIN pg_am am ON am.oid=c.relam
    WHERE ns.nspname='public' AND c.relname = ANY($1)
  `, [expected.map((index) => index.name)]);
  const failures: string[] = [];
  for (const definition of expected) {
    const found = actual.find((index) => index.name === definition.name);
    const expectedOptions = definition.name === 'orders_user_created_idx' ? [0, 3]
      : definition.name === 'orders_pending_created_idx' ? [3] : [0];
    if (!found) failures.push(`${definition.name}: missing`);
    else {
      const { options, ...shape } = found;
      if (!isDeepStrictEqual(shape, definition) || !isDeepStrictEqual(options, expectedOptions)) {
        failures.push(`${definition.name}: definition drift; actual=${JSON.stringify(found)}`);
      }
    }
  }
  if (failures.length) throw new Error(`Manual index contract failed:\n${failures.join('\n')}`);
}
