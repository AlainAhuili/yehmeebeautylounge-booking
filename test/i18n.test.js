// Every language file has exactly the German keys (US English only overrides
// some English texts), the same {placeholders}, and every server error code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../public/i18n/', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
const de = read('de.json');
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'de.json');
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

for (const file of files) {
  test(`${file} matches the German keys and placeholders`, () => {
    const dict = read(file);
    const extra = Object.keys(dict).filter((k) => !(k in de));
    assert.deepEqual(extra, [], 'keys that German does not have');
    if (file !== 'en-US.json') {
      const missing = Object.keys(de).filter((k) => !(k in dict));
      assert.deepEqual(missing, [], 'missing keys');
    }
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(placeholders(value), placeholders(de[key]), `placeholders differ in "${key}"`);
    }
  });
}

test('every error code the server sends has a translation', () => {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('const MESSAGES = {'), source.indexOf('};', source.indexOf('const MESSAGES = {')));
  const codes = [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
  assert.ok(codes.length > 15);
  for (const code of codes) assert.ok(`error.${code}` in de, `error.${code} is missing`);
});

test('every service and category has a German name, and translations only use known languages', () => {
  const catalog = JSON.parse(readFileSync(new URL('../content/services.json', import.meta.url), 'utf8'));
  const known = new Set(['de', 'en', 'fr', 'es', 'it', 'nl', 'pt', 'tr', 'el', 'pl', 'cs']);
  for (const c of catalog.categories) {
    assert.ok(c.name.de, c.id);
    for (const s of c.services) {
      assert.ok(s.name.de, s.id);
      for (const field of [s.name, s.description ?? {}]) for (const lang of Object.keys(field)) assert.ok(known.has(lang), `${s.id}: ${lang}`);
    }
  }
});
