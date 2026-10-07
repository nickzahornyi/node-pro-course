import { it, expect } from '@jest/globals';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import Ajv from 'ajv';

it('MarketplaceWeb reads a product described by the OpenAPI contract', async () => {
  const example = { id: '7', name: 'Mechanical keyboard', price_cents: 320000 };
  const spec = yaml.load(await readFile('openapi/openapi.yaml', 'utf8'));
  expect(spec.paths['/products/{productId}'].get.responses['200']).toBeDefined();
  expect(new Ajv().compile(spec.components.schemas.Product)(example)).toBe(true);
  const pact = new PactV3({ consumer: 'MarketplaceWeb', provider: 'MarketplaceAPI', dir: resolve('pacts'), logLevel: 'warn' });
  pact.given('a product with ID 7 exists').uponReceiving('GET a marketplace product')
    .withRequest({ method: 'GET', path: '/products/7' })
    .willRespondWith({ status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: {
      id: MatchersV3.regex('^[0-9]+$', example.id), name: MatchersV3.like(example.name), price_cents: MatchersV3.integer(example.price_cents),
    } });
  await pact.executeTest(async mock => {
    const response = await fetch(`${mock.url}/products/7`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(example);
  });
  const generated = JSON.parse(await readFile('pacts/MarketplaceWeb-MarketplaceAPI.json', 'utf8'));
  for (const interaction of generated.interactions) {
    const concrete = interaction.request.path.split('/');
    const path = Object.keys(spec.paths).find(template => {
      const segments = template.split('/');
      return segments.length === concrete.length && segments.every((segment, i) =>
        /^\{[^}]+\}$/.test(segment) ? Boolean(concrete[i]) : segment === concrete[i]);
    });
    expect(path).toBeDefined();
    const schema = spec.paths[path][interaction.request.method.toLowerCase()].responses[String(interaction.response.status)].content['application/json'].schema;
    const actualSchema = schema.$ref ? spec.components.schemas[schema.$ref.split('/').at(-1)] : schema;
    expect(new Ajv().compile(actualSchema)(interaction.response.body)).toBe(true);
  }
});
