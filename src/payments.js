// Online payments, each on the provider's own payment page:
//   card   → SumUp Hosted Checkout (Visa, Mastercard), also used for gift vouchers
//   paypal → PayPal Checkout (Orders API v2)
// Without keys, and never in production, a test checkout on this server stands
// in for a provider, so the whole flow can be tried without moving money.
//
// Every provider has the same two calls:
//   create({ reference, amountEur, description, returnUrl, cancelUrl }) → { id, redirectUrl }
//   verify(id) → 'paid' | 'pending' | 'failed'
// verify() is what counts: a customer coming back to returnUrl proves nothing.

import { randomBytes } from 'node:crypto';

const euros = (amount) => Number(amount).toFixed(2);

async function call(fetch, url, init, what) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/** SumUp: https://developer.sumup.com/online-payments/checkouts/hosted-checkout/ */
export function sumupProvider({ apiKey, merchantCode, fetch = globalThis.fetch }) {
  const base = 'https://api.sumup.com/v0.1/checkouts';
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  return {
    name: 'sumup',
    async create({ reference, amountEur, description, returnUrl }) {
      const data = await call(fetch, base, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          checkout_reference: reference,
          amount: Number(euros(amountEur)),
          currency: 'EUR',
          merchant_code: merchantCode,
          description,
          redirect_url: returnUrl,
          hosted_checkout: { enabled: true },
        }),
      }, 'SumUp checkout');
      return { id: data.id, redirectUrl: data.hosted_checkout_url };
    },
    async verify(id) {
      const data = await call(fetch, `${base}/${encodeURIComponent(id)}`, { headers }, 'SumUp status');
      if (data.status === 'PAID') return 'paid';
      if (data.status === 'FAILED' || data.status === 'EXPIRED') return 'failed';
      return 'pending';
    },
  };
}

/** PayPal: https://developer.paypal.com/docs/api/orders/v2/ */
export function paypalProvider({ clientId, clientSecret, live = false, fetch = globalThis.fetch }) {
  const base = live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  let token = null; // { value, until }

  async function auth() {
    if (token && token.until > Date.now()) return token.value;
    const data = await call(fetch, `${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    }, 'PayPal login');
    token = { value: data.access_token, until: Date.now() + (data.expires_in - 60) * 1000 };
    return token.value;
  }

  const headers = async (extra = {}) => ({ Authorization: `Bearer ${await auth()}`, 'Content-Type': 'application/json', ...extra });

  return {
    name: 'paypal',
    async create({ reference, amountEur, description, returnUrl, cancelUrl }) {
      const data = await call(fetch, `${base}/v2/checkout/orders`, {
        method: 'POST',
        headers: await headers({ 'PayPal-Request-Id': reference }),
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{ reference_id: reference, description, amount: { currency_code: 'EUR', value: euros(amountEur) } }],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'YehMee Beauty Lounge',
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: returnUrl,
                cancel_url: cancelUrl,
              },
            },
          },
        }),
      }, 'PayPal order');
      const link = data.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
      return { id: data.id, redirectUrl: link?.href };
    },
    // An approved order is captured here; capturing twice is harmless (same request id)
    async verify(id) {
      const url = `${base}/v2/checkout/orders/${encodeURIComponent(id)}`;
      let order = await call(fetch, url, { headers: await headers() }, 'PayPal status');
      if (order.status === 'APPROVED') {
        order = await call(fetch, `${url}/capture`, { method: 'POST', headers: await headers({ 'PayPal-Request-Id': `${id}-capture` }) }, 'PayPal capture');
      }
      if (order.status === 'COMPLETED') return 'paid';
      if (order.status === 'VOIDED') return 'failed';
      return 'pending';
    },
  };
}

/** The stand-in for development: /api/payments/test/:id shows "pay" and "cancel". */
export function testProvider(name) {
  const checkouts = new Map(); // id → { status, amountEur, description, returnUrl, cancelUrl }
  return {
    name,
    test: true,
    checkouts,
    async create({ amountEur, description, returnUrl, cancelUrl }) {
      const id = `test_${name}_${randomBytes(6).toString('hex')}`;
      checkouts.set(id, { status: 'pending', amountEur, description, returnUrl, cancelUrl });
      return { id, redirectUrl: `/api/payments/test/${id}` };
    },
    async verify(id) {
      return checkouts.get(id)?.status ?? 'failed';
    },
  };
}

/**
 * The providers configured in the environment. In production a missing key means
 * that method is not offered; elsewhere the test checkout takes its place.
 */
export function paymentsFromEnv(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const providers = {};
  if (env.SUMUP_API_KEY && env.SUMUP_MERCHANT_CODE) {
    providers.card = sumupProvider({ apiKey: env.SUMUP_API_KEY, merchantCode: env.SUMUP_MERCHANT_CODE });
  } else if (!production) {
    providers.card = testProvider('sumup');
  }
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    providers.paypal = paypalProvider({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, live: env.PAYPAL_ENV === 'live' });
  } else if (!production) {
    providers.paypal = testProvider('paypal');
  }
  return { providers };
}
