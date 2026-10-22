// "Gutschein": buy a YehMee gift voucher, paid on SumUp's payment page. After
// paying, the customer comes back here (?bought=…) and sees the code, which is
// also emailed. ?payment=failed|cancelled means nothing was paid.

import { t } from './i18n.js';
import { api, el, formatPrice } from './lib.js';
import './layout.js';

const main = document.getElementById('voucher');
const params = new URLSearchParams(location.search);
const RESULT_TEXT = { failed: 'pay.failed', cancelled: 'pay.cancelled' };

function field(id, label, input) {
  input.id = id;
  return el('div', { className: 'field' }, [el('label', { htmlFor: id, textContent: t(label) }), input]);
}

async function renderForm(paymentResult) {
  const [salon, { methods, testMode }] = await Promise.all([api('GET', '/api/salon'), api('GET', '/api/payments/methods')]);
  const amounts = salon.vouchers.amountsEur;
  const radios = amounts.map((amount, i) => el('input', { type: 'radio', name: 'amount', value: String(amount), checked: i === 1 }));
  const buyerName = el('input', { className: 'plain', name: 'buyerName', autocomplete: 'name', required: true, maxLength: 80 });
  const buyerEmail = el('input', { className: 'plain', type: 'email', name: 'buyerEmail', autocomplete: 'email', required: true, maxLength: 200 });
  const recipient = el('input', { className: 'plain', name: 'recipient', maxLength: 80 });
  const message = el('textarea', { name: 'message', maxLength: 300 });
  const error = el('p', { className: 'form-error', role: 'alert' });
  const submit = el('button', { className: 'btn btn--blue', type: 'submit', textContent: t('voucher.pay'), disabled: !methods.includes('card') });

  const form = el('form', { className: 'card', noValidate: true }, [
    el('fieldset', { className: 'fieldset' }, [
      el('legend', { textContent: t('voucher.amount') }),
      el('div', { className: 'amounts' }, radios.map((radio) => el('label', { className: 'choice' }, [radio, formatPrice(Number(radio.value))]))),
    ]),
    field('buyer-name', 'voucher.buyerName', buyerName),
    field('buyer-email', 'voucher.buyerEmail', buyerEmail),
    field('recipient', 'voucher.recipient', recipient),
    field('message', 'voucher.message', message),
    el('p', { className: 'pay-note' }, [
      t('voucher.payHint'),
      ...(testMode ? [el('span', { className: 'test-badge', textContent: t('pay.testBadge') })] : []),
    ]),
    submit,
    error,
  ]);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    if (!buyerName.value.trim() || !buyerEmail.value.trim()) { error.textContent = t('voucher.needContact'); return; }
    submit.disabled = true;
    try {
      const { redirectUrl } = await api('POST', '/api/vouchers/purchase', {
        amountEur: Number(radios.find((r) => r.checked).value),
        buyerName: buyerName.value, buyerEmail: buyerEmail.value, recipient: recipient.value, message: message.value,
      });
      submit.textContent = t('pay.redirecting');
      location.href = redirectUrl;
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });

  const result = RESULT_TEXT[paymentResult];
  main.replaceChildren(
    el('p', { className: 'voucher-intro', textContent: t('voucher.sub') }),
    ...(result ? [el('p', { className: 'alert alert--error', role: 'alert', textContent: t(result) })] : []),
    ...(methods.includes('card') ? [] : [el('p', { className: 'alert alert--warn', textContent: t('error.payment_unavailable') })]),
    form,
  );
}

async function renderBought(ref) {
  const v = await api('GET', `/api/vouchers/purchase/${encodeURIComponent(ref)}`);
  if (v.status === 'cancelled') return renderForm('failed');
  if (v.status !== 'active') {
    main.replaceChildren(el('div', { className: 'card done' }, [
      el('div', { className: 'done__icon', textContent: '…' }),
      el('p', { textContent: t('voucher.pending') }),
      el('p', {}, [el('a', { href: `/api/payments/return?kind=voucher&ref=${encodeURIComponent(ref)}`, className: 'btn', textContent: t('done.checkAgain') })]),
    ]));
    return;
  }
  main.replaceChildren(el('div', { className: 'card done' }, [
    el('div', { className: 'done__icon', textContent: '✓' }),
    el('h2', { className: 'step__title', textContent: t('voucher.done') }),
    el('p', { textContent: t('voucher.value', { amount: formatPrice(v.amountEur) }) }),
    el('p', {}, [t('voucher.code')]),
    el('div', { className: 'voucher-code', textContent: v.code }),
    el('p', { textContent: t('voucher.mailed', { email: v.buyerEmail }) }),
    el('p', {}, [
      el('a', { href: '/buchen', className: 'btn', textContent: t('nav.book') }), ' ',
      el('a', { href: '/gutschein', className: 'btn btn--light', textContent: t('voucher.another') }),
    ]),
  ]));
}

try {
  if (params.get('bought')) await renderBought(params.get('bought'));
  else await renderForm(params.get('payment'));
} catch (err) {
  main.replaceChildren(el('p', { className: 'alert alert--error', textContent: err.message }));
}
