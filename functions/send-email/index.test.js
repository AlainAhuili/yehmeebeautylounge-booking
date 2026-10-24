import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailFrom, makeSendEmail } from './index.js';

const event = (payload, id = 'evt-1') => ({
  id,
  data: { message: { data: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64') } },
});
const good = { to: 'kundin@example.com', subject: 'Terminbestätigung', text: 'Hallo!' };

test('reads an email from a Pub/Sub message', () => {
  assert.deepEqual(mailFrom(event(good)), good);
});

test('refuses messages that are not a single, plain email', () => {
  for (const bad of [
    { ...good, to: 'a@b.c, other@evil.example' },
    { ...good, to: 'no-at-sign' },
    { ...good, subject: 'Hi\r\nBcc: other@evil.example' },
    { ...good, subject: '' },
    { ...good, text: 42 },
    'not json',
  ]) {
    assert.equal(mailFrom(event(bad)), null, JSON.stringify(bad));
  }
});

test('sends with the configured sender; a failure throws so Pub/Sub retries', async () => {
  const sent = [];
  const send = makeSendEmail({
    env: { SMTP_URL: 'smtp://fake', MAIL_FROM: 'YehMee <salon@example.com>' },
    getTransport: () => ({ async sendMail(m) { sent.push(m); return { messageId: 'm1' }; } }),
  });
  await send(event(good));
  assert.deepEqual(sent, [{ from: 'YehMee <salon@example.com>', ...good, to: { name: '', address: good.to } }]);

  const failing = makeSendEmail({ env: { SMTP_URL: 'smtp://fake' }, getTransport: () => ({ async sendMail() { throw new Error('421 try later'); } }) });
  await assert.rejects(failing(event(good)), /421/);
});

test('without SMTP settings, or for a bad message, nothing is sent and nothing is retried', async () => {
  const sent = [];
  const transport = { async sendMail(m) { sent.push(m); return {}; } };
  await makeSendEmail({ env: {}, getTransport: () => transport })(event(good));
  await makeSendEmail({ env: { SMTP_URL: 'smtp://fake' }, getTransport: () => transport })(event('garbage'));
  assert.equal(sent.length, 0);
});
