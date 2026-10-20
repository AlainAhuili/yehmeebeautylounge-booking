// Every translation key used in the pages and scripts exists in the German file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const pub = new URL('../public/', import.meta.url);
const de = JSON.parse(readFileSync(new URL('i18n/de.json', pub), 'utf8'));

function usedKeys() {
  const keys = new Set();
  const files = [
    ...readdirSync(pub).filter((f) => f.endsWith('.html')),
    // i18n.js only contains example keys in its comments
    ...readdirSync(new URL('js/', pub)).filter((f) => f !== 'i18n.js').map((f) => `js/${f}`),
  ];
  for (const file of files) {
    const src = readFileSync(new URL(file, pub), 'utf8');
    for (const m of src.matchAll(/data-i18n(?:-html)?="([\w.]+)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(';')) keys.add(pair.split(':')[1].trim());
    for (const m of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/'((?:time|list|account|confirm|status)\.[\w]+)'/g)) keys.add(m[1]);
  }
  return keys;
}

test('every key used in HTML and JavaScript exists', () => {
  const missing = [...usedKeys()].filter((k) => !(k in de));
  assert.deepEqual(missing, []);
});

test('every page title exists', () => {
  for (const file of readdirSync(pub).filter((f) => f.endsWith('.html'))) {
    const page = readFileSync(new URL(file, pub), 'utf8').match(/data-page="(\w+)"/)?.[1];
    assert.ok(page && `page.${page}` in de, file);
  }
});
