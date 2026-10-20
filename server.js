// YehMee Beauty Lounge booking: starts the server.

import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { Store } from './src/store.js';

const PORT = Number(process.env.PORT) || 3000;
const root = (path) => fileURLToPath(new URL(path, import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(root(path), 'utf8'));

const store = new Store(process.env.DATA_FILE || root('./data/db.json'));

// A test voucher so the "gift voucher" path can be tried before real vouchers exist.
if (!store.data.vouchers.length) {
  store.change((d) => d.vouchers.push({ code: 'YEHMEE-TEST', note: 'Testgutschein (Entwicklung)' }));
}

const app = createApp({
  store,
  salon: readJson('./content/salon.json'),
  catalog: readJson('./content/services.json'),
  manifest: readJson('./public/images/manifest.json'),
});

// Pages and photos. "/buchen" etc. also work without ".html".
const site = express();
site.use(app);
site.use(express.static(root('./public'), { extensions: ['html'] }));

site.listen(PORT, () => {
  console.log(`YehMee booking running at http://localhost:${PORT}`);
  console.log('Emails are printed here during development.');
});
