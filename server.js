// YehMee Beauty Lounge booking: starts the server.

import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { mailerFromEnv } from './src/mailer.js';
import { bucketMedia } from './src/media.js';
import { listenForPaymentEvents } from './src/payment-events.js';
import { paymentsFromEnv } from './src/payments.js';
import { openStore } from './src/store.js';

const root = (path) => fileURLToPath(new URL(path, import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(root(path), 'utf8'));

// Local settings such as DATABASE_URL (see .env.example); real environment variables win
try { process.loadEnvFile(root('./.env')); } catch (err) { if (err.code !== 'ENOENT') throw err; }

const PORT = Number(process.env.PORT) || 3000;
const store = await openStore({ databaseUrl: process.env.DATABASE_URL, file: process.env.DATA_FILE || root('./data/db.json') });
const isProduction = process.env.NODE_ENV === 'production';

// A test voucher so the "gift voucher" path can be tried during development.
// Never in production: it would let every customer skip the deposit.
if (!isProduction && !store.data.vouchers.length) {
  store.change((d) => d.vouchers.push({ code: 'YEHMEE-TEST', note: 'Testgutschein (Entwicklung)' }));
}

const payments = paymentsFromEnv();

const app = createApp({
  store,
  salon: readJson('./content/salon.json'),
  catalog: readJson('./content/services.json'),
  manifest: readJson('./public/images/manifest.json'),
  // Uploaded photos: in a Cloud Storage bucket (resized by a function), otherwise
  // next to the data file
  uploadsDir: process.env.UPLOADS_DIR || root('./data/uploads'),
  ...(process.env.MEDIA_BUCKET && { media: bucketMedia(process.env.MEDIA_BUCKET) }),
  // Emails go to the send-email function via Pub/Sub, or are printed (development)
  mail: mailerFromEnv(),
  // The admin page lives outside public/, so only the app can hand it out (to admins)
  adminDir: root('./admin'),
  // SumUp (cards, vouchers) and PayPal; test checkouts while their keys are missing
  payments,
  publicUrl: process.env.PUBLIC_URL,
});

// Pages and photos. "/buchen" etc. also work without ".html".
const site = express();
site.disable('x-powered-by');
site.use(app);
site.use(express.static(root('./public'), { extensions: ['html'] }));

// Everything else, including /admin for non-admins: the same "not found" page
site.use((req, res) => res.status(404).sendFile(root('./public/404.html')));

const server = site.listen(PORT, () => {
  console.log(`YehMee booking running at http://localhost:${PORT}`);
  console.log(`Data: ${process.env.DATABASE_URL ? 'MariaDB' : 'JSON file'}`);
  console.log(`Payments: ${Object.entries(payments.providers).map(([m, p]) => `${m} ${p.test ? '(test checkout)' : `via ${p.name}`}`).join(', ') || 'none configured'}`);
  console.log(`Emails: ${process.env.MAIL_TOPIC ? `Pub/Sub topic ${process.env.MAIL_TOPIC}` : 'printed here'}`);
  console.log(`Photos: ${process.env.MEDIA_BUCKET ? `bucket ${process.env.MEDIA_BUCKET}` : 'local folder'}`);
});

// Payment notifications from the payment-webhook function
const stopPaymentEvents = process.env.PAYMENT_EVENTS_SUBSCRIPTION
  ? listenForPaymentEvents({ subscription: process.env.PAYMENT_EVENTS_SUBSCRIPTION, onPayment: app.locals.settlePayment })
  : async () => {};

// Ctrl+C: finish the last database writes before stopping
const stop = () => server.close(() => stopPaymentEvents().finally(() => store.close()).finally(() => process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
