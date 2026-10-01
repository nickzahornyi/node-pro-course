import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const base = (process.env.PACT_BROKER_URL || 'http://127.0.0.1:9292').replace(/\/$/, '');
const version = process.env.CONSUMER_VERSION || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const providerVersion = process.env.PROVIDER_VERSION || version;
const headers = { 'Content-Type': 'application/json', Accept: 'application/hal+json' };
if (process.env.PACT_BROKER_TOKEN) headers.Authorization = `Bearer ${process.env.PACT_BROKER_TOKEN}`;
const encode = encodeURIComponent;
const command = process.argv[2];
let path, method = 'GET', body;
if (command === 'publish') {
  path = `/pacts/provider/MarketplaceAPI/consumer/MarketplaceWeb/version/${encode(version)}`;
  method = 'PUT'; body = await readFile('pacts/MarketplaceWeb-MarketplaceAPI.json', 'utf8');
} else if (command === 'tag-prod') {
  path = `/pacticipants/MarketplaceAPI/versions/${encode(providerVersion)}/tags/prod`; method = 'PUT'; body = '{}';
} else if (command === 'can-i-deploy') {
  path = `/can-i-deploy?${new URLSearchParams({ pacticipant: 'MarketplaceWeb', version, to: 'prod' })}`;
} else throw new Error('Expected publish, tag-prod or can-i-deploy');
const response = await fetch(base + path, { method, headers, body });
if (!response.ok) throw new Error(`Broker ${command}: HTTP ${response.status}`);
if (command === 'can-i-deploy') {
  const result = await response.json();
  console.log(JSON.stringify({ summary: result.summary }, null, 2));
  if (result.summary?.deployable !== true) process.exitCode = 1;
} else console.log(`${command}: HTTP ${response.status}; version=${command === 'publish' ? version : providerVersion}`);
