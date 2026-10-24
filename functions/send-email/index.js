// send-email: delivers the booking app's emails (booking confirmations, gift voucher
// codes, password resets, refund notes to the salon).
// Trigger: Pub/Sub topic yehmee-mail, one message per email: { to, subject, text }.
// SMTP_URL (Secret Manager), e.g. smtps://user:app-password@smtp.gmail.com:465
// MAIL_FROM, e.g. "YehMee Beauty Lounge <yehmeeeyes@gmail.com>"
// A failed delivery throws, so Pub/Sub retries it (deployed with --retry).

import functions from '@google-cloud/functions-framework';
import nodemailer from 'nodemailer';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The email in a Pub/Sub CloudEvent, or null when the message is not a valid email. */
export function mailFrom(cloudEvent) {
  try {
    const raw = Buffer.from(cloudEvent.data.message.data, 'base64').toString('utf8');
    const { to, subject, text } = JSON.parse(raw);
    if (typeof to !== 'string' || !EMAIL.test(to)) return null;
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 200 || /[\r\n]/.test(subject)) return null;
    if (typeof text !== 'string' || text.length > 20_000) return null;
    return { to, subject, text };
  } catch {
    return null;
  }
}

let transport;

/** @param {object} deps for tests: a nodemailer-like transport and the environment */
export function makeSendEmail({ getTransport = () => (transport ??= nodemailer.createTransport(process.env.SMTP_URL)), env = process.env } = {}) {
  return async (cloudEvent) => {
    const mail = mailFrom(cloudEvent);
    if (!mail) {
      // Retrying cannot fix it: log and drop
      console.error(`Dropped invalid email message ${cloudEvent.id}`);
      return;
    }
    if (!env.SMTP_URL) {
      console.warn(`SMTP_URL not set; not sent: "${mail.subject}" to ${mail.to}`);
      return;
    }
    // The recipient as an address object, so nodemailer does not parse it as a header
    const info = await getTransport().sendMail({ from: env.MAIL_FROM, to: { name: '', address: mail.to }, subject: mail.subject, text: mail.text });
    console.log(`Sent "${mail.subject}" to ${mail.to} (${info.messageId})`);
  };
}

functions.cloudEvent('sendEmail', makeSendEmail());
