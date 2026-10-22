// The SumUp and PayPal adapters send the right requests and read the answers
// correctly. A fake fetch records each call; nothing goes over the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentsFromEnv, paypalProvider, sumupProvider } from '../src/payments.js';

function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const [status, body] = answers.shift();
    return { ok: status < 300, status, json: async () => body };
  };
  return { fetch, calls };
}

const order = {
  reference: 'b_123', amountEur: 15, description: 'Anzahlung Gel', returnUrl: 'https://site/return', cancelUrl: 'https://site/cancel',
};

test('SumUp: creates a hosted checkout and reads its status', async () => {
  const { fetch, calls } = fakeFetch([
    [200, { id: 'chk_1', status: 'PENDING', hosted_checkout_url: 'https://checkout.sumup.com/pay/chk_1' }],
    [200, { id: 'chk_1', status: 'PENDING' }],
    [200, { id: 'chk_1', status: 'PAID' }],
    [200, { id: 'chk_1', status: 'FAILED' }],
  ]);
  const sumup = sumupProvider({ apiKey: 'sup_sk_test', merchantCode: 'MC123', fetch });

  assert.deepEqual(await sumup.create(order), { id: 'chk_1', redirectUrl: 'https://checkout.sumup.com/pay/chk_1' });
  assert.equal(calls[0].url, 'https://api.sumup.com/v0.1/checkouts');
  assert.equal(calls[0].headers.Authorization, 'Bearer sup_sk_test');
  assert.deepEqual(JSON.parse(calls[0].body), {
    checkout_reference: 'b_123', amount: 15, currency: 'EUR', merchant_code: 'MC123',
    description: 'Anzahlung Gel', redirect_url: 'https://site/return', hosted_checkout: { enabled: true },
  });

  assert.equal(await sumup.verify('chk_1'), 'pending');
  assert.equal(calls[1].url, 'https://api.sumup.com/v0.1/checkouts/chk_1');
  assert.equal(await sumup.verify('chk_1'), 'paid');
  assert.equal(await sumup.verify('chk_1'), 'failed');
});

test('SumUp: an error answer becomes an exception, never "paid"', async () => {
  const { fetch } = fakeFetch([[401, { message: 'invalid token' }]]);
  await assert.rejects(sumupProvider({ apiKey: 'x', merchantCode: 'y', fetch }).create(order), /SumUp checkout failed \(401\)/);
});

test('PayPal: logs in once, creates an order with return links, captures when approved', async () => {
  const { fetch, calls } = fakeFetch([
    [200, { access_token: 'tok', expires_in: 3600 }],
    [201, { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD1' }] }],
    [200, { id: 'ORD1', status: 'APPROVED' }],
    [201, { id: 'ORD1', status: 'COMPLETED' }],
    [200, { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED' }],
  ]);
  const paypal = paypalProvider({ clientId: 'cid', clientSecret: 'sec', fetch });

  assert.deepEqual(await paypal.create(order), { id: 'ORD1', redirectUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD1' });
  assert.equal(calls[0].url, 'https://api-m.sandbox.paypal.com/v1/oauth2/token');
  assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  const body = JSON.parse(calls[1].body);
  assert.equal(body.intent, 'CAPTURE');
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'EUR', value: '15.00' });
  assert.equal(body.payment_source.paypal.experience_context.return_url, 'https://site/return');
  assert.equal(body.payment_source.paypal.experience_context.cancel_url, 'https://site/cancel');
  assert.equal(calls[1].headers.Authorization, 'Bearer tok');

  assert.equal(await paypal.verify('ORD1'), 'paid');
  assert.equal(calls[3].url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORD1/capture');
  assert.equal(calls[3].method, 'POST');
  assert.equal(await paypal.verify('ORD1'), 'pending');
  assert.equal(calls.filter((c) => c.url.endsWith('/oauth2/token')).length, 1, 'the login is reused');
});

test('PayPal live mode uses the live address', async () => {
  const { fetch, calls } = fakeFetch([[200, { access_token: 't', expires_in: 3600 }], [200, { id: 'O', status: 'COMPLETED' }]]);
  await paypalProvider({ clientId: 'a', clientSecret: 'b', live: true, fetch }).verify('O');
  assert.ok(calls.every((c) => c.url.startsWith('https://api-m.paypal.com/')));
});

test('without keys: test checkouts in development, nothing in production', () => {
  const dev = paymentsFromEnv({});
  assert.ok(dev.providers.card.test && dev.providers.paypal.test);
  assert.deepEqual(paymentsFromEnv({ NODE_ENV: 'production' }).providers, {});
  const real = paymentsFromEnv({ NODE_ENV: 'production', SUMUP_API_KEY: 'k', SUMUP_MERCHANT_CODE: 'm', PAYPAL_CLIENT_ID: 'i', PAYPAL_CLIENT_SECRET: 's' });
  assert.equal(real.providers.card.name, 'sumup');
  assert.equal(real.providers.paypal.name, 'paypal');
  assert.ok(!real.providers.card.test);
});
