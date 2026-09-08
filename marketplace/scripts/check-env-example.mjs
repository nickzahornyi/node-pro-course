import { readFile } from 'node:fs/promises';

const schemaSource = await readFile(new URL('../src/config/env.schema.ts', import.meta.url), 'utf8');
const exampleSource = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const objectBody = schemaSource.match(/envSchema\s*=\s*z\.object\(\{([\s\S]*?)\n\}\);/)?.[1];
if (!objectBody) throw new Error('Could not read envSchema from src/config/env.schema.ts');

const schemaKeys = [...objectBody.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]);
const exampleKeys = [...exampleSource.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
const missing = schemaKeys.filter((key) => !exampleKeys.includes(key));
const extra = exampleKeys.filter((key) => !schemaKeys.includes(key));
const duplicates = exampleKeys.filter((key, index) => exampleKeys.indexOf(key) !== index);

if (missing.length || extra.length || duplicates.length) {
  if (missing.length) console.error(`Missing from .env.example: ${missing.join(', ')}`);
  if (extra.length) console.error(`Not present in env schema: ${extra.join(', ')}`);
  if (duplicates.length) console.error(`Duplicated in .env.example: ${[...new Set(duplicates)].join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`.env.example is synchronized with env schema (${schemaKeys.length} variables).`);
}
