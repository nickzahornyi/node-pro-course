import db from '../data-source.js';
await db.initialize();
const lock=db.createQueryRunner();
try {
  await lock.connect();
  await lock.query('SELECT pg_advisory_lock(280028)');
  await db.runMigrations();
} finally {await lock.query('SELECT pg_advisory_unlock(280028)');await lock.release();await db.destroy();}
