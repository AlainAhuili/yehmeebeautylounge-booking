// resize-image: makes a web-sized copy of every photo the booking app uploads.
// Trigger: Cloud Storage "object finalized" on the media bucket.
//   originals/<kind>/<file>  (written by the app, src/media.js)
//   → web/<kind>/<file>      at most 1600 px on the long side, same format
// The copy is turned upright (phone photos store their rotation separately) and carries
// no metadata: sharp drops EXIF, including the GPS position phones record.
// Its own web/ copies also trigger it; they are ignored, so it never loops.

import functions from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import sharp from 'sharp';

export const MAX_SIDE = 1600;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const SOURCE = /^originals\/(services|gallery)\/([\w-]+\.(jpg|png|webp))$/;
const OUTPUT = {
  jpg: { format: 'jpeg', options: { quality: 82, mozjpeg: true }, contentType: 'image/jpeg' },
  png: { format: 'png', options: { compressionLevel: 9, palette: true }, contentType: 'image/png' },
  webp: { format: 'webp', options: { quality: 80 }, contentType: 'image/webp' },
};

/** Where the web copy of an uploaded object goes, or null for objects it should skip. */
export function targetFor(name) {
  const match = SOURCE.exec(name);
  return match ? { target: `web/${match[1]}/${match[2]}`, ext: match[3] } : null;
}

/** The web-sized image: upright, at most MAX_SIDE, no metadata. */
export async function resize(input, ext) {
  const { format, options } = OUTPUT[ext];
  return sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .toFormat(format, options)
    .toBuffer();
}

export function makeResizeImage({ storage = new Storage() } = {}) {
  return async (cloudEvent) => {
    const { bucket: bucketName, name, size } = cloudEvent.data;
    const job = targetFor(name);
    if (!job) return;
    if (Number(size) > MAX_INPUT_BYTES) {
      console.warn(`Skipped ${name}: ${size} bytes is more than the app accepts`);
      return;
    }
    const bucket = storage.bucket(bucketName);
    let input;
    try {
      [input] = await bucket.file(name).download();
    } catch (err) {
      if (err.code === 404) return console.log(`Skipped ${name}: deleted before it was resized`);
      throw err;
    }
    const output = await resize(input, job.ext);
    await bucket.file(job.target).save(output, {
      resumable: false,
      contentType: OUTPUT[job.ext].contentType,
      metadata: { cacheControl: 'public, max-age=604800, immutable' },
    });
    console.log(`${name} (${input.length} bytes) → ${job.target} (${output.length} bytes)`);
  };
}

functions.cloudEvent('resizeImage', makeResizeImage());
