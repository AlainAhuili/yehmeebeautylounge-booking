// HTTP routes: salon data, free times, accounts and bookings.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { addDays, dayStatus, localNow, timesForDay, toHHMM, toMinutes } from './availability.js';
import { diskMedia } from './media.js';
import { printMail } from './mailer.js';
import {
  SESSION_COOKIE, SESSION_DAYS, clearSessionCookie, hashPassword, newToken, readCookie,
  setSessionCookie, tokenHash, verifyPassword,
} from './auth.js';

// Errors carry a code; the pages translate it into the visitor's language.
// The German text is only a fallback for API users.
const MESSAGES = {
  unauthorized: 'Bitte melde dich an.',
  forbidden: 'Dafür brauchst du ein Admin-Konto.',
  invalid_image: 'Bitte lade ein JPG-, PNG- oder WebP-Bild hoch.',
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
  payment_unavailable: 'Die Zahlung ist gerade nicht möglich. Bitte versuche es später noch einmal.',
  invalid_amount: 'Bitte wähle einen gültigen Betrag.',
  invalid_code: 'Der Code darf nur Buchstaben, Ziffern und Bindestriche haben (4 bis 32 Zeichen).',
  voucher_exists: 'Diesen Gutscheincode gibt es schon.',
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
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, isAdmin: u.role === 'admin' };
}

// Uploaded images are recognised by their first bytes, not by name or Content-Type.
const IMAGE_TYPES = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', test: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
 * @param {string} [deps.uploadsDir]  folder for uploaded photos (served at /media), unless deps.media is given
 * @param {import('./media.js').Media} [deps.media]  where uploaded photos are kept (src/media.js)
 * @param {string} [deps.adminDir]  private folder with the admin page (served at /admin to admins only)
 * @param {() => Date} [deps.clock]
 * @param {(mail: import('./mailer.js').Mail) => void} [deps.mail]  sends an email (src/mailer.js; printed during development)
 * @param {{ providers: Record<string, object> }} [deps.payments]  online payment providers (src/payments.js)
 * @param {string} [deps.publicUrl]  the site's address for payment return links; otherwise taken from the request
 */
export function createApp({
  store, salon, catalog, manifest, uploadsDir, media = diskMedia(uploadsDir), adminDir, clock = () => new Date(),
  mail = printMail, payments = { providers: {} }, publicUrl,
}) {
  const app = express();
  app.disable('x-powered-by');
  // Behind nginx: the original scheme comes in X-Forwarded-Proto (for return links)
  app.set('trust proxy', 'loopback');

  // Security headers for every response, pages and API alike
  app.use((req, res, next) => {
    res.set({
      // Only our own scripts run; styles and fonts from Google Fonts; the map frame from Google
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        'frame-src https://maps.google.com https://www.google.com',
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    next();
  });

  // Changes (POST/PUT/DELETE) must come from our own pages. Browsers send an Origin
  // header with such requests; one from another website is refused.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('Origin');
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* malformed: refused below */ }
      if (host !== req.get('Host')) return sendError(res, 403, 'forbidden');
    }
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  const services = new Map(catalog.categories.flatMap((c) => c.services.map((s) => [s.id, { ...s, category: c.id }])));
  const now = () => localNow(clock(), salon.timeZone);
  const failedLogins = new Map(); // email -> { count, until }

  function serviceFrom(id) {
    const service = services.get(id);
    if (!service) throw new HttpError(404, 'unknown_service');
    return service;
  }

  // A booking blocks its time when confirmed, or while its deposit is being paid
  const blocksTime = (b) => b.status === 'confirmed' || (b.status === 'pending' && b.holdUntil > clock().getTime());

  function bookingsOn(date) {
    return store.data.bookings.filter((b) => b.date === date && blocksTime(b));
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
  // The admin area is invisible to everyone else: its pages and its API answer
  // "not found", exactly like an address that does not exist.
  const isAdmin = (req) => req.user?.role === 'admin';
  const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : next(new HttpError(404, 'not_found')));

  if (adminDir) {
    const adminFiles = express.static(adminDir, { index: 'index.html', redirect: false });
    app.use('/admin', (req, res, next) => {
      if (!isAdmin(req)) return next(); // on to the site's normal 404
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
      if (req.path === '/' || req.path === '/index.html') return res.sendFile(join(adminDir, 'index.html'));
      return adminFiles(req, res, next);
    });
  }

  // ---- Salon data -----------------------------------------------------------

  app.get('/api/salon', (req, res) => res.json(salon));

  // The catalog plus each service's photo: the admin's upload, otherwise the
  // default photo from services.json (imageIsDefault tells the pages which one)
  function withImage(s) {
    const uploaded = store.data.serviceImages[s.id];
    if (uploaded) return { ...s, image: `/media/services/${uploaded.file}`, imageIsDefault: false };
    if (s.defaultImage) return { ...s, image: s.defaultImage, imageIsDefault: true };
    return s;
  }

  app.get('/api/services', (req, res) => {
    res.json({ ...catalog, categories: catalog.categories.map((c) => ({ ...c, services: c.services.map(withImage) })) });
  });

  // ---- Service photos (admin) -----------------------------------------------

  app.use('/media/services', media.serve('services'));

  async function removePhoto(serviceId) {
    const old = store.data.serviceImages[serviceId];
    if (old) await media.remove('services', old.file);
  }

  const rawImage = express.raw({ type: () => true, limit: MAX_IMAGE_BYTES });

  /** The uploaded image and its file extension, or an invalid_image error. */
  function imageFrom(req) {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const type = IMAGE_TYPES.find((t) => body.length > 12 && t.test(body));
    if (!type) throw new HttpError(400, 'invalid_image');
    return { body, ext: type.ext };
  }

  // A new random name on every upload, so browsers never show an old cached photo
  const newFileName = (prefix, ext) => `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}.${ext}`;

  app.put(
    '/api/admin/services/:id/image',
    requireAdmin,
    rawImage,
    async (req, res) => {
      const service = serviceFrom(req.params.id);
      const { body, ext } = imageFrom(req);
      const file = newFileName(service.id, ext);
      await media.save('services', file, body);
      await removePhoto(service.id);
      store.change((d) => { d.serviceImages[service.id] = { file, uploadedAt: clock().toISOString(), uploadedBy: req.user.id }; });
      res.json({ image: `/media/services/${file}` });
    },
  );

  app.delete('/api/admin/services/:id/image', requireAdmin, async (req, res) => {
    const service = serviceFrom(req.params.id);
    await removePhoto(service.id);
    store.change((d) => { delete d.serviceImages[service.id]; });
    res.status(204).end();
  });

  // ---- Gallery -----------------------------------------------------------------
  // Built-in photos come from the project (manifest.json); deleting one only hides
  // it, because a new deployment would bring the file back. Uploaded photos live in
  // the uploads folder and are really deleted. Newest uploads come first.

  const GALLERY_SECTIONS = ['featured', 'nails', 'lashes'];
  app.use('/media/gallery', media.serve('gallery'));

  const builtIn = manifest
    .filter((m) => m.group.startsWith('gallery/'))
    .map((m) => ({ id: `b-${m.file.split('/').pop().replace(/\.\w+$/, '')}`, section: m.group.slice('gallery/'.length), src: `/${m.file}`, builtIn: true }));

  function galleryItems() {
    const { uploads, hidden } = store.data.gallery;
    const uploaded = uploads.map((u) => ({ id: u.id, section: u.section, src: `/media/gallery/${u.file}`, builtIn: false, hidden: false }));
    return [...uploaded.reverse(), ...builtIn.map((b) => ({ ...b, hidden: hidden.includes(b.id) }))];
  }

  const bySection = (items) => Object.fromEntries(GALLERY_SECTIONS.map((s) => [s, items.filter((i) => i.section === s)]));

  // Public: visible photos only, as plain addresses
  app.get('/api/gallery', (req, res) => {
    const groups = bySection(galleryItems().filter((i) => !i.hidden));
    res.json(Object.fromEntries(Object.entries(groups).map(([s, items]) => [s, items.map((i) => i.src)])));
  });

  // Admin: every photo, including hidden ones, with its id
  app.get('/api/admin/gallery', requireAdmin, (req, res) => res.json(bySection(galleryItems())));

  app.post('/api/admin/gallery/:section', requireAdmin, rawImage, async (req, res) => {
    const section = req.params.section;
    if (!GALLERY_SECTIONS.includes(section)) throw new HttpError(404, 'not_found');
    const { body, ext } = imageFrom(req);
    const file = newFileName(section, ext);
    await media.save('gallery', file, body);
    const upload = { id: `g-${randomBytes(6).toString('hex')}`, section, file, uploadedAt: clock().toISOString(), uploadedBy: req.user.id };
    store.change((d) => d.gallery.uploads.push(upload));
    res.status(201).json({ photo: { id: upload.id, section, src: `/media/gallery/${file}`, builtIn: false, hidden: false } });
  });

  app.delete('/api/admin/gallery/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const upload = store.data.gallery.uploads.find((u) => u.id === id);
    if (upload) {
      await media.remove('gallery', upload.file);
      store.change((d) => { d.gallery.uploads = d.gallery.uploads.filter((u) => u !== upload); });
    } else if (builtIn.some((b) => b.id === id)) {
      store.change((d) => { if (!d.gallery.hidden.includes(id)) d.gallery.hidden.push(id); });
    } else {
      throw new HttpError(404, 'not_found');
    }
    res.status(204).end();
  });

  app.post('/api/admin/gallery/:id/restore', requireAdmin, (req, res) => {
    if (!builtIn.some((b) => b.id === req.params.id)) throw new HttpError(404, 'not_found');
    store.change((d) => { d.gallery.hidden = d.gallery.hidden.filter((h) => h !== req.params.id); });
    res.status(204).end();
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

  // Customers stay logged in for 30 days (1 day without "remember me");
  // admins at most 12 hours, so a forgotten admin login on a shared device expires.
  const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

  function startSession(res, user, remember) {
    const token = newToken();
    const lifetime = user.role === 'admin' ? ADMIN_SESSION_MS : (remember ? SESSION_DAYS : 1) * DAY_MS;
    const expiresAt = clock().getTime() + lifetime;
    store.change((d) => {
      d.sessions = d.sessions.filter((s) => s.expiresAt > clock().getTime());
      d.sessions.push({ tokenHash: tokenHash(token), userId: user.id, expiresAt });
    });
    setSessionCookie(res, token, remember || user.role === 'admin' ? lifetime : null);
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
      mail({
        to: user.email,
        subject: 'Passwort zurücksetzen – YehMee Beauty Lounge',
        text: `Hallo ${user.name},\n\nüber diesen Link kannst du ein neues Passwort festlegen (1 Stunde gültig):\n${siteUrl(req)}/login.html?reset=${token}\n\nWenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.\n\nYehMee Beauty Lounge`,
      });
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

  // A voucher bought online counts once it is paid; one sold in the salon at once
  const usableVoucher = (code) => store.data.vouchers.find((v) => v.code === code && !v.usedBy && (v.status ?? 'active') === 'active');

  app.post('/api/vouchers/check', (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    res.json({ valid: Boolean(usableVoucher(code)) });
  });

  // Attempts whose payment never went through are not appointments, so they are left out
  const isAppointment = (b) => (b.status === 'pending' ? blocksTime(b) : !b.cancelReason?.startsWith('payment_'));

  app.get('/api/bookings/mine', requireUser, (req, res) => {
    const mine = store.data.bookings
      .filter((b) => b.userId === req.user.id && isAppointment(b))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    res.json({ bookings: mine });
  });

  const HOLD_MS = 30 * 60 * 1000; // the time stays reserved this long while the customer pays
  const siteUrl = (req) => publicUrl || `${req.protocol}://${req.get('host')}`;

  /** Creates the provider's checkout; on failure the reservation is dropped. */
  async function startCheckout(provider, { reference, amountEur, description, returnPath, cancelPath, onFail }) {
    try {
      return await provider.create({ reference, amountEur, description, returnUrl: returnPath, cancelUrl: cancelPath });
    } catch (err) {
      console.error(err);
      onFail();
      throw new HttpError(502, 'payment_unavailable');
    }
  }

  app.post('/api/bookings', requireUser, async (req, res) => {
    const service = serviceFrom(String(req.body?.serviceId || ''));
    const date = String(req.body?.date || '');
    const time = String(req.body?.time || '');
    if (!DATE.test(date) || !TIME.test(time)) throw new HttpError(400, 'invalid_datetime');
    const slot = times(service, date).find((t) => t.time === time);
    if (!slot?.free) throw new HttpError(409, 'slot_taken');

    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : '';
    let payment;
    const method = req.body?.payment;
    if (method === 'voucher') {
      const code = String(req.body?.voucherCode || '').trim().toUpperCase();
      if (!usableVoucher(code)) throw new HttpError(400, 'invalid_voucher');
      payment = { method: 'voucher', voucherCode: code, depositEur: 0 };
    } else if (method === 'card' || method === 'paypal') {
      if (!payments.providers[method]) throw new HttpError(400, 'payment_unavailable');
      payment = { method, depositEur: salon.booking.depositEur };
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

    if (payment.method === 'voucher') {
      store.change((d) => {
        d.bookings.push(booking);
        d.vouchers.find((v) => v.code === payment.voucherCode).usedBy = booking.id;
      });
      confirmationMail(booking);
      return res.status(201).json({ booking });
    }

    // Deposit online: hold the time, then send the customer to the provider's page
    booking.status = 'pending';
    booking.holdUntil = clock().getTime() + HOLD_MS;
    store.change((d) => d.bookings.push(booking));
    const base = siteUrl(req);
    const checkout = await startCheckout(payments.providers[method], {
      reference: booking.id,
      amountEur: payment.depositEur,
      description: `Anzahlung ${service.name.de}, ${date} ${time}`,
      returnPath: `${base}/api/payments/return?kind=booking&ref=${booking.id}`,
      cancelPath: `${base}/api/payments/cancel?kind=booking&ref=${booking.id}`,
      onFail: () => store.change(() => { booking.status = 'cancelled'; booking.cancelReason = 'payment_unavailable'; delete booking.holdUntil; }),
    });
    store.change(() => { booking.payment.ref = checkout.id; });
    res.status(201).json({ booking, redirectUrl: checkout.redirectUrl });
  });

  const germanDate = (iso) => iso.split('-').reverse().join('.');

  function confirmationMail(booking) {
    const user = store.data.users.find((u) => u.id === booking.userId);
    if (!user) return;
    const paid = booking.payment.method === 'voucher'
      ? `Bezahlt mit Gutschein ${booking.payment.voucherCode}.`
      : `Deine Anzahlung von ${booking.payment.depositEur} € ist eingegangen und wird vom Preis abgezogen.`;
    mail({
      to: user.email,
      subject: `Terminbestätigung: ${booking.serviceName} am ${germanDate(booking.date)}`,
      text: `Hallo ${user.name},\n\ndein Termin ist bestätigt:\n\n${booking.serviceName}\n${germanDate(booking.date)}, ${booking.time}–${booking.endTime} Uhr\n${paid}\n\nKostenlos stornieren kannst du bis ${salon.booking.freeCancelHours} Stunden vorher in deinem Konto.\nBuchungsnummer: ${booking.id}\n\nWir freuen uns auf dich!\nYehMee Beauty Lounge`,
    });
  }

  // Refunds are made by the salon in the SumUp or PayPal account; this tells them to
  function refundMail(booking, why) {
    mail({
      to: salon.email,
      subject: `Bitte Anzahlung erstatten: Buchung ${booking.id}`,
      text: `Bitte Anzahlung ${booking.payment.depositEur} € erstatten (${booking.payment.method}, Zahlung ${booking.payment.ref}).\nBuchung ${booking.id}: ${booking.serviceName} am ${germanDate(booking.date)} um ${booking.time} Uhr.\nGrund: ${why}`,
    });
  }

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
    if (booking.depositRefunded && booking.payment.ref) refundMail(booking, 'kostenlose Stornierung');
    res.json({ booking });
  });

  // ---- Coming back from the payment page -------------------------------------
  // The provider sends the customer to /api/payments/return (or /cancel). Only the
  // provider's own answer to verify() decides whether anything was paid.

  async function verifySafely(provider, ref) {
    if (!provider || !ref) return 'pending';
    try {
      return await provider.verify(ref);
    } catch (err) {
      console.error(err);
      return 'pending';
    }
  }

  const backToConfirm = (b, result) => `/buchen?service=${b.serviceId}&date=${b.date}&time=${b.time}&payment=${result}`;

  /**
   * Asks the provider about a booking's deposit and confirms or cancels the booking.
   * Used when the customer comes back from the payment page and when the provider
   * notifies us (payment-webhook function), whichever happens first.
   */
  async function settleBooking(booking, { cancelled = false } = {}) {
    if (booking.status !== 'pending') return;
    const result = await verifySafely(payments.providers[booking.payment.method], booking.payment.ref);
    // The other path may have settled it while we waited for the provider
    if (booking.status !== 'pending') return;
    if (result === 'paid') {
      // Paid after the reservation ran out and someone else took the time: refund
      const clash = bookingsOn(booking.date).some((b) => b !== booking && booking.start < b.end && b.start < booking.end);
      store.change(() => {
        booking.payment.paidAt = clock().toISOString();
        delete booking.holdUntil;
        if (clash) {
          booking.status = 'cancelled';
          booking.cancelReason = 'slot_taken_after_payment';
          booking.cancelledAt = clock().toISOString();
          booking.depositRefunded = true;
        } else {
          booking.status = 'confirmed';
        }
      });
      if (clash) refundMail(booking, 'Termin war nach Ablauf der Reservierung vergeben');
      else confirmationMail(booking);
    } else if (result === 'failed' || cancelled) {
      store.change(() => {
        booking.status = 'cancelled';
        booking.cancelReason = cancelled ? 'payment_cancelled' : 'payment_failed';
        delete booking.holdUntil;
      });
    }
  }

  async function bookingReturn(req, res, cancelled) {
    if (!req.user) return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    const booking = store.data.bookings.find((b) => b.id === req.query.ref && b.userId === req.user.id);
    if (!booking) throw new HttpError(404, 'booking_not_found');
    await settleBooking(booking, { cancelled });

    if (booking.status === 'confirmed' || booking.status === 'pending') return res.redirect(303, `/buchen?booked=${booking.id}`);
    const result = { slot_taken_after_payment: 'late', payment_cancelled: 'cancelled' }[booking.cancelReason] ?? 'failed';
    return res.redirect(303, booking.cancelReason ? backToConfirm(booking, result) : `/buchen?booked=${booking.id}`);
  }

  /** Like settleBooking, for a gift voucher bought online. */
  async function settleVoucher(voucher, { cancelled = false } = {}) {
    if (voucher.status !== 'pending') return;
    const result = await verifySafely(payments.providers.card, voucher.paymentRef);
    if (voucher.status !== 'pending') return;
    if (result === 'paid') {
      store.change(() => { voucher.status = 'active'; voucher.paidAt = clock().toISOString(); });
      mail({
        to: voucher.buyerEmail,
        subject: `Dein YehMee-Gutschein über ${voucher.amountEur} €`,
        text: `Hallo ${voucher.buyerName},\n\nvielen Dank für deinen Gutschein über ${voucher.amountEur} €${voucher.recipient ? ` für ${voucher.recipient}` : ''}.\n\nGutscheincode: ${voucher.code}\n\nBei der Online-Buchung eingeben, dann entfällt die Anzahlung.\n\nYehMee Beauty Lounge`,
      });
    } else if (result === 'failed' || cancelled) {
      store.change(() => { voucher.status = 'cancelled'; });
    }
  }

  async function voucherReturn(req, res, cancelled) {
    const voucher = store.data.vouchers.find((v) => v.purchaseRef && v.purchaseRef === req.query.ref);
    if (!voucher) throw new HttpError(404, 'not_found');
    await settleVoucher(voucher, { cancelled });
    if (voucher.status === 'cancelled') return res.redirect(303, `/gutschein?payment=${cancelled ? 'cancelled' : 'failed'}`);
    return res.redirect(303, `/gutschein?bought=${voucher.purchaseRef}`);
  }

  // A provider said something happened to this payment (via the payment-webhook
  // function and src/payment-events.js). Unknown references are ignored.
  app.locals.settlePayment = async (ref) => {
    const booking = store.data.bookings.find((b) => b.payment?.ref === ref);
    if (booking) return settleBooking(booking);
    const voucher = store.data.vouchers.find((v) => v.paymentRef === ref);
    if (voucher) return settleVoucher(voucher);
  };

  for (const [path, cancelled] of [['/api/payments/return', false], ['/api/payments/cancel', true]]) {
    app.get(path, (req, res) => {
      if (req.query.kind === 'booking') return bookingReturn(req, res, cancelled);
      if (req.query.kind === 'voucher') return voucherReturn(req, res, cancelled);
      throw new HttpError(404, 'not_found');
    });
  }

  // Which ways to pay the deposit are on offer, and whether they are test stand-ins
  app.get('/api/payments/methods', (req, res) => {
    const providers = payments.providers;
    res.json({ methods: ['card', 'paypal'].filter((m) => providers[m]), testMode: Object.values(providers).some((p) => p.test) });
  });

  // ---- Test checkout (development only, see src/payments.js) ----------------

  const testCheckout = (id) => {
    const provider = Object.values(payments.providers).find((p) => p.test && p.checkouts.has(id));
    return provider && { provider, checkout: provider.checkouts.get(id) };
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  app.get('/api/payments/test/:id', (req, res) => {
    const found = testCheckout(req.params.id);
    if (!found) throw new HttpError(404, 'not_found');
    const { provider, checkout } = found;
    const action = (result) => `/api/payments/test/${escapeHtml(req.params.id)}/${result}`;
    res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Testzahlung</title><link rel="stylesheet" href="/css/app.css"></head><body><main class="step"><div class="card">
<p class="alert alert--warn">Testmodus: Es wird kein Geld bewegt. · Test mode: no money moves.</p>
<h1 class="step__title">${provider.name === 'paypal' ? 'PayPal' : 'SumUp · Visa / Mastercard'}</h1>
<p>${escapeHtml(checkout.description)}</p><p><strong>${escapeHtml(Number(checkout.amountEur).toFixed(2))} €</strong></p>
<form method="post" action="${action('pay')}"><button class="btn btn--blue" type="submit">Bezahlen · Pay</button></form>
<form method="post" action="${action('fail')}"><button class="btn btn--light" type="submit">Zahlung ablehnen · Decline</button></form>
<form method="post" action="${action('cancel')}"><button class="btn btn--light" type="submit">Abbrechen · Cancel</button></form>
</div></main></body></html>`);
  });

  app.post('/api/payments/test/:id/:result', (req, res) => {
    const found = testCheckout(req.params.id);
    if (!found || !['pay', 'fail', 'cancel'].includes(req.params.result)) throw new HttpError(404, 'not_found');
    const { checkout } = found;
    if (req.params.result === 'pay') checkout.status = 'paid';
    if (req.params.result === 'fail') checkout.status = 'failed';
    res.redirect(303, req.params.result === 'cancel' ? (checkout.cancelUrl || checkout.returnUrl) : checkout.returnUrl);
  });

  // ---- Gift vouchers ------------------------------------------------------------
  // Bought online through SumUp (active once paid), or sold in the salon with the
  // SumUp card reader and entered by the admin. A voucher replaces the deposit once.

  const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
  function newVoucherCode() {
    for (;;) {
      const s = [...randomBytes(8)].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
      const code = `YM-${s.slice(0, 4)}-${s.slice(4)}`;
      if (!store.data.vouchers.some((v) => v.code === code)) return code;
    }
  }
  const optionalText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

  app.post('/api/vouchers/purchase', async (req, res) => {
    const amountEur = Number(req.body?.amountEur);
    if (!salon.vouchers.amountsEur.includes(amountEur)) throw new HttpError(400, 'invalid_amount');
    const buyerName = text(req.body?.buyerName, 'name', { min: 2, max: 80 });
    const buyerEmail = text(req.body?.buyerEmail, 'email', { max: 200 }).toLowerCase();
    if (!EMAIL.test(buyerEmail)) throw new HttpError(400, 'invalid_email');
    const provider = payments.providers.card;
    if (!provider) throw new HttpError(400, 'payment_unavailable');

    const voucher = {
      code: newVoucherCode(), amountEur, source: 'online', status: 'pending', buyerName, buyerEmail,
      recipient: optionalText(req.body?.recipient, 80), message: optionalText(req.body?.message, 300),
      purchaseRef: randomBytes(16).toString('hex'), createdAt: clock().toISOString(),
    };
    store.change((d) => d.vouchers.push(voucher));
    const base = siteUrl(req);
    const checkout = await startCheckout(provider, {
      reference: voucher.purchaseRef,
      amountEur,
      description: `YehMee-Gutschein ${amountEur} €`,
      returnPath: `${base}/api/payments/return?kind=voucher&ref=${voucher.purchaseRef}`,
      cancelPath: `${base}/api/payments/cancel?kind=voucher&ref=${voucher.purchaseRef}`,
      onFail: () => store.change(() => { voucher.status = 'cancelled'; }),
    });
    store.change(() => { voucher.paymentRef = checkout.id; });
    res.status(201).json({ redirectUrl: checkout.redirectUrl });
  });

  // The thank-you page: the code only once the payment is confirmed
  app.get('/api/vouchers/purchase/:ref', (req, res) => {
    const v = store.data.vouchers.find((x) => x.purchaseRef && x.purchaseRef === req.params.ref);
    if (!v) throw new HttpError(404, 'not_found');
    res.json({ status: v.status, amountEur: v.amountEur, recipient: v.recipient ?? null, buyerEmail: v.buyerEmail, code: v.status === 'active' ? v.code : null });
  });

  app.get('/api/admin/vouchers', requireAdmin, (req, res) => {
    const vouchers = store.data.vouchers.filter((v) => v.status !== 'cancelled').reverse().map((v) => ({
      code: v.code, amountEur: v.amountEur ?? null, source: v.source ?? 'salon', note: v.note ?? null,
      buyerName: v.buyerName ?? null, recipient: v.recipient ?? null, createdAt: v.createdAt ?? null,
      state: v.usedBy ? 'used' : v.status ?? 'active',
    }));
    res.json({ vouchers });
  });

  app.post('/api/admin/vouchers', requireAdmin, (req, res) => {
    const amountEur = Math.round(Number(req.body?.amountEur) * 100) / 100;
    if (!(amountEur > 0 && amountEur <= 1000)) throw new HttpError(400, 'invalid_amount');
    let code = String(req.body?.code || '').trim().toUpperCase();
    if (code) {
      if (!/^[A-Z0-9-]{4,32}$/.test(code)) throw new HttpError(400, 'invalid_code');
      if (store.data.vouchers.some((v) => v.code === code)) throw new HttpError(409, 'voucher_exists');
    } else {
      code = newVoucherCode();
    }
    const voucher = { code, amountEur, source: 'salon', status: 'active', note: optionalText(req.body?.note, 200), createdAt: clock().toISOString() };
    store.change((d) => d.vouchers.push(voucher));
    res.status(201).json({ voucher: { code, amountEur, source: 'salon', state: 'active', note: voucher.note ?? null } });
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
