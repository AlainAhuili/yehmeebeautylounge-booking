// Admin page: manage the gallery photos (upload several at once, delete, restore
// hidden originals) and the photo of every service. The server checks the admin
// role on every request; this page only offers the controls.

// Served only to admins from the private admin/ folder (see src/app.js); the shared
// modules come from the public /js folder.
import { t, tc } from '/js/i18n.js';
import { api, el, serviceName } from '/js/lib.js';
import { userPromise } from '/js/layout.js';
import { IMAGE_TYPES, photoUploader, shrink } from './photo-upload.js';

const SECTIONS = [
  { key: 'featured', title: 'adminPage.featured' },
  { key: 'nails', title: 'gallery.nails' },
  { key: 'lashes', title: 'gallery.lashes' },
];
const status = document.getElementById('admin-status');

function say(message, kind = 'ok') {
  status.hidden = !message;
  status.className = `alert alert--${kind}`;
  status.textContent = message;
}

// ---- Gallery ------------------------------------------------------------------

async function loadGallery() {
  const groups = await api('GET', '/api/admin/gallery');
  document.getElementById('gallery-admin').replaceChildren(...SECTIONS.map(({ key, title }) => gallerySection(key, t(title), groups[key] || [])));
}

function gallerySection(key, title, photos) {
  const visible = photos.filter((p) => !p.hidden).length;
  const input = el('input', { type: 'file', accept: IMAGE_TYPES.join(','), multiple: true, hidden: true });
  const drop = el('button', { className: 'uploader__drop', type: 'button' }, [
    el('strong', { textContent: t('adminPage.addPhotos') }),
    el('span', { textContent: t('adminPage.addHint') }),
  ]);
  const progress = el('p', { className: 'uploader__status', role: 'status' });

  async function upload(files) {
    const images = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
    if (!images.length) { progress.className = 'uploader__status is-error'; progress.textContent = t('admin.badType'); return; }
    drop.disabled = true;
    let done = 0;
    try {
      for (const file of images) {
        progress.className = 'uploader__status';
        progress.textContent = `${t('admin.uploading')} ${done + 1}/${images.length}`;
        await api('POST', `/api/admin/gallery/${key}`, await shrink(file));
        done += 1;
      }
      say(t('adminPage.uploadedN', { n: done }));
    } catch (err) {
      say(err.message, 'error');
    } finally {
      drop.disabled = false;
      await loadGallery();
    }
  }

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => upload(input.files));
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  for (const type of ['dragleave', 'drop']) drop.addEventListener(type, () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); upload(e.dataTransfer.files); });

  return el('section', { className: 'admin__gallery' }, [
    el('h3', {}, [title, el('small', { textContent: ` · ${t('adminPage.count', { n: visible })}` })]),
    el('div', { className: 'uploader' }, [drop, input, progress]),
    el('ul', { className: 'admin__grid' }, photos.map(photoTile)),
  ]);
}

function photoTile(photo) {
  const tile = el('li', { className: `admin__tile${photo.hidden ? ' is-hidden' : ''}` }, [
    el('img', { src: photo.src, alt: '', loading: 'lazy' }),
  ]);
  if (photo.hidden) {
    const restore = el('button', { className: 'btn btn--small', type: 'button', textContent: t('adminPage.restore') });
    restore.addEventListener('click', async () => {
      try {
        await api('POST', `/api/admin/gallery/${photo.id}/restore`);
        say(t('adminPage.restored'));
        await loadGallery();
      } catch (err) { say(err.message, 'error'); }
    });
    tile.append(el('span', { className: 'admin__badge', textContent: t('adminPage.hidden') }), restore);
  } else {
    const remove = el('button', { className: 'admin__delete', type: 'button', textContent: '×' });
    remove.setAttribute('aria-label', t('adminPage.delete'));
    remove.title = t('adminPage.delete');
    remove.addEventListener('click', async () => {
      if (!confirm(t('adminPage.confirmDelete'))) return;
      try {
        await api('DELETE', `/api/admin/gallery/${photo.id}`);
        say(t('adminPage.deleted'));
        await loadGallery();
      } catch (err) { say(err.message, 'error'); }
    });
    tile.append(remove);
  }
  return tile;
}

// ---- Service photos -----------------------------------------------------------

async function loadServices() {
  const catalog = await api('GET', '/api/services');
  const parts = [];
  for (const category of catalog.categories) {
    parts.push(el('h3', { textContent: tc(category.name) }));
    parts.push(el('ul', { className: 'admin__services' }, category.services.map((service) => {
      const name = serviceName(service);
      const thumb = el('div', { className: 'admin__thumb' });
      const show = (url) => thumb.replaceChildren(url ? el('img', { src: url, alt: '' }) : el('span', { textContent: '–' }));
      show(service.image);
      return el('li', { className: 'admin__service' }, [thumb, el('strong', { textContent: name }), photoUploader(service, name, show)]);
    })));
  }
  document.getElementById('services-admin').replaceChildren(...parts);
}

// ---- Start --------------------------------------------------------------------

// The server only sends this page to admins; this check covers a session that
// ended while the page was open.
const user = await userPromise;
if (!user?.isAdmin) {
  location.replace('/login');
} else {
  await Promise.all([loadGallery(), loadServices()]);
}
