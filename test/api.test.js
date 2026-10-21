import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const salon = read('../content/salon.json');
const catalog = read('../content/services.json');
const manifest = read('../public/images/manifest.json');

// Monday 19 Oct 2026, 09:00 in Delmenhorst; Wednesday 21 Oct is two days later
let clockTime = new Date('2026-10-19T07:00:00Z');
const mails = [];
const store = new Store(null);
store.data.vouchers.push({ code: 'GIFT-1' });
const uploadsDir = mkdtempSync(join(tmpdir(), 'yehmee-test-'));
const app = createApp({ store, salon, catalog, manifest, uploadsDir, clock: () => clockTime, mail: (m) => mails.push(m) });

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** A tiny client that keeps its session cookie, like a browser. */
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = res.status === 204 ? null : await res.json();
    return { status: res.status, data };
  };
}

const anna = client();
const ben = client();
const register = (c, name, email) => c('POST', '/api/auth/register', { name, email, phone: '+49 151 1234567', password: 'geheim123' });

test('services, salon and gallery are served', async () => {
  const guest = client();
  assert.equal((await guest('GET', '/api/services')).data.categories.length, 4);
  assert.equal((await guest('GET', '/api/salon')).data.name, 'YehMee Beauty Lounge');
  assert.equal((await guest('GET', '/api/gallery')).data.nails.length, 20);
});

test('the calendar shows Monday closed and Wednesday free', async () => {
  const { data } = await client()('GET', '/api/availability/days?service=classic-1-1&from=2026-10-19&days=7');
  const byDate = Object.fromEntries(data.days.map((d) => [d.date, d.status]));
  assert.equal(byDate['2026-10-19'], 'closed');
  assert.equal(byDate['2026-10-21'], 'free');
});

test('booking needs an account', async () => {
  const res = await client()('POST', '/api/bookings', { serviceId: 'classic-1-1', date: '2026-10-21', time: '10:00', payment: 'test' });
  assert.equal(res.status, 401);
});

test('register, see yourself, book, and the time is gone for others', async () => {
  assert.equal((await register(anna, 'Anna Test', 'anna@example.com')).status, 201);
  assert.equal((await anna('GET', '/api/auth/me')).data.user.email, 'anna@example.com');

  const booked = await anna('POST', '/api/bookings', { serviceId: 'classic-1-1', date: '2026-10-21', time: '10:00', payment: 'test' });
  assert.equal(booked.status, 201);
  assert.equal(booked.data.booking.endTime, '12:30');
  assert.ok(mails.some((m) => m.includes('Terminbestätigung')));

  await register(ben, 'Ben Test', 'ben@example.com');
  const clash = await ben('POST', '/api/bookings', { serviceId: 'lash-lifting', date: '2026-10-21', time: '12:00', payment: 'test' });
  assert.equal(clash.status, 409, 'overlaps Anna from 10:00 to 12:30');
  assert.equal(clash.data.code, 'slot_taken', 'errors carry a code the pages translate');

  const { data } = await ben('GET', '/api/availability/times?service=lash-lifting&date=2026-10-21');
  const free = data.times.filter((t) => t.free).map((t) => t.time);
  assert.ok(!free.includes('10:00') && !free.includes('12:15'));
  assert.ok(free.includes('12:30'));
});

test('the same email cannot register twice', async () => {
  assert.equal((await register(client(), 'Copy', 'ANNA@example.com')).status, 409);
});

test('a gift voucher replaces the deposit once', async () => {
  assert.equal((await ben('POST', '/api/vouchers/check', { code: 'gift-1' })).data.valid, true);
  const first = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-22', time: '10:00', payment: 'voucher', voucherCode: 'gift-1' });
  assert.equal(first.status, 201);
  assert.equal(first.data.booking.payment.depositEur, 0);
  const again = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-23', time: '10:00', payment: 'voucher', voucherCode: 'GIFT-1' });
  assert.equal(again.status, 400);
});

test('cancelling 48 hours ahead refunds the deposit; later it does not', async () => {
  const early = await anna('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-28', time: '10:00', payment: 'test' });
  const cancelled = await anna('POST', `/api/bookings/${early.data.booking.id}/cancel`);
  assert.equal(cancelled.data.booking.status, 'cancelled');
  assert.equal(cancelled.data.booking.depositRefunded, true);

  clockTime = new Date('2026-10-20T10:00:00Z'); // Tuesday 12:00, 22 hours before Wednesday 10:00
  const soon = (await anna('GET', '/api/bookings/mine')).data.bookings.find((b) => b.date === '2026-10-21');
  const late = await anna('POST', `/api/bookings/${soon.id}/cancel`);
  assert.equal(late.data.booking.status, 'cancelled');
  assert.equal(late.data.booking.depositRefunded, false);
});

test('nobody can cancel someone else\'s booking', async () => {
  const bens = (await ben('GET', '/api/bookings/mine')).data.bookings[0];
  assert.equal((await anna('POST', `/api/bookings/${bens.id}/cancel`)).status, 404);
});

test('wrong passwords fail, and a forgotten password can be reset', async () => {
  const guest = client();
  assert.equal((await guest('POST', '/api/auth/login', { email: 'anna@example.com', password: 'falsch123' })).status, 401);

  await guest('POST', '/api/auth/forgot', { email: 'anna@example.com' });
  const token = mails.at(-1).match(/reset=([\w-]+)/)[1];
  assert.equal((await guest('POST', '/api/auth/reset', { token, password: 'neues-passwort' })).status, 204);
  assert.equal((await guest('POST', '/api/auth/login', { email: 'anna@example.com', password: 'neues-passwort' })).status, 200);
  assert.equal((await guest('POST', '/api/auth/reset', { token, password: 'nochmal-neu' })).status, 400, 'a reset link works once');
});

test('logging out ends the session', async () => {
  assert.equal((await anna('POST', '/api/auth/logout')).status, 204);
  assert.equal((await anna('GET', '/api/auth/me')).data.user, null);
  assert.equal((await anna('GET', '/api/bookings/mine')).status, 401);
});

test('stored passwords and tokens are never in plain text', () => {
  const raw = JSON.stringify(store.data);
  assert.ok(!raw.includes('geheim123') && !raw.includes('neues-passwort'));
  assert.ok(store.data.users.every((u) => u.passwordHash.startsWith('scrypt:')));
});
