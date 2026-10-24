import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWebhook, paypalOrderId } from './index.js';

/** Calls the handler like the Functions Framework does and returns { status, body }. */
async function call(handler, { method = 'POST', path, body, headers = {} }) {
  const req = { method, path, body, get: (name) => headers[name.toLowerCase()] };
  const res = {
    statusCode: 200,
    sent: undefined,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    send(value) { this.sent = value; return this; },
  };
  await handler(req, res);
  return { status: res.statusCode, body: res.sent };
}

function setup(env = {}, verifyPaypal) {
  const published = [];
  const handler = makeWebhook({ publish: async (m) => published.push(m), env, verifyPaypal });
  return { handler, published };
}

test('a SumUp status change passes the checkout id on', async () => {
  const { handler, published } = setup();
  const res = await call(handler, { path: '/sumup', body: { event_type: 'CHECKOUT_STATUS_CHANGED', id: '4e425463-3e1b-431d-83fa-1e51c2925e99' } });
  assert.equal(res.status, 200);
  assert.equal(published.length, 1);
  assert.equal(published[0].provider, 'sumup');
  assert.equal(published[0].ref, '4e425463-3e1b-431d-83fa-1e51c2925e99');
});

test('PayPal: the order id comes from approved orders and completed captures', () => {
  assert.equal(paypalOrderId({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: '5O190127TN364715T' } }), '5O190127TN364715T');
  assert.equal(
    paypalOrderId({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE1', supplementary_data: { related_ids: { order_id: 'ORDER1' } } } }),
    'ORDER1',
  );
  assert.equal(paypalOrderId({ event_type: 'BILLING.SUBSCRIPTION.CREATED', resource: { id: 'X' } }), null);
});

test('PayPal: with webhook keys set, an event without a valid signature is refused', async () => {
  const env = { PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' };
  const event = { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER2' } };

  const forged = setup(env, async () => false);
  assert.equal((await call(forged.handler, { path: '/paypal', body: event })).status, 401);
  assert.equal(forged.published.length, 0);

  const genuine = setup(env, async () => true);
  assert.equal((await call(genuine.handler, { path: '/paypal', body: event })).status, 200);
  assert.deepEqual(genuine.published.map((m) => m.ref), ['ORDER2']);
});

test('test events only where they are switched on', async () => {
  const off = setup();
  assert.equal((await call(off.handler, { path: '/test', body: { ref: 'test_sumup_1' } })).status, 404);
  const on = setup({ ALLOW_TEST_EVENTS: 'true' });
  assert.equal((await call(on.handler, { path: '/test', body: { ref: 'test_sumup_1' } })).status, 200);
  assert.equal(on.published[0].ref, 'test_sumup_1');
});

test('anything else is refused and nothing is published', async () => {
  const { handler, published } = setup({ ALLOW_TEST_EVENTS: 'true' });
  assert.equal((await call(handler, { method: 'GET', path: '/sumup' })).status, 405);
  assert.equal((await call(handler, { path: '/other', body: {} })).status, 404);
  assert.equal((await call(handler, { path: '/sumup', body: { event_type: 'CHECKOUT_STATUS_CHANGED', id: 'bad id;drop' } })).status, 400);
  assert.equal((await call(handler, { path: '/test', body: { ref: 'x'.repeat(200) } })).status, 400);
  assert.equal(published.length, 0);
});
