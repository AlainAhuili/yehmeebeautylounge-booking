// The Google Cloud connections (src/media.js, src/payment-events.js) with stand-ins
// for Cloud Storage and Pub/Sub, so no account is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import express from 'express';
import { bucketMedia } from '../src/media.js';
import { paymentRefFrom } from '../src/payment-events.js';

/** A Cloud Storage bucket in memory. */
function fakeStorage() {
  const objects = new Map(); // name → { body, contentType }
  const file = (name) => ({
    async save(body, { contentType }) { objects.set(name, { body, contentType }); },
    async delete() { objects.delete(name); },
    async exists() { return [objects.has(name)]; },
    createReadStream: () => Readable.from([objects.get(name).body]),
  });
  return { objects, storage: { bucket: () => ({ file }) } };
}

async function serveOnce(media, path) {
  const app = express();
  app.use('/media/gallery', media.serve('gallery'));
  app.use((req, res) => res.status(404).end());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, cache: res.headers.get('cache-control'), type: res.headers.get('content-type'), body: await res.text() };
  } finally {
    server.close();
  }
}

test('photos in a bucket: the original until the resized copy exists, then the copy', async () => {
  const { objects, storage } = fakeStorage();
  const media = bucketMedia('photos', { storage });

  await media.save('gallery', 'nails-abc.jpg', Buffer.from('original'));
  assert.deepEqual([...objects.keys()], ['originals/gallery/nails-abc.jpg']);
  assert.equal(objects.get('originals/gallery/nails-abc.jpg').contentType, 'image/jpeg');

  let res = await serveOnce(media, '/media/gallery/nails-abc.jpg');
  assert.equal(res.body, 'original');
  assert.equal(res.cache, 'public, max-age=60', 'cached briefly, the resized copy is on its way');

  objects.set('web/gallery/nails-abc.jpg', { body: 'resized' }); // what resize-image writes
  res = await serveOnce(media, '/media/gallery/nails-abc.jpg');
  assert.equal(res.body, 'resized');
  assert.equal(res.type, 'image/jpeg');
  assert.match(res.cache, /immutable/);

  await media.remove('gallery', 'nails-abc.jpg');
  assert.equal(objects.size, 0, 'original and copy are both deleted');
  assert.equal((await serveOnce(media, '/media/gallery/nails-abc.jpg')).status, 404);
});

test('only plain photo names are looked up in the bucket', async () => {
  const { storage } = fakeStorage();
  const media = bucketMedia('photos', { storage });
  for (const path of ['/media/gallery/..%2Foriginals%2Fx.jpg', '/media/gallery/x.svg', '/media/gallery/']) {
    assert.equal((await serveOnce(media, path)).status, 404, path);
  }
});

test('payment messages: only a plain reference is accepted', () => {
  const msg = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(paymentRefFrom(msg({ ref: 'test_sumup_ab12cd34ef56', provider: 'sumup' })), 'test_sumup_ab12cd34ef56');
  for (const bad of [{ ref: 'a b' }, { ref: 42 }, { ref: 'x'.repeat(129) }, {}, 'not json']) {
    assert.equal(paymentRefFrom(msg(bad)), null, JSON.stringify(bad));
  }
});
