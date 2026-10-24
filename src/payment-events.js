// Payment notifications from SumUp and PayPal arrive at the payment-webhook Cloud Run
// function (functions/payment-webhook), which puts the payment's reference onto Pub/Sub.
// This listens on the app's subscription and asks the app to check that payment again,
// so a booking is confirmed even when the customer never comes back from the payment page.
// The message only says "look at this payment"; the provider's own answer decides.

import { PubSub } from '@google-cloud/pubsub';

/**
 * @param {object} opts
 * @param {string} opts.subscription  Pub/Sub subscription name
 * @param {(ref: string) => Promise<void>} opts.onPayment
 * @returns {() => Promise<void>} stops listening
 */
export function listenForPaymentEvents({ subscription, onPayment, pubsub = new PubSub() }) {
  const sub = pubsub.subscription(subscription);
  sub.on('message', async (message) => {
    try {
      const ref = paymentRefFrom(message.data);
      if (ref) await onPayment(ref);
      message.ack();
    } catch (err) {
      console.error('Payment event failed, will be retried:', err.message);
      message.nack();
    }
  });
  sub.on('error', (err) => console.error('Payment events:', err.message));
  return () => sub.close();
}

/** The payment reference in a message, or null for anything malformed. */
export function paymentRefFrom(data) {
  try {
    const { ref } = JSON.parse(Buffer.from(data).toString('utf8'));
    return typeof ref === 'string' && /^[\w-]{1,128}$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}
