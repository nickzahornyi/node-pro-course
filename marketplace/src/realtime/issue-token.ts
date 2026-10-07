import { readFile } from 'node:fs/promises';
import dataSource from '../data-source.js';
import { validate } from '../config/env.schema.js';
import { validId } from '../repositories/products.repository.js';
import { issueToken } from './token.js';

const userId = process.argv[2];
if (!validId(userId ?? '')) throw new Error('Usage: node dist/realtime/issue-token.js <userId>');
const config = validate(process.env);
const secret = config.AUTH_SECRET ?? (await readFile(config.AUTH_SECRET_FILE, 'utf8')).trim();
await dataSource.initialize();
try {
  if (!(await dataSource.query('SELECT id FROM users WHERE id=$1', [userId])).length) throw new Error('User not found');
  console.log(issueToken(userId, secret));
} finally { await dataSource.destroy(); }
