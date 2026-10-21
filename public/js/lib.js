// Shared helpers: talking to the server, formatting in the visitor's language,
// building elements.

import { lang, locale, t, tc } from './i18n.js';

/**
 * Calls the API and returns the JSON body; throws an Error with a translated message.
 * A Blob body (an image) is sent as it is; anything else as JSON.
 */
export async function api(method, path, body) {
  const isBlob = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': isBlob ? body.type : 'application/json' },
    body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const key = data?.code ? `error.${data.code}` : 'error.generic';
    const message = t(key);
    const err = new Error(message === key ? t('error.generic') : message);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** The logged-in user, or null. */
export async function currentUser() {
  try {
    return (await api('GET', '/api/auth/me')).user || null;
  } catch {
    return null;
  }
}

/** 150 → "2:30 h", 45 → "0:45 h" */
export function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m} h`;
}

export const formatPrice = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format;

// Dates are "YYYY-MM-DD" in the salon's time zone; formatting them as UTC noon
// keeps the day the same everywhere.
const dateOf = (iso) => new Date(`${iso}T12:00:00Z`);
const longDate = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortWeekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
const shortMonth = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
// 12-hour clock only in US English, 24-hour everywhere else
const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC', hourCycle: lang === 'en-US' ? 'h12' : 'h23' });

/** "2026-10-21" → "Mittwoch, 21. Oktober 2026" / "Wednesday, October 21, 2026" */
export const formatDateLong = (iso) => longDate.format(dateOf(iso));

/** "2026-10-21" → { weekday: "Mi", day: "21", month: "Okt" } */
export function dayParts(iso) {
  const d = dateOf(iso);
  return { weekday: shortWeekday.format(d).replace('.', ''), day: String(d.getUTCDate()), month: shortMonth.format(d).replace('.', '') };
}

/** "13:30" → "13:30" / "1:30 PM" */
export function formatTime(hhmm) {
  return clock.format(new Date(`1970-01-01T${hhmm}:00Z`));
}

/** Monday = 0 … Sunday = 6, as long weekday names in the visitor's language */
export function weekdayName(index) {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)));
}

export function addDays(iso, days) {
  const d = dateOf(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** All services from the catalog as a Map by id. */
export function servicesById(catalog) {
  return new Map(catalog.categories.flatMap((c) => c.services.map((s) => [s.id, s])));
}

export const serviceName = (service) => tc(service.name);
