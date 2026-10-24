import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MAX_SIDE, makeResizeImage, resize, targetFor } from './index.js';

/** A photo like a phone's: large, stored sideways (EXIF orientation 6) and with GPS data. */
const phonePhoto = () =>
  sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#c86478' } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '53/1 3/1 0/1' } } })
    .toBuffer();

test('only originals uploaded by the app are resized', () => {
  assert.deepEqual(targetFor('originals/gallery/nails-abc.jpg'), { target: 'web/gallery/nails-abc.jpg', ext: 'jpg' });
  assert.deepEqual(targetFor('originals/services/gel-polish-x1.webp'), { target: 'web/services/gel-polish-x1.webp', ext: 'webp' });
  for (const name of ['web/gallery/nails-abc.jpg', 'originals/other/x.jpg', 'originals/gallery/x.gif', 'originals/gallery/../x.jpg', 'db/backup.sql.gz']) {
    assert.equal(targetFor(name), null, name);
  }
});

test('a phone photo becomes upright, at most 1600 px, without GPS or other metadata', async () => {
  const input = await phonePhoto();
  assert.ok((await sharp(input).metadata()).exif, 'the test photo has EXIF');

  const output = await resize(input, 'jpg');
  const meta = await sharp(output).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.deepEqual([meta.width, meta.height], [1200, MAX_SIDE], 'rotated to portrait and scaled down');
  assert.equal(meta.exif, undefined, 'no EXIF, so no GPS position');
  assert.equal(meta.orientation, undefined);
  assert.ok(output.length < input.length);
});

test('small photos are not enlarged and keep their format', async () => {
  const png = await sharp({ create: { width: 300, height: 200, channels: 4, background: '#00000000' } }).png().toBuffer();
  const meta = await sharp(await resize(png, 'png')).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 300, 200]);
});

test('the function reads the original and writes the web copy next to it', async () => {
  const objects = new Map([['originals/gallery/nails-abc.jpg', await phonePhoto()]]);
  const saved = {};
  const storage = {
    bucket: () => ({
      file: (name) => ({
        async download() { return [objects.get(name)]; },
        async save(body, opts) { objects.set(name, body); saved[name] = opts; },
      }),
    }),
  };
  const run = makeResizeImage({ storage });
  await run({ data: { bucket: 'media', name: 'originals/gallery/nails-abc.jpg', size: '2000000' } });
  await run({ data: { bucket: 'media', name: 'web/gallery/nails-abc.jpg', size: '100' } }); // its own output: ignored

  assert.deepEqual([...objects.keys()].sort(), ['originals/gallery/nails-abc.jpg', 'web/gallery/nails-abc.jpg']);
  assert.equal(saved['web/gallery/nails-abc.jpg'].contentType, 'image/jpeg');
  assert.equal((await sharp(objects.get('web/gallery/nails-abc.jpg')).metadata()).height, MAX_SIDE);
});
