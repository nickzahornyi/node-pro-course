import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validate } from '../dist/config/env.schema.js';

for (const protocol of ['postgres', 'postgresql']) {
  test(`accepts ${protocol} URL and coerces numeric configuration`, () => {
    const DB_URL = `${protocol}://marketplace@localhost:5432/marketplace`;
    const config = validate({ DB_URL, PORT: '3001', DB_POOL_MAX: '5' });
    assert.equal(config.DB_URL, DB_URL);
    assert.equal(config.PORT, 3001);
    assert.equal(config.DB_POOL_MAX, 5);
    assert.equal(config.NODE_ENV, 'development');
  });
}

for (const [url, reason] of [
  ['not-a-url', /valid PostgreSQL URL/],
  ['https://example.com', /postgres:\/\/ or postgresql:\/\//],
  ['postgresql:///marketplace', /include a host/],
  ['postgresql://localhost/marketplace', /include a role/],
  ['postgresql://marketplace@localhost/', /include a database name/],
  ['postgresql://marketplace:fake-secret@localhost/marketplace', /DB_PASSWORD_FILE/],
  ['postgresql://%ZZ@localhost/marketplace', /valid percent encoding/],
]) {
  test(`rejects invalid database configuration: ${reason.source}`, () => {
    assert.throws(() => validate({ DB_URL: url }), (error) => {
      assert.match(error.message, /DB_URL:/);
      assert.match(error.message, reason);
      assert.doesNotMatch(error.message, /fake-secret/);
      return true;
    });
  });
}

test('reports malformed DB_URL and invalid PORT together', () => {
  assert.throws(() => validate({ DB_URL: 'not-a-url', PORT: 'bad' }), (error) => {
    assert.match(error.message, /Invalid environment configuration:/);
    assert.match(error.message, /DB_URL: must be a valid PostgreSQL URL/);
    assert.match(error.message, /PORT:/);
    return true;
  });
});

test('reports missing DB_URL', () => {
  assert.throws(() => validate({}), /DB_URL:/);
});
