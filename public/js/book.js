// "Jetzt buchen": service → day → time → (log in) → confirm with deposit → done.
// The step is read from the URL (?service=&date=&time=), so Back, reload and
// links all work. Every step asks the server, which has the final say.

import { t } from './i18n.js';
import {
  addDays, api, dayParts, el, formatDateLong, formatDuration, formatPrice, formatTime, serviceName, servicesById,
} from './lib.js';
import { renderServiceList } from './service-list.js';
import { userPromise } from './layout.js';

const main = document.getElementById('step');
const back = document.getElementById('back');
const [catalog, salon] = await Promise.all([api('GET', '/api/services'), api('GET', '/api/salon')]);
const services = servicesById(catalog);
const CALENDAR_DAYS = 28;
const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

function go(params, { replace = false } = {}) {
  const url = new URL('/buchen', location.origin);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  history[replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search);
  render();
}

function stepTitle(title, sub) {
  return [el('h1', { className: 'step__title', textContent: title }), ...(sub ? [el('p', { className: 'step__sub', textContent: sub })] : [])];
}

function endOf(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ---- Step 1: service ------------------------------------------------------

function renderService() {
  back.hidden = true;
  main.className = 'step';
  const list = el('div');
  main.replaceChildren(...stepTitle(t('services.title')), list);
  renderServiceList(list, catalog, { onNext: (s) => go({ service: s.id }) });
}

// ---- Step 2: day ------------------------------------------------------------

async function renderDay(service, from) {
  back.hidden = false;
  back.onclick = () => go({});
  main.className = 'step step--wide';
  const days = el('div', { className: 'calendar' });
  const nextFree = el('button', { className: 'link-button', type: 'button', textContent: `🔍 ${t('day.nextFree')}` });
  const more = el('button', { className: 'btn btn--light', type: 'button', textContent: t('day.more') });
  main.replaceChildren(
    ...stepTitle(t('day.title'), `${salon.name}, ${salon.address.city} · ${serviceName(service)} (${formatDuration(service.durationMin)})`),
    el('p', { className: 'center' }, [nextFree]),
    days,
    el('ul', { className: 'calendar-legend' }, ['free', 'some', 'few', 'full', 'closed'].map((s) =>
      el('li', {}, [el('i', { style: `background: var(--day-${s})` }), t(`status.${s}`)]))),
    el('p', { className: 'center' }, [more]),
  );

  let start = from;
  async function load() {
    const { days: list } = await api('GET', `/api/availability/days?service=${service.id}&from=${start}&days=${CALENDAR_DAYS}`);
    days.append(...list.map((d) => {
      const { weekday, day, month } = dayParts(d.date);
      const bookable = ['free', 'some', 'few'].includes(d.status);
      const button = el('button', { className: 'day', type: 'button', disabled: !bookable }, [
        el('span', { textContent: weekday }), el('span', { textContent: day }), el('span', { textContent: month }),
      ]);
      button.dataset.status = d.status;
      button.setAttribute('aria-label', `${formatDateLong(d.date)}: ${t(`status.${d.status}`)}`);
      if (bookable) button.addEventListener('click', () => go({ service: service.id, date: d.date }));
      return button;
    }));
    start = addDays(start, CALENDAR_DAYS);
    more.hidden = start > addDays(from, salon.booking.horizonDays);
  }

  more.addEventListener('click', load);
  nextFree.addEventListener('click', async () => {
    let first = days.querySelector('.day:not(:disabled)');
    while (!first && !more.hidden) {
      await load();
      first = days.querySelector('.day:not(:disabled)');
    }
    if (first) first.click();
    else nextFree.textContent = t('day.noneFree');
  });
  await load();
}

// ---- Step 3: time -----------------------------------------------------------

async function renderTime(service, date) {
  back.hidden = false;
  back.onclick = () => go({ service: service.id });
  main.className = 'step';
  const { times } = await api('GET', `/api/availability/times?service=${service.id}&date=${date}`);
  const jump = (n, label) => {
    const target = addDays(date, n);
    const b = el('button', { className: 'btn btn--small', type: 'button', textContent: `${n > 0 ? '+' : ''}${n}`, disabled: target < today() });
    b.setAttribute('aria-label', t(label));
    b.addEventListener('click', () => go({ service: service.id, date: target }));
    return b;
  };

  const grid = times.length
    ? times.map((slot) => {
      const b = el('button', { className: 'time', type: 'button', textContent: formatTime(slot.time), disabled: !slot.free });
      if (slot.free) b.addEventListener('click', () => go({ service: service.id, date, time: slot.time }));
      return b;
    })
    : [el('p', { textContent: t('time.closed'), style: 'grid-column: 1 / -1; text-align: center' })];

  main.replaceChildren(
    ...stepTitle(t('time.title'), `${serviceName(service)} · ${formatDuration(service.durationMin)}`),
    el('div', { className: 'day-nav' }, [el('div', {}, [jump(-1, 'time.prevDay')]), el('div', {}, [jump(1, 'time.nextDay'), jump(7, 'time.nextWeek')])]),
    el('h2', { className: 'date-heading', textContent: formatDateLong(date) }),
    el('div', { className: 'staff-card' }, [el('h3', { textContent: salon.staff }), el('div', { className: 'time-grid' }, grid)]),
  );
}

// ---- Step 4: confirm and pay the deposit ------------------------------------
// Card (SumUp) and PayPal open the provider's payment page; the server confirms
// the booking only after the provider has the money. A voucher books at once.

const PAYMENT_TEXT = {
  card: ['pay.card', 'pay.cardHint'],
  paypal: ['pay.paypal', 'pay.paypalHint'],
  voucher: ['pay.voucher', 'pay.voucherHint'],
};
const RESULT_TEXT = { failed: 'pay.failed', cancelled: 'pay.cancelled', late: 'pay.late' };

async function renderConfirm(service, date, time, user, paymentResult) {
  back.hidden = false;
  back.onclick = () => go({ service: service.id, date });
  main.className = 'step';
  const deposit = salon.booking.depositEur;
  const range = t('time.range', { start: formatTime(time), end: formatTime(endOf(time, service.durationMin)) });
  const { methods, testMode } = await api('GET', '/api/payments/methods');

  const row = (label, value) => el('tr', {}, [el('th', { textContent: t(label) }), el('td', { textContent: value })]);
  const voucherInput = el('input', { className: 'plain', name: 'voucher', placeholder: t('pay.voucherCode'), autocomplete: 'off' });
  const voucherField = el('div', { className: 'field', hidden: methods.length > 0 }, [voucherInput]);
  const radios = [...methods, 'voucher'].map((value, i) => el('input', { type: 'radio', name: 'payment', value, checked: i === 0 }));
  const chosen = () => radios.find((r) => r.checked).value;
  const note = el('textarea', { id: 'note', name: 'note', maxLength: 500, placeholder: t('confirm.notePlaceholder') });
  const terms = el('input', { type: 'checkbox', required: true });
  const error = el('p', { className: 'form-error', role: 'alert' });
  const submit = el('button', { className: 'btn btn--blue', type: 'submit' });
  const update = () => {
    voucherField.hidden = chosen() !== 'voucher';
    submit.textContent = t(chosen() === 'voucher' ? 'confirm.submit' : 'confirm.toPayment');
  };
  for (const radio of radios) radio.addEventListener('change', update);
  update();

  const choice = (radio) => {
    const [label, hint] = PAYMENT_TEXT[radio.value];
    const online = radio.value !== 'voucher';
    return el('label', { className: 'choice' }, [radio, el('span', {}, [
      t(label),
      ...(online && testMode ? [el('span', { className: 'test-badge', textContent: t('pay.testBadge') })] : []),
      el('small', { textContent: t(hint) }),
    ])]);
  };

  const form = el('form', { className: 'card', noValidate: true }, [
    el('table', { className: 'summary' }, [
      row('confirm.service', serviceName(service)),
      row('confirm.date', formatDateLong(date)),
      row('confirm.time', `${range} (${formatDuration(service.durationMin)})`),
      row('confirm.with', salon.staff),
      row('confirm.price', formatPrice(service.priceEur)),
      row('confirm.depositNow', formatPrice(deposit)),
      row('confirm.rest', formatPrice(Math.max(service.priceEur - deposit, 0))),
      row('confirm.bookedFor', `${user.name} · ${user.email} · ${user.phone}`),
    ]),
    el('fieldset', { className: 'fieldset' }, [
      el('legend', { textContent: t('confirm.deposit', { amount: formatPrice(deposit) }) }),
      ...radios.map(choice),
      voucherField,
      ...(testMode ? [el('p', { className: 'pay-note', textContent: t('pay.testNote') })] : []),
    ]),
    el('div', { className: 'field' }, [el('label', { htmlFor: 'note', textContent: t('confirm.note') }), note]),
    el('label', { className: 'check', id: 'bedingungen' }, [terms, el('span', { textContent: t('confirm.terms') })]),
    submit,
    error,
  ]);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!terms.checked) { error.textContent = t('confirm.needTerms'); return; }
    if (chosen() === 'voucher' && !voucherInput.value.trim()) { error.textContent = t('confirm.needVoucher'); return; }
    submit.disabled = true;
    try {
      const { booking, redirectUrl } = await api('POST', '/api/bookings', {
        serviceId: service.id, date, time, note: note.value,
        payment: chosen(),
        voucherCode: voucherInput.value,
      });
      if (redirectUrl) {
        submit.textContent = t('pay.redirecting');
        location.href = redirectUrl;
        return;
      }
      history.replaceState(null, '', `/buchen?booked=${booking.id}`);
      renderDone(booking, user);
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });

  const result = RESULT_TEXT[paymentResult];
  main.replaceChildren(
    ...stepTitle(t('confirm.title')),
    ...(result ? [el('p', { className: 'alert alert--error', role: 'alert', textContent: t(result) })] : []),
    form,
  );
}

// ---- Step 5: done -----------------------------------------------------------

function renderDone(booking, user) {
  back.hidden = true;
  main.className = 'step';
  if (booking.status === 'pending') {
    // Back from the payment page before the provider confirmed: ask again on demand
    main.replaceChildren(el('div', { className: 'card done' }, [
      el('div', { className: 'done__icon', textContent: '…' }),
      el('h1', { className: 'step__title', textContent: t('done.pendingTitle') }),
      el('p', { textContent: t('done.pending') }),
      el('p', {}, [el('a', { href: `/api/payments/return?kind=booking&ref=${encodeURIComponent(booking.id)}`, className: 'btn', textContent: t('done.checkAgain') })]),
    ]));
    return;
  }
  const service = services.get(booking.serviceId);
  main.replaceChildren(el('div', { className: 'card done' }, [
    el('div', { className: 'done__icon', textContent: '✓' }),
    el('h1', { className: 'step__title', textContent: t('done.title') }),
    el('p', { textContent: t('done.when', { service: service ? serviceName(service) : booking.serviceName, date: formatDateLong(booking.date), time: formatTime(booking.time) }) }),
    el('p', { textContent: `${t('done.mail', { email: user.email })} ${t('done.tip')}` }),
    el('p', {}, [el('a', { href: '/login', className: 'btn', textContent: t('done.account') })]),
  ]));
  window.scrollTo(0, 0);
}

// ---- Which step -------------------------------------------------------------

async function render() {
  const params = new URLSearchParams(location.search);
  const service = services.get(params.get('service'));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : null;
  const time = /^\d{2}:\d{2}$/.test(params.get('time') || '') ? params.get('time') : null;
  try {
    if (params.get('booked')) {
      const user = await userPromise;
      const { bookings } = await api('GET', '/api/bookings/mine');
      const booking = bookings.find((b) => b.id === params.get('booked'));
      return booking ? renderDone(booking, user) : go({}, { replace: true });
    }
    if (!service) return renderService();
    if (!date) return await renderDay(service, today());
    if (!time) return await renderTime(service, date);
    const user = await userPromise;
    if (!user) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    return await renderConfirm(service, date, time, user, params.get('payment'));
  } catch (err) {
    main.replaceChildren(el('p', { className: 'alert alert--error', textContent: err.message }));
  }
}

back.textContent = t('common.back');
window.addEventListener('popstate', render);
render();
