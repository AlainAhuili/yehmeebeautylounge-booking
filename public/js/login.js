// Login page: log in, register, forgot / reset password, and "Mein Konto" with bookings.
// ?next=/buchen?... returns to the booking after logging in.

import { t } from './i18n.js';
import { api, el, formatDateLong, formatDuration, formatPrice, formatTime, serviceName, servicesById } from './lib.js';
import { userPromise } from './layout.js';

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));
const notice = document.getElementById('notice');

/** Only same-site paths, so the link cannot send people to another website. */
function safeNext(value) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : null;
}

function show(view, message, kind = 'warn') {
  for (const section of document.querySelectorAll('main > section')) section.hidden = section.id !== `view-${view}`;
  notice.hidden = !message;
  notice.className = `alert alert--${kind}`;
  notice.textContent = message || '';
}

/** Handles a form: disables the button while sending, shows the translated error. */
function onSubmit(id, handler) {
  const form = document.getElementById(id);
  const error = form.querySelector('.form-error');
  const button = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)), form);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

const afterLogin = () => { location.href = next || '/login'; };

onSubmit('form-login', async (data, form) => {
  await api('POST', '/api/auth/login', { email: data.email, password: data.password, remember: form.remember.checked });
  afterLogin();
});

onSubmit('form-register', async (data) => {
  await api('POST', '/api/auth/register', data);
  afterLogin();
});

onSubmit('form-forgot', async (data) => {
  await api('POST', '/api/auth/forgot', data);
  show('login', t('forgot.sent'), 'info');
});

onSubmit('form-reset', async (data) => {
  await api('POST', '/api/auth/reset', { token: params.get('reset'), password: data.password });
  history.replaceState(null, '', '/login');
  show('login', t('reset.done'), 'ok');
});

// ---- My account ---------------------------------------------------------

let services = new Map();

function statusText(b) {
  if (b.status === 'cancelled') return b.depositRefunded ? `${t('booking.cancelled')}, ${t('booking.refund')}` : t('booking.cancelled');
  return b.payment.method === 'voucher' ? t('booking.voucher') : t('booking.depositPaid', { amount: formatPrice(b.payment.depositEur) });
}

function appointment(booking, canCancel) {
  const service = services.get(booking.serviceId);
  const item = el('li', { className: `appointment${booking.status === 'cancelled' ? ' is-cancelled' : ''}` });
  item.append(el('div', {}, [
    el('strong', { textContent: service ? serviceName(service) : booking.serviceName }),
    el('div', {
      textContent: `${formatDateLong(booking.date)}, ${t('time.range', { start: formatTime(booking.time), end: formatTime(booking.endTime) })} (${formatDuration(booking.durationMin)})`,
    }),
    el('small', { textContent: statusText(booking) }),
  ]));
  if (canCancel) {
    const cancel = el('button', { className: 'btn btn--small', type: 'button', textContent: t('account.cancel') });
    cancel.addEventListener('click', async () => {
      if (!confirm(t('account.confirmCancel'))) return;
      try {
        const { booking: b } = await api('POST', `/api/bookings/${booking.id}/cancel`);
        show('account', t(b.depositRefunded ? 'account.cancelledRefund' : 'account.cancelled'), 'ok');
        await renderAccount();
      } catch (err) {
        alert(err.message);
      }
    });
    item.append(cancel);
  }
  return item;
}

async function renderAccount(user) {
  if (user) document.getElementById('account-name').textContent = `${user.name} · ${user.email}`;
  const [{ bookings }, catalog] = await Promise.all([api('GET', '/api/bookings/mine'), api('GET', '/api/services')]);
  services = servicesById(catalog);
  const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
  const upcoming = bookings.filter((b) => b.status === 'confirmed' && b.date >= today);
  const past = bookings.filter((b) => !upcoming.includes(b)).reverse();
  document.getElementById('upcoming').replaceChildren(...(upcoming.length ? upcoming.map((b) => appointment(b, true)) : [el('li', { textContent: t('account.noneUpcoming') })]));
  document.getElementById('past').replaceChildren(...(past.length ? past.map((b) => appointment(b, false)) : [el('li', { textContent: '–' })]));
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  location.href = '/login';
});

// ---- Which view ---------------------------------------------------------

const user = await userPromise;
if (params.get('reset')) {
  show('reset');
} else if (user && next) {
  location.href = next;
} else if (user) {
  show('account');
  await renderAccount(user);
} else {
  const view = ['register', 'forgot'].includes(params.get('view')) ? params.get('view') : 'login';
  show(view, next ? t('login.needed') : '');
  // Keep ?next= when switching between login and register
  if (next) {
    for (const a of document.querySelectorAll('.login__links a')) {
      const url = new URL(a.href);
      url.searchParams.set('next', next);
      a.href = url.pathname + url.search;
    }
  }
}
