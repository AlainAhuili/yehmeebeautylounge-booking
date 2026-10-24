// Sending email. With MAIL_TOPIC set, each email goes onto that Pub/Sub topic and the
// send-email Cloud Run function delivers it (functions/send-email). Otherwise, as during
// development, it is printed to the log.

import { PubSub } from '@google-cloud/pubsub';

/** @typedef {{ to: string, subject: string, text: string }} Mail */

/** @returns {(mail: Mail) => void} */
export function mailerFromEnv(env = process.env) {
  if (!env.MAIL_TOPIC) return printMail;
  const topic = new PubSub().topic(env.MAIL_TOPIC);
  return (mail) => {
    // Never blocks or breaks the request; a lost email is logged with enough to resend it
    topic.publishMessage({ json: mail }).catch((err) => {
      console.error(`Email to ${mail.to} not queued (${mail.subject}):`, err.message);
    });
  };
}

/** @param {Mail} mail */
export function printMail(mail) {
  console.log(`[E-Mail an ${mail.to}] ${mail.subject}\n${mail.text}`);
}
