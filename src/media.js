// Where uploaded photos (service photos, gallery) are kept and served from at /media/<kind>/<file>.
//   diskMedia:   a folder on this server (development, tests)
//   bucketMedia: a Cloud Storage bucket. The app stores the original under originals/; the
//                resize-image Cloud Run function writes a smaller copy under web/
//                (functions/resize-image), which is served once it exists.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { Storage } from '@google-cloud/storage';

export const MEDIA_KINDS = ['services', 'gallery'];
const SAFE_FILE = /^[\w-]+\.(jpg|png|webp)$/;
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/**
 * @typedef {object} Media
 * @property {(kind: string, file: string, body: Buffer) => Promise<void>} save
 * @property {(kind: string, file: string) => Promise<void>} remove
 * @property {(kind: string) => import('express').RequestHandler} serve
 */

/** @returns {Media} */
export function diskMedia(uploadsDir) {
  for (const kind of MEDIA_KINDS) mkdirSync(join(uploadsDir, kind), { recursive: true });
  return {
    async save(kind, file, body) { writeFileSync(join(uploadsDir, kind, file), body); },
    async remove(kind, file) { rmSync(join(uploadsDir, kind, file), { force: true }); },
    serve: (kind) => express.static(join(uploadsDir, kind), { maxAge: '7d', immutable: true, index: false }),
  };
}

/** @returns {Media} */
export function bucketMedia(bucketName, { storage = new Storage() } = {}) {
  const bucket = storage.bucket(bucketName);
  return {
    async save(kind, file, body) {
      const ext = file.split('.').pop();
      await bucket.file(`originals/${kind}/${file}`).save(body, { resumable: false, contentType: TYPES[ext] });
    },
    async remove(kind, file) {
      await Promise.all(['originals', 'web'].map((dir) => bucket.file(`${dir}/${kind}/${file}`).delete({ ignoreNotFound: true })));
    },
    serve: (kind) => async (req, res, next) => {
      const file = req.path.slice(1);
      if (!SAFE_FILE.test(file)) return next();
      // The resized copy once the function has written it; until then (a few seconds
      // after an upload) the original, cached only briefly so the copy takes over
      for (const [dir, cache] of [['web', 'public, max-age=604800, immutable'], ['originals', 'public, max-age=60']]) {
        const object = bucket.file(`${dir}/${kind}/${file}`);
        const [exists] = await object.exists();
        if (!exists) continue;
        res.set({ 'Content-Type': TYPES[file.split('.').pop()], 'Cache-Control': cache });
        object.createReadStream().on('error', next).pipe(res);
        return;
      }
      next();
    },
  };
}
