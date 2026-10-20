// HTTP routes: salon data, free times, accounts and bookings.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { addDays, dayStatus, localNow, timesForDay, toHHMM, toMinutes } from './availability.js';
import {
  SESSION_COOKIE, SESSION_DAYS, clearSessionCookie, hashPassword, newToken, readCookie,
  setSessionCookie, tokenHash, verifyPassword,
} from './auth.js';

// Errors carry a code; the pages translate it into the visitor's language.
// The German text is only a fallback for API users.
const MESSAGES = {
  unauthorized: 'Bitte melde dich an.',
  unknown_service: 'Diesen Service gibt es nicht.',
  invalid_date: 'Datum ist ungültig.',
  invalid_datetime: 'Datum oder Uhrzeit ist ungültig.',
  invalid_name: 'Name ist ungültig.',
  invalid_email: 'E-Mail ist ungültig.',
  invalid_phone: 'Telefonnummer ist ungültig.',
  short_password: 'Das Passwort braucht mindestens 8 Zeichen.',
  email_taken: 'Für diese E-Mail gibt es schon ein Konto.',
  too_many_attempts: 'Zu viele Versuche. Bitte warte 15 Minuten.',
  wrong_login: 'E-Mail oder Passwort ist falsch.',
  reset_expired: 'Der Link ist abgelaufen. Bitte fordere einen neuen an.',
  slot_taken: 'Dieser Termin ist leider nicht mehr frei. Bitte wähle eine andere Uhrzeit.',
  invalid_voucher: 'Dieser Gutschein ist ungültig oder schon eingelöst.',
  payment_required: 'Bitte wähle eine Zahlungsart für die Anzahlung.',
  booking_not_found: 'Diese Buchung gibt es nicht.',
  already_cancelled: 'Diese Buchung ist schon storniert.',
  past_booking: 'Vergangene Termine können nicht storniert werden.',
  not_found: 'Nicht gefunden.',
  bad_request: 'Ungültige Anfrage.',
  too_large: 'Anfrage zu groß.',
  server_error: 'Interner Fehler. Bitte versuche es später noch einmal.',
};

class HttpError extends Error {
  constructor(status, code) {
    super(MESSAGES[code]);
    this.status = status;
    this.code = code;
  }
}

const sendError = (res, status, code) => res.status(status).json({ error: MESSAGES[code], code });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A trimmed string of the right length, or an "invalid_<field>" error. */
function text(value, field, { min = 1, max = 200 } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length < min || v.length > max) throw new HttpError(400, `invalid_${field}`);
  return v;
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone };
}

/** Minutes from `now` until a local date and minute-of-day. */
function minutesUntil(date, minutes, now) {
  const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${now.date}T00:00:00Z`)) / DAY_MS;
  return days * 1440 + minutes - now.minutes;
}

/**
 * @param {object} deps
 * @param {import('./store.js').Store} deps.store
 * @param {object} deps.salon     content/salon.json
 * @param {object} deps.catalog   content/services.json
 * @param {Array}  deps.manifest  public/images/manifest.json
 * @param {() => Date} [deps.clock]
 * @param {(msg: string) => void} [deps.mail]  sends an email (prints it during development)
 */
export function createApp({ store, salon, catalog, manifest, clock = () => new Date(), mail = console.log }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  const services = new Map(catalog.categories.flatMap((c) => c.services.map((s) => [s.id, { ...s, category: c.id }])));
  const now = () => localNow(clock(), salon.timeZone);
  const failedLogins = new Map(); // email -> { count, until }

  function serviceFrom(id) {
    const service = services.get(id);
    if (!service) throw new HttpError(404, 'unknown_service');
    return service;
  }

  function bookingsOn(date) {
    return store.data.bookings.filter((b) => b.date === date && b.status === 'confirmed');
  }

  function times(service, date) {
    return timesForDay({ date, durationMin: service.durationMin, salon, bookings: bookingsOn(date), now: now() });
  }

  // Who is logged in (or null)
  app.use((req, res, next) => {
    req.user = null;
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const hash = tokenHash(token);
      const session = store.data.sessions.find((s) => s.tokenHash === hash && s.expiresAt > clock().getTime());
      if (session) req.user = store.data.users.find((u) => u.id === session.userId) || null;
    }
    next();
  });

  const requireUser = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'unauthorized')));

  // ---- Salon data -----------------------------------------------------------

  app.get('/api/salon', (req, res) => res.json(salon));
  app.get('/api/services', (req, res) => res.json(catalog));

  app.get('/api/gallery', (req, res) => {
    const groups = {};
    for (const { file, group } of manifest) {
      if (!group.startsWith('gallery/')) continue;
      (groups[group.slice('gallery/'.length)] ??= []).push(`/${file}`);
    }
    res.json(groups);
  });

  // ---- Free times ---------------------------------------------------------

  app.get('/api/availability/days', (req, res) => {
    const service = serviceFrom(String(req.query.service || ''));
    const today = now();
    const from = DATE.test(req.query.from || '') ? req.query.from : today.date;
    const count = Math.min(Math.max(Number(req.query.days) || 28, 1), 42);
    const days = Array.from({ length: count }, (_, i) => {
      const date = addDays(from, i);
      return { date, status: dayStatus(times(service, date), date, today) };
    });
    res.json({ service: service.id, days });
  });

  app.get('/api/availability/times', (req, res) => {
    const service = serviceFrom(String(req.query.service || ''));
    const date = String(req.query.date || '');
    if (!DATE.test(date)) throw new HttpError(400, 'invalid_date');
    res.json({ service: service.id, date, times: times(service, date) });
  });

  // ---- Accounts -----------------------------------------------------------

  function startSession(res, user, remember) {
    const token = newToken();
    const expiresAt = clock().getTime() + (remember ? SESSION_DAYS : 1) * DAY_MS;
    store.change((d) => {
      d.sessions = d.sessions.filter((s) => s.expiresAt > clock().getTime());
      d.sessions.push({ tokenHash: tokenHash(token), userId: user.id, expiresAt });
    });
    setSessionCookie(res, token, remember);
  }

  app.post('/api/auth/register', (req, res) => {
    const name = text(req.body?.name, 'name', { min: 2, max: 80 });
    const email = text(req.body?.email, 'email', { max: 200 }).toLowerCase();
    const phone = text(req.body?.phone, 'phone', { min: 6, max: 30 });
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email');
    if (!/^[+\d][\d\s/()-]{5,}$/.test(phone)) throw new HttpError(400, 'invalid_phone');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'short_password');
    if (store.data.users.some((u) => u.email === email)) throw new HttpError(409, 'email_taken');

    const user = { id: `u_${randomBytes(8).toString('hex')}`, name, email, phone, passwordHash: hashPassword(password), createdAt: clock().toISOString() };
    store.change((d) => d.users.push(user));
    startSession(res, user, true);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const blocked = failedLogins.get(email);
    if (blocked && blocked.count >= 5 && blocked.until > clock().getTime()) {
      throw new HttpError(429, 'too_many_attempts');
    }
    const user = store.data.users.find((u) => u.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const entry = blocked && blocked.until > clock().getTime() ? blocked : { count: 0 };
      failedLogins.set(email, { count: entry.count + 1, until: clock().getTime() + 15 * 60 * 1000 });
      throw new HttpError(401, 'wrong_login');
    }
    failedLogins.delete(email);
    startSession(res, user, req.body?.remember !== false);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) store.change((d) => { d.sessions = d.sessions.filter((s) => s.tokenHash !== tokenHash(token)); });
    clearSessionCookie(res);
    res.status(204).end();
  });

  // Not being logged in is a normal answer here, not an error
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

  // Always answers the same, so nobody can find out which emails have an account.
  app.post('/api/auth/forgot', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = store.data.users.find((u) => u.email === email);
    if (user) {
      const token = newToken();
      store.change((d) => {
        d.resets = d.resets.filter((r) => r.userId !== user.id && r.expiresAt > clock().getTime());
        d.resets.push({ tokenHash: tokenHash(token), userId: user.id, expiresAt: clock().getTime() + 60 * 60 * 1000 });
      });
      mail(`[E-Mail an ${user.email}] Passwort zurücksetzen: /login.html?reset=${token} (1 Stunde gültig)`);
    }
    res.status(204).end();
  });

  app.post('/api/auth/reset', (req, res) => {
    const hash = tokenHash(String(req.body?.token || ''));
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'short_password');
    const reset = store.data.resets.find((r) => r.tokenHash === hash && r.expiresAt > clock().getTime());
    if (!reset) throw new HttpError(400, 'reset_expired');
    store.change((d) => {
      d.users.find((u) => u.id === reset.userId).passwordHash = hashPassword(password);
      d.resets = d.resets.filter((r) => r !== reset);
      d.sessions = d.sessions.filter((s) => s.userId !== reset.userId);
    });
    res.status(204).end();
  });

  // ---- Bookings -----------------------------------------------------------

  app.post('/api/vouchers/check', (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const voucher = store.data.vouchers.find((v) => v.code === code && !v.usedBy);
    res.json({ valid: Boolean(voucher) });
  });

  app.get('/api/bookings/mine', requireUser, (req, res) => {
    const mine = store.data.bookings
      .filter((b) => b.userId === req.user.id)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    res.json({ bookings: mine });
  });

  app.post('/api/bookings', requireUser, (req, res) => {
    const service = serviceFrom(String(req.body?.serviceId || ''));
    const date = String(req.body?.date || '');
    const time = String(req.body?.time || '');
    if (!DATE.test(date) || !TIME.test(time)) throw new HttpError(400, 'invalid_datetime');
    const slot = times(service, date).find((t) => t.time === time);
    if (!slot?.free) throw new HttpError(409, 'slot_taken');

    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    let payment;
    if (req.body?.payment === 'voucher') {
      const code = String(req.body?.voucherCode || '').trim().toUpperCase();
      const voucher = store.data.vouchers.find((v) => v.code === code && !v.usedBy);
      if (!voucher) throw new HttpError(400, 'invalid_voucher');
      payment = { method: 'voucher', voucherCode: code, depositEur: 0 };
    } else if (req.body?.payment === 'test') {
      payment = { method: 'test', depositEur: salon.booking.depositEur };
    } else {
      throw new HttpError(400, 'payment_required');
    }

    const start = toMinutes(time);
    const booking = {
      id: `b_${randomBytes(6).toString('hex')}`,
      userId: req.user.id,
      serviceId: service.id,
      serviceName: service.name.de,
      durationMin: service.durationMin,
      priceEur: service.priceEur,
      date,
      time,
      start,
      end: start + service.durationMin,
      endTime: toHHMM(start + service.durationMin),
      note,
      payment,
      status: 'confirmed',
      createdAt: clock().toISOString(),
    };
    store.change((d) => {
      d.bookings.push(booking);
      if (payment.method === 'voucher') d.vouchers.find((v) => v.code === payment.voucherCode).usedBy = booking.id;
    });
    mail(`[E-Mail an ${req.user.email}] Terminbestätigung: ${service.name.de} am ${date} um ${time} Uhr (Buchung ${booking.id})`);
    res.status(201).json({ booking });
  });

  app.post('/api/bookings/:id/cancel', requireUser, (req, res) => {
    const booking = store.data.bookings.find((b) => b.id === req.params.id && b.userId === req.user.id);
    if (!booking) throw new HttpError(404, 'booking_not_found');
    if (booking.status !== 'confirmed') throw new HttpError(409, 'already_cancelled');
    const minutesLeft = minutesUntil(booking.date, booking.start, now());
    if (minutesLeft <= 0) throw new HttpError(409, 'past_booking');
    const refund = minutesLeft >= salon.booking.freeCancelHours * 60;
    store.change(() => {
      booking.status = 'cancelled';
      booking.cancelledAt = clock().toISOString();
      booking.depositRefunded = refund && booking.payment.depositEur > 0;
    });
    res.json({ booking });
  });

  // ---- Errors -------------------------------------------------------------

  app.use('/api', (req, res) => sendError(res, 404, 'not_found'));

  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return sendError(res, err.status, err.code);
    if (err.type === 'entity.parse.failed') return sendError(res, 400, 'bad_request');
    if (err.type === 'entity.too.large') return sendError(res, 413, 'too_large');
    console.error(err);
    sendError(res, 500, 'server_error');
  });

  return app;
}
