import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { Store } from '../src/store.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const store = new Store(null);
store.data.users.push(
  { id: 'u_admin', name: 'Melissa', email: 'admin@example.com', phone: '', role: 'admin', passwordHash: hashPassword('admin-pass') },
  { id: 'u_cust', name: 'Kundin', email: 'kundin@example.com', phone: '', passwordHash: hashPassword('kunde-pass') },
);
const uploadsDir = mkdtempSync(join(tmpdir(), 'yehmee-gal-'));
const adminDir = new URL('../admin/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const app = createApp({
  store, salon: read('../content/salon.json'), catalog: read('../content/services.json'),
  manifest: read('../public/images/manifest.json'), uploadsDir, adminDir: decodeURIComponent(adminDir), mail: () => {},
});

let server;
let base;
let admin;
let customer;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@example.com', 'admin-pass');
  customer = await login('kundin@example.com', 'kunde-pass');
});
after(() => server.close());

async function login(email, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.headers.get('set-cookie').split(';')[0];
}
const call = (method, path, cookie, body, type = 'image/jpeg') =>
  fetch(base + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': type } : {}) }, body });
const publicGallery = async () => (await fetch(`${base}/api/gallery`)).json();
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

test('the admin page and its files exist only for admins', async () => {
  for (const path of ['/admin', '/admin/', '/admin/admin.js', '/admin/photo-upload.js', '/admin/admin.css']) {
    for (const cookie of [null, customer]) {
      const res = await call('GET', path, cookie);
      assert.equal(res.status, 404, `${path} must look like it does not exist`);
      assert.ok(!(await res.text()).includes('Fotos verwalten'), 'nothing of the admin page leaks');
    }
  }
  const page = await call('GET', '/admin', admin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /adminPage\.title/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.equal((await call('GET', '/admin/admin.js', admin)).status, 200);
});

test('for everyone but admins the admin API does not exist', async () => {
  for (const cookie of [null, customer]) {
    assert.equal((await call('GET', '/api/admin/gallery', cookie)).status, 404);
    assert.equal((await call('POST', '/api/admin/gallery/nails', cookie, jpeg)).status, 404);
    assert.equal((await call('DELETE', '/api/admin/gallery/b-nails-01', cookie)).status, 404);
  }
});

test('changes sent from another website are refused, even for the admin', async () => {
  const res = await fetch(`${base}/api/admin/gallery/b-nails-01`, { method: 'DELETE', headers: { Cookie: admin, Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  const same = await fetch(`${base}/api/admin/gallery/b-nails-01/restore`, { method: 'POST', headers: { Cookie: admin, Origin: base } });
  assert.equal(same.status, 204);
});

test('every response carries the security headers', async () => {
  const res = await fetch(`${base}/api/salon`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('an admin session lasts 12 hours, a customer session 30 days', async () => {
  const cookieAge = async (email, password) => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return Number(/Max-Age=(\d+)/.exec(res.headers.get('set-cookie'))[1]);
  };
  assert.equal(await cookieAge('admin@example.com', 'admin-pass'), 12 * 60 * 60);
  assert.equal(await cookieAge('kundin@example.com', 'kunde-pass'), 30 * 24 * 60 * 60);
});

test('the gallery starts with the 70 built-in photos', async () => {
  const g = await publicGallery();
  assert.deepEqual([g.featured.length, g.nails.length, g.lashes.length], [23, 20, 27]);
});

test('an uploaded photo appears first in its section and can be deleted for good', async () => {
  const res = await call('POST', '/api/admin/gallery/nails', admin, jpeg);
  assert.equal(res.status, 201);
  const { photo } = await res.json();
  assert.equal((await publicGallery()).nails[0], photo.src);
  assert.equal((await fetch(base + photo.src)).status, 200);

  const file = join(uploadsDir, 'gallery', photo.src.split('/').pop());
  assert.ok(existsSync(file));
  assert.equal((await call('DELETE', `/api/admin/gallery/${photo.id}`, admin)).status, 204);
  assert.ok(!existsSync(file));
  assert.equal((await publicGallery()).nails.length, 20);
});

test('uploads are checked: real images only, and only into known sections', async () => {
  assert.equal((await call('POST', '/api/admin/gallery/nails', admin, Buffer.from('x'.repeat(300)))).status, 400);
  assert.equal((await call('POST', '/api/admin/gallery/secret', admin, jpeg)).status, 404);
});

test('deleting a built-in photo hides it, and it can be restored', async () => {
  assert.equal((await call('DELETE', '/api/admin/gallery/b-lashes-01', admin)).status, 204);
  let g = await publicGallery();
  assert.equal(g.lashes.length, 26);
  assert.ok(!g.lashes.includes('/images/gallery/lashes/lashes-01.jpg'));

  const forAdmin = await (await call('GET', '/api/admin/gallery', admin)).json();
  assert.equal(forAdmin.lashes.find((p) => p.id === 'b-lashes-01').hidden, true);

  assert.equal((await call('POST', '/api/admin/gallery/b-lashes-01/restore', admin)).status, 204);
  g = await publicGallery();
  assert.equal(g.lashes.length, 27);
  assert.equal((await call('DELETE', '/api/admin/gallery/b-unknown', admin)).status, 404);
});
