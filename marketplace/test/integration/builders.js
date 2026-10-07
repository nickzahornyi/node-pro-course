import { randomUUID } from 'node:crypto';
export const aUser = (overrides = {}) => ({ email: `buyer-${randomUUID()}@example.test`, displayName: 'Test buyer', balance: '1000000', ...overrides });
export const aProduct = (sellerId, overrides = {}) => ({ sellerId, name: `Product ${randomUUID()}`, priceCents: '1250', stock: 10, ...overrides });
export async function insertUser(db, data = aUser()) {
  return (await db.query('INSERT INTO users(email,display_name,balance_cents) VALUES($1,$2,$3) RETURNING *', [data.email, data.displayName, data.balance])).rows[0];
}
