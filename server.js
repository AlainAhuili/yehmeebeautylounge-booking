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
const isProduction = process.env.NODE_ENV === 'production';

// A test voucher so the "gift voucher" path can be tried during development.
// Never in production: it would let every customer skip the deposit.
if (!isProduction && !store.data.vouchers.length) {
  store.change((d) => d.vouchers.push({ code: 'YEHMEE-TEST', note: 'Testgutschein (Entwicklung)' }));
}

const app = createApp({
  store,
  salon: readJson('./content/salon.json'),
  catalog: readJson('./content/services.json'),
  manifest: readJson('./public/images/manifest.json'),
  // Uploaded photos live next to the data file (on the persistent disk in production)
  uploadsDir: process.env.UPLOADS_DIR || root('./data/uploads'),
  // The admin page lives outside public/, so only the app can hand it out (to admins)
  adminDir: root('./admin'),
});

// Pages and photos. "/buchen" etc. also work without ".html".
const site = express();
site.disable('x-powered-by');
site.use(app);
site.use(express.static(root('./public'), { extensions: ['html'] }));

// Everything else, including /admin for non-admins: the same "not found" page
site.use((req, res) => res.status(404).sendFile(root('./public/404.html')));

site.listen(PORT, () => {
  console.log(`YehMee booking running at http://localhost:${PORT}`);
  console.log('Emails are printed here during development.');
});
