import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
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
store.data.users.push({ id: 'u_admin', name: 'Melissa', email: 'admin@example.com', phone: '', role: 'admin', passwordHash: hashPassword('admin-pass') });
const uploadsDir = mkdtempSync(join(tmpdir(), 'yehmee-test-'));

// Stand-in for SumUp and PayPal: each checkout's result is set by the test
const checkouts = new Map(); // id → { status, amountEur, provider }
const fakeProvider = (name) => ({
  name,
  async create({ amountEur }) {
    if (name === 'broken') throw new Error('provider down');
    const id = `${name}_${checkouts.size + 1}`;
    checkouts.set(id, { status: 'pending', amountEur, provider: name });
    return { id, redirectUrl: `https://pay.example/${id}` };
  },
  async verify(id) { return checkouts.get(id).status; },
});
const payments = { providers: { card: fakeProvider('sumup'), paypal: fakeProvider('paypal') } };
const app = createApp({ store, salon, catalog, manifest, uploadsDir, payments, clock: () => clockTime, mail: (m) => mails.push(`${m.to} ${m.subject}\n${m.text}`) });

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
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const isJson = res.headers.get('content-type')?.includes('json');
    const data = isJson ? await res.json() : null;
    return { status: res.status, data, location: res.headers.get('location') };
  };
}

const anna = client();
const ben = client();
const register = (c, name, email) => c('POST', '/api/auth/register', { name, email, phone: '+49 151 1234567', password: 'geheim123' });

/** The customer comes back from the payment page; returns where the site sends them. */
const comeBack = (c, kind, ref, path = 'return') => c('GET', `/api/payments/${path}?kind=${kind}&ref=${ref}`);
const checkoutOf = (booking) => checkouts.get(store.data.bookings.find((b) => b.id === booking.id).payment.ref);

/** Books with the deposit paid by card, the way a customer does it end to end. */
async function bookAndPay(c, body) {
  const res = await c('POST', '/api/bookings', { payment: 'card', ...body });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  checkoutOf(res.data.booking).status = 'paid';
  await comeBack(c, 'booking', res.data.booking.id);
  return (await c('GET', '/api/bookings/mine')).data.bookings.find((b) => b.id === res.data.booking.id);
}

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
  const res = await client()('POST', '/api/bookings', { serviceId: 'classic-1-1', date: '2026-10-21', time: '10:00', payment: 'card' });
  assert.equal(res.status, 401);
});

test('register, see yourself, book, and the time is gone for others', async () => {
  assert.equal((await register(anna, 'Anna Test', 'anna@example.com')).status, 201);
  assert.equal((await anna('GET', '/api/auth/me')).data.user.email, 'anna@example.com');

  const booked = await bookAndPay(anna, { serviceId: 'classic-1-1', date: '2026-10-21', time: '10:00' });
  assert.equal(booked.status, 'confirmed');
  assert.equal(booked.endTime, '12:30');
  assert.ok(mails.some((m) => m.includes('Terminbestätigung')));

  await register(ben, 'Ben Test', 'ben@example.com');
  const clash = await ben('POST', '/api/bookings', { serviceId: 'lash-lifting', date: '2026-10-21', time: '12:00', payment: 'card' });
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

test('only the offered payment methods are accepted', async () => {
  const { data } = await client()('GET', '/api/payments/methods');
  assert.deepEqual(data, { methods: ['card', 'paypal'], testMode: false });
  for (const payment of [undefined, 'test', 'cash']) {
    const res = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-23', time: '10:00', payment });
    assert.equal(res.status, 400, String(payment));
  }
});

test('card deposit: the time is held while paying and booked once SumUp confirms', async () => {
  const res = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-23', time: '14:00', payment: 'card' });
  assert.equal(res.status, 201);
  assert.match(res.data.redirectUrl, /^https:\/\/pay\.example\/sumup_/);
  const { booking } = res.data;
  assert.equal(booking.status, 'pending');
  assert.equal(checkoutOf(booking).amountEur, salon.booking.depositEur);

  const taken = await anna('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-23', time: '14:00', payment: 'card' });
  assert.equal(taken.status, 409, 'held for Ben while he pays');

  // Coming back before SumUp has the money changes nothing
  assert.equal((await comeBack(ben, 'booking', booking.id)).location, `/buchen?booked=${booking.id}`);
  assert.equal(store.data.bookings.find((b) => b.id === booking.id).status, 'pending');
  assert.ok(!mails.some((m) => m.includes(booking.id)), 'no confirmation before payment');

  checkoutOf(booking).status = 'paid';
  assert.equal((await comeBack(ben, 'booking', booking.id)).location, `/buchen?booked=${booking.id}`);
  await comeBack(ben, 'booking', booking.id);
  const mine = (await ben('GET', '/api/bookings/mine')).data.bookings.find((b) => b.id === booking.id);
  assert.equal(mine.status, 'confirmed');
  assert.ok(mine.payment.paidAt);
  assert.equal(mails.filter((m) => m.includes(booking.id)).length, 1, 'one confirmation, even when coming back twice');
});

test('a payment notification confirms the booking when the customer never comes back', async () => {
  const res = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-23', time: '10:00', payment: 'card' });
  const stored = () => store.data.bookings.find((b) => b.id === res.data.booking.id);

  await app.locals.settlePayment(stored().payment.ref); // notified before the money is there
  assert.equal(stored().status, 'pending');
  await app.locals.settlePayment('unknown-ref'); // ignored

  checkoutOf(res.data.booking).status = 'paid';
  // The notification and the customer's return arrive at the same moment
  await Promise.all([app.locals.settlePayment(stored().payment.ref), comeBack(ben, 'booking', res.data.booking.id)]);
  assert.equal(stored().status, 'confirmed');
  const confirmations = mails.filter((m) => m.includes(res.data.booking.id));
  assert.equal(confirmations.length, 1, 'one confirmation');
  assert.match(confirmations[0], /^ben@example\.com Terminbestätigung: Permanentlack am 23\.10\.2026/);
});

test('nobody else can complete or cancel your payment', async () => {
  const res = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-23', time: '16:00', payment: 'paypal' });
  assert.equal((await comeBack(anna, 'booking', res.data.booking.id, 'cancel')).status, 404);
  assert.match((await comeBack(client(), 'booking', res.data.booking.id)).location, /^\/login\?next=/);
  assert.equal(store.data.bookings.find((b) => b.id === res.data.booking.id).status, 'pending');
  await comeBack(ben, 'booking', res.data.booking.id, 'cancel'); // tidy up
});

test('a declined or cancelled payment books nothing and frees the time', async () => {
  const declined = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-24', time: '10:00', payment: 'paypal' });
  assert.match(declined.data.redirectUrl, /paypal_/);
  checkoutOf(declined.data.booking).status = 'failed';
  const back = await comeBack(ben, 'booking', declined.data.booking.id);
  assert.equal(back.location, '/buchen?service=gel-polish&date=2026-10-24&time=10:00&payment=failed');

  const tried = await anna('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-24', time: '10:00', payment: 'card' });
  assert.equal(tried.status, 201, 'the time is free again');
  assert.match((await comeBack(anna, 'booking', tried.data.booking.id, 'cancel')).location, /payment=cancelled$/);

  const { data } = await ben('GET', '/api/availability/times?service=gel-polish&date=2026-10-24');
  assert.ok(data.times.find((t) => t.time === '10:00').free);
  const bens = (await ben('GET', '/api/bookings/mine')).data.bookings;
  assert.ok(!bens.some((b) => b.id === declined.data.booking.id), 'a failed payment is not an appointment');
});

test('an unpaid reservation runs out after 30 minutes', async () => {
  const start = clockTime;
  await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-24', time: '14:00', payment: 'card' });
  const freeAt = async () => (await ben('GET', '/api/availability/times?service=gel-polish&date=2026-10-24')).data.times.find((t) => t.time === '14:00').free;
  assert.equal(await freeAt(), false);
  clockTime = new Date(start.getTime() + 31 * 60 * 1000);
  assert.equal(await freeAt(), true);
  clockTime = start;
});

test('paying after the reservation ran out, when the time is gone, is refunded', async () => {
  const start = clockTime;
  const slow = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-24', time: '16:00', payment: 'card' });
  clockTime = new Date(start.getTime() + 31 * 60 * 1000);
  assert.equal((await bookAndPay(anna, { serviceId: 'gel-polish', date: '2026-10-24', time: '16:00' })).status, 'confirmed');

  checkoutOf(slow.data.booking).status = 'paid';
  assert.match((await comeBack(ben, 'booking', slow.data.booking.id)).location, /payment=late$/);
  const stored = store.data.bookings.find((b) => b.id === slow.data.booking.id);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.depositRefunded, true);
  assert.ok(mails.at(-1).includes('erstatten') && mails.at(-1).includes(stored.payment.ref), 'the salon is told to refund');
  clockTime = start;
});

test('when the payment provider is down, nothing is held', async () => {
  const card = payments.providers.card;
  payments.providers.card = fakeProvider('broken');
  const errors = console.error;
  console.error = () => {};
  try {
    const res = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-29', time: '10:00', payment: 'card' });
    assert.equal(res.status, 502);
    assert.equal(res.data.code, 'payment_unavailable');
  } finally {
    payments.providers.card = card;
    console.error = errors;
  }
  const { data } = await ben('GET', '/api/availability/times?service=gel-polish&date=2026-10-29');
  assert.ok(data.times.find((t) => t.time === '10:00').free);
});

test('a gift voucher bought online with SumUp works once it is paid', async () => {
  const guest = client();
  const order = { amountEur: 50, buyerName: 'Clara', buyerEmail: 'Clara@Example.com', recipient: 'Mia' };
  assert.equal((await guest('POST', '/api/vouchers/purchase', { ...order, amountEur: 30 })).data.code, 'invalid_amount');
  assert.equal((await guest('POST', '/api/vouchers/purchase', { ...order, buyerEmail: 'nope' })).data.code, 'invalid_email');

  const bought = await guest('POST', '/api/vouchers/purchase', order);
  assert.equal(bought.status, 201);
  assert.match(bought.data.redirectUrl, /sumup_/);
  const voucher = store.data.vouchers.at(-1);
  assert.equal(checkouts.get(voucher.paymentRef).amountEur, 50);

  const before = (await guest('GET', `/api/vouchers/purchase/${voucher.purchaseRef}`)).data;
  assert.deepEqual({ status: before.status, code: before.code }, { status: 'pending', code: null }, 'no code before payment');
  assert.equal((await ben('POST', '/api/vouchers/check', { code: voucher.code })).data.valid, false);

  checkouts.get(voucher.paymentRef).status = 'paid';
  assert.equal((await comeBack(guest, 'voucher', voucher.purchaseRef)).location, `/gutschein?bought=${voucher.purchaseRef}`);
  const after = (await guest('GET', `/api/vouchers/purchase/${voucher.purchaseRef}`)).data;
  assert.equal(after.status, 'active');
  assert.equal(after.code, voucher.code);
  assert.ok(mails.at(-1).includes('clara@example.com') && mails.at(-1).includes(voucher.code), 'the code is emailed');

  const used = await ben('POST', '/api/bookings', { serviceId: 'gel-polish', date: '2026-10-30', time: '10:00', payment: 'voucher', voucherCode: voucher.code.toLowerCase() });
  assert.equal(used.status, 201);
  assert.equal(used.data.booking.status, 'confirmed');
  assert.equal(used.data.booking.payment.depositEur, 0);
});

test('a voucher purchase that is not paid gives no code', async () => {
  const guest = client();
  await guest('POST', '/api/vouchers/purchase', { amountEur: 50, buyerName: 'Dora', buyerEmail: 'dora@example.com' });
  const voucher = store.data.vouchers.at(-1);
  assert.equal((await comeBack(guest, 'voucher', voucher.purchaseRef, 'cancel')).location, '/gutschein?payment=cancelled');
  assert.equal((await guest('GET', `/api/vouchers/purchase/${voucher.purchaseRef}`)).data.code, null);
  assert.equal((await ben('POST', '/api/vouchers/check', { code: voucher.code })).data.valid, false);
  assert.equal((await guest('GET', '/api/vouchers/purchase/0123456789abcdef0123456789abcdef')).status, 404);
});

test('the admin enters vouchers sold in the salon', async () => {
  assert.equal((await ben('GET', '/api/admin/vouchers')).status, 404, 'customers do not see it');
  assert.equal((await ben('POST', '/api/admin/vouchers', { amountEur: 40 })).status, 404);

  const admin = client();
  await admin('POST', '/api/auth/login', { email: 'admin@example.com', password: 'admin-pass' });
  const made = await admin('POST', '/api/admin/vouchers', { amountEur: 40, code: 'salon-77', note: 'SumUp-Beleg 0815' });
  assert.equal(made.status, 201);
  assert.equal(made.data.voucher.code, 'SALON-77');
  assert.equal((await admin('POST', '/api/admin/vouchers', { amountEur: 40, code: 'SALON-77' })).data.code, 'voucher_exists');
  assert.equal((await admin('POST', '/api/admin/vouchers', { amountEur: 40, code: 'a b' })).data.code, 'invalid_code');
  assert.equal((await admin('POST', '/api/admin/vouchers', { amountEur: 0 })).data.code, 'invalid_amount');
  assert.match((await admin('POST', '/api/admin/vouchers', { amountEur: 60 })).data.voucher.code, /^YM-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const { vouchers } = (await admin('GET', '/api/admin/vouchers')).data;
  assert.equal(vouchers.find((v) => v.code === 'SALON-77').state, 'active');
  assert.equal(vouchers.find((v) => v.source === 'online' && v.recipient === 'Mia').state, 'used');
  assert.ok(!vouchers.some((v) => v.buyerName === 'Dora'), 'unpaid purchases are not listed');
  assert.equal((await ben('POST', '/api/vouchers/check', { code: 'salon-77' })).data.valid, true);
});

test('cancelling 48 hours ahead refunds the deposit; later it does not', async () => {
  const early = await bookAndPay(anna, { serviceId: 'gel-polish', date: '2026-10-28', time: '10:00' });
  const cancelled = await anna('POST', `/api/bookings/${early.id}/cancel`);
  assert.equal(cancelled.data.booking.status, 'cancelled');
  assert.equal(cancelled.data.booking.depositRefunded, true);
  assert.ok(mails.at(-1).includes('erstatten'), 'the salon is told to refund in SumUp');

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
