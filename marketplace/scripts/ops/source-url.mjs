export function resolveSourceUrl(source, env = process.env) {
  const url = new URL(source);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected PostgreSQL DB_URL');
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    const port = url.port || '5432';
    const poolPort = env.LOCAL_PGBOUNCER_PORT || '6432';
    const postgresPort = env.LOCAL_POSTGRES_PORT || '5432';
    if (poolPort === postgresPort) throw new Error('Published PostgreSQL and PgBouncer ports must differ');
    if (port === poolPort) { url.hostname = 'pgbouncer'; url.port = '6432'; }
    else if (port === postgresPort) { url.hostname = 'db'; url.port = '5432'; }
    else throw new Error('Local DB_URL must point to the published PgBouncer or PostgreSQL port');
  }
  return url;
}
