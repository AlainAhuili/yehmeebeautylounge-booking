// MariaDB store against a real database. Runs only with TEST_DATABASE_URL set
// (in the environment or .env); it empties that database, so never point it at real data.

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import mariadb from 'mariadb';
import { fileURLToPath } from 'node:url';
import { MariaStore } from '../src/mariadb-store.js';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch { /* no .env: fine */ }
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'set TEST_DATABASE_URL to run';

const user = { id: 'u_1', name: 'Mia', email: 'mia@example.com', phone: '+49 170 000000', passwordHash: 'scrypt:a:b', createdAt: '2026-10-19T07:00:00.123Z' };
const admin = { ...user, id: 'u_2', email: 'admin@example.com', role: 'admin' };
const booking = {
  id: 'b_1', userId: 'u_1', serviceId: 'classic', serviceName: 'Klassisch', durationMin: 105, priceEur: 59.5,
  date: '2026-10-21', time: '10:00', start: 600, end: 705, endTime: '11:45', note: 'Hallo ♡',
  payment: { method: 'voucher', voucherCode: 'GIFT-1', depositEur: 0 }, status: 'confirmed', createdAt: '2026-10-19T07:05:00.000Z',
};

before(async () => {
  if (skip) return;
  const u = new URL(url);
  const conn = await mariadb.createConnection({
    host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password), database: u.pathname.slice(1),
  });
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['gallery_hidden', 'gallery_uploads', 'service_images', 'resets', 'sessions', 'vouchers', 'bookings', 'users']) {
    await conn.query(`DROP TABLE IF EXISTS ${t}`);
  }
  await conn.end();
});

test('a new database starts empty, with all tables created', { skip }, async () => {
  const store = await MariaStore.open(url);
  assert.ok(store.isEmpty());
  assert.deepEqual(store.data, { users: [], sessions: [], bookings: [], vouchers: [], resets: [], serviceImages: {}, gallery: { uploads: [], hidden: [] } });
  await store.close();
});

test('everything saved comes back exactly the same after a restart', { skip }, async () => {
  const store = await MariaStore.open(url);
  store.change((d) => {
    d.users.push(user, admin);
    d.sessions.push({ tokenHash: 'a'.repeat(64), userId: 'u_1', expiresAt: 1795129514346 });
    d.resets.push({ tokenHash: 'b'.repeat(64), userId: 'u_1', expiresAt: 1795129514999 });
    d.vouchers.push({ code: 'GIFT-1', note: 'Geschenk' }, { code: 'GIFT-2' });
    d.serviceImages.classic = { file: 'classic-1.jpg', uploadedAt: '2026-10-20T23:10:00.643Z', uploadedBy: 'u_2' };
    d.gallery.uploads.push(
      { id: 'g-1', section: 'nails', file: 'nails-1.jpg', uploadedAt: '2026-10-20T10:00:00.000Z', uploadedBy: 'u_2' },
      { id: 'g-2', section: 'lashes', file: 'lashes-1.jpg', uploadedAt: '2026-10-20T09:00:00.000Z', uploadedBy: 'u_2' },
    );
    d.gallery.hidden.push('b-nails-01');
  });
  // A booking and the voucher it uses, in one change (the voucher refers to the booking)
  store.change((d) => {
    d.bookings.push(booking);
    d.vouchers.find((v) => v.code === 'GIFT-1').usedBy = 'b_1';
  });
  await store.close();

  const again = await MariaStore.open(url);
  assert.deepEqual(again.data, store.data);
  assert.deepEqual(again.data.gallery.uploads.map((u) => u.id), ['g-1', 'g-2'], 'upload order is kept');
  await again.close();
});

test('changes and removals are saved too', { skip }, async () => {
  const store = await MariaStore.open(url);
  store.change((d) => {
    const b = d.bookings[0];
    b.status = 'cancelled';
    b.cancelledAt = '2026-10-19T08:00:00.000Z';
    b.depositRefunded = false;
    d.sessions = [];
    d.gallery.hidden = [];
    d.gallery.uploads = d.gallery.uploads.filter((u) => u.id !== 'g-1');
    delete d.serviceImages.classic;
    d.users.find((u) => u.id === 'u_1').passwordHash = 'scrypt:new:hash';
  });
  await store.close();

  const again = await MariaStore.open(url);
  assert.deepEqual(again.data, store.data);
  assert.equal(again.data.bookings[0].depositRefunded, false);
  assert.equal(again.data.sessions.length, 0);
  await again.close();
});

test('a failed write is retried with the next change', { skip }, async () => {
  const store = await MariaStore.open(url);
  const errors = [];
  const log = console.error;
  console.error = (...args) => errors.push(args);
  try {
    // Two accounts with the same email break the UNIQUE rule: the whole write is refused
    store.change((d) => d.users.push({ ...user, id: 'u_3' }));
    await store.flush().catch(() => {});
    assert.equal(errors.length, 1);
    store.change((d) => { d.users.find((u) => u.id === 'u_3').email = 'other@example.com'; });
    await store.flush();
  } finally {
    console.error = log;
  }
  await store.close();

  const again = await MariaStore.open(url);
  assert.ok(again.data.users.some((u) => u.id === 'u_3' && u.email === 'other@example.com'));
  await again.close();
});
