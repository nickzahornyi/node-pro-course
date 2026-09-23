import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validate } from './config/env.schema.js';
import { User } from './entities/user.entity.js';
import { Product } from './entities/product.entity.js';
import { Order } from './entities/order.entity.js';
import { OrderItem } from './entities/order-item.entity.js';
import { Job } from './entities/job.entity.js';

// No dotenv here: Infisical (or the CI runner) supplies the environment.
const config = validate(process.env);
const url = new URL(config.DB_URL);

export default new DataSource({
  type: 'postgres',
  host: url.hostname,
  port: url.port ? Number(url.port) : 5432,
  username: decodeURIComponent(url.username),
  database: decodeURIComponent(url.pathname.slice(1)),
  password: async () => config.DB_PASSWORD ?? (await readFile(config.DB_PASSWORD_FILE, 'utf8')).trim(),
  poolSize: config.DB_POOL_MAX,
  synchronize: false,
  migrationsRun: false,
  entities: [User, Product, Order, OrderItem, Job],
  migrations: [fileURLToPath(new URL('./migrations/*.js', import.meta.url))],
  logging: false,
});
