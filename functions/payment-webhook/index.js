// payment-webhook: the HTTPS address SumUp and PayPal notify when a payment changes.
//   POST /sumup   SumUp checkout `return_url` (CHECKOUT_STATUS_CHANGED, { id })
//   POST /paypal  PayPal webhook (CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED)
//   POST /test    { ref } for the booking app's test checkout; only with ALLOW_TEST_EVENTS=true
// Each notification becomes a Pub/Sub message { provider, ref, receivedAt } on
// PAYMENT_EVENTS_TOPIC. The booking app then asks the provider itself whether the payment
// went through (src/payment-events.js), so a forged notification cannot confirm anything;
// PayPal's signature is still checked when PAYPAL_WEBHOOK_ID and the API keys are set.

import functions from '@google-cloud/functions-framework';
import { PubSub } from '@google-cloud/pubsub';

const REF = /^[\w-]{1,128}$/;
const PAYPAL_EVENTS = ['CHECKOUT.ORDER.APPROVED', 'CHECKOUT.ORDER.COMPLETED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED'];

/** The PayPal order id a webhook event is about, or null. */
export function paypalOrderId(event) {
  if (!PAYPAL_EVENTS.includes(event?.event_type)) return null;
  const id = event.event_type.startsWith('CHECKOUT.ORDER.')
    ? event.resource?.id
    : event.resource?.supplementary_data?.related_ids?.order_id;
  return typeof id === 'string' && REF.test(id) ? id : null;
}

/** Asks PayPal whether a webhook really came from PayPal. */
export async function paypalSignatureValid(req, env, fetch = globalThis.fetch) {
  const base = env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!tokenRes.ok) throw new Error(`PayPal login failed (${tokenRes.status})`);
  const { access_token: token } = await tokenRes.json();
  const h = (name) => req.get(name);
  const res = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: req.body,
    }),
  });
  if (!res.ok) throw new Error(`PayPal verification failed (${res.status})`);
  return (await res.json()).verification_status === 'SUCCESS';
}

/**
 * @param {object} deps
 * @param {(message: object) => Promise<unknown>} deps.publish
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {typeof paypalSignatureValid} [deps.verifyPaypal]
 */
export function makeWebhook({ publish, env = process.env, verifyPaypal = paypalSignatureValid }) {
  const paypalChecks = Boolean(env.PAYPAL_WEBHOOK_ID && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);

  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').send('Method Not Allowed');
    const body = req.body ?? {};
    let provider;
    let ref = null;

    if (req.path === '/sumup') {
      provider = 'sumup';
      if (body.event_type !== 'CHECKOUT_STATUS_CHANGED') return res.status(200).send('ignored');
      ref = typeof body.id === 'string' && REF.test(body.id) ? body.id : null;
    } else if (req.path === '/paypal') {
      provider = 'paypal';
      if (paypalChecks && !(await verifyPaypal(req, env))) return res.status(401).send('invalid signature');
      ref = paypalOrderId(body);
      if (!ref) return res.status(200).send('ignored'); // PayPal also sends events we do not need
    } else if (req.path === '/test' && env.ALLOW_TEST_EVENTS === 'true') {
      provider = 'test';
      ref = typeof body.ref === 'string' && REF.test(body.ref) ? body.ref : null;
    } else {
      return res.status(404).send('Not Found');
    }

    if (!ref) return res.status(400).send('missing payment reference');
    await publish({ provider, ref, receivedAt: new Date().toISOString() });
    console.log(`${provider} payment ${ref} passed on`);
    return res.status(200).send('ok');
  };
}

let topic;
const publish = (message) => (topic ??= new PubSub().topic(process.env.PAYMENT_EVENTS_TOPIC)).publishMessage({ json: message });

functions.http('paymentWebhook', makeWebhook({ publish }));
