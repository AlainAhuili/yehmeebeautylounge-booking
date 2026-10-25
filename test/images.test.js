import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES, createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { Store } from '../src/store.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const store = new Store(null);
store.data.users.push(
  { id: 'u_admin', name: 'Melissa', email: 'admin@example.com', phone: '', role: 'admin', passwordHash: hashPassword('admin-pass') },
  { id: 'u_cust', name: 'Kundin', email: 'kundin@example.com', phone: '', passwordHash: hashPassword('kunde-pass') },
);
const uploadsDir = mkdtempSync(join(tmpdir(), 'yehmee-img-'));
const app = createApp({
  store, salon: read('../content/salon.json'), catalog: read('../content/services.json'),
  manifest: read('../public/images/manifest.json'), uploadsDir, mail: () => {},
});

let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function login(email, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.headers.get('set-cookie').split(';')[0];
}
const upload = (cookie, body, type = 'image/jpeg', id = 'classic-1-1') =>
  fetch(`${base}/api/admin/services/${id}/image`, { method: 'PUT', headers: { 'Content-Type': type, ...(cookie ? { Cookie: cookie } : {}) }, body });

// The smallest valid-looking files: real magic bytes plus padding
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]);
const imageOf = async (id) => {
  const catalog = await (await fetch(`${base}/api/services`)).json();
  return catalog.categories.flatMap((c) => c.services).find((s) => s.id === id).image;
};

test('only an admin can upload; for everyone else the address does not exist', async () => {
  assert.equal((await upload(null, jpeg)).status, 404);
  const customer = await login('kundin@example.com', 'kunde-pass');
  assert.equal((await upload(customer, jpeg)).status, 404);
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: customer } })).json();
  assert.equal(me.user.isAdmin, false);
});

test('files that are not images are refused, whatever they claim to be', async () => {
  const admin = await login('admin@example.com', 'admin-pass');
  const fake = await upload(admin, Buffer.from('<script>alert(1)</script>'.padEnd(300, ' ')), 'image/jpeg');
  assert.equal(fake.status, 400);
  assert.equal((await fake.json()).code, 'invalid_image');
  assert.equal((await upload(admin, jpeg, 'image/jpeg', 'does-not-exist')).status, 404);
});

test('images over 5 MB are refused', async () => {
  const admin = await login('admin@example.com', 'admin-pass');
  const big = Buffer.concat([jpeg, Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.equal((await upload(admin, big)).status, 413);
});

test('an uploaded photo is shown with its service and can be loaded', async () => {
  const admin = await login('admin@example.com', 'admin-pass');
  const res = await upload(admin, jpeg);
  assert.equal(res.status, 200);
  const { image } = await res.json();
  assert.match(image, /^\/media\/services\/classic-1-1-\w+\.jpg$/);
  assert.equal(await imageOf('classic-1-1'), image);

  const file = await fetch(base + image);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), jpeg);
});

test('services with a default photo show it until an admin uploads one', async () => {
  const catalog = await (await fetch(`${base}/api/services`)).json();
  const refill = catalog.categories.flatMap((c) => c.services).find((s) => s.id === 'refill');
  assert.equal(refill.image, '/images/gallery/lashes/lashes-11.jpg');
  assert.equal(refill.imageIsDefault, true);
});

test('every default photo in services.json exists', () => {
  const catalog = read('../content/services.json');
  for (const s of catalog.categories.flatMap((c) => c.services).filter((x) => x.defaultImage || x.moreImages)) {
    for (const path of [s.defaultImage, ...(s.moreImages ?? [])].filter(Boolean)) {
      assert.ok(existsSync(new URL(`../public${path}`, import.meta.url)), `${s.id}: ${path}`);
    }
  }
});

test('a service with more photos lists them after its main photo', async () => {
  const catalog = await (await fetch(`${base}/api/services`)).json();
  const services = catalog.categories.flatMap((c) => c.services);
  const acrylic = services.find((s) => s.id === 'acrylic-new-set');
  assert.deepEqual(acrylic.images, [
    '/images/services/acrylic-new-set.jpg',
    '/images/services/acrylic-new-set-2.jpg',
    '/images/services/acrylic-new-set-3.jpg',
  ]);
  assert.equal(acrylic.image, acrylic.images[0], 'the admin page keeps using image');
  const refill = services.find((s) => s.id === 'refill');
  assert.deepEqual(refill.images, [refill.image], 'one photo stays one photo');
});

test('replacing a photo deletes the old file; removing goes back to the default', async () => {
  const admin = await login('admin@example.com', 'admin-pass');
  const first = await imageOf('classic-1-1');
  await new Promise((r) => setTimeout(r, 5));
  const { image: second } = await (await upload(admin, png, 'image/png')).json();
  assert.match(second, /\.png$/);
  assert.notEqual(second, first);
  const files = readdirSync(join(uploadsDir, 'services'));
  assert.deepEqual(files, [second.split('/').pop()], 'only the newest photo is kept');

  const removed = await fetch(`${base}/api/admin/services/classic-1-1/image`, { method: 'DELETE', headers: { Cookie: admin } });
  assert.equal(removed.status, 204);
  assert.equal(await imageOf('classic-1-1'), '/images/gallery/lashes/lashes-05.jpg');
  assert.ok(!existsSync(join(uploadsDir, 'services', second.split('/').pop())));
});
