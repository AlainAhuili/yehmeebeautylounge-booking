// Admin only: the photo area under a service card. Click or drop an image; the
// browser shrinks it to at most 1200 px and re-encodes it as JPEG, which also
// removes hidden metadata such as the GPS position of phone photos.

import { t } from '/js/i18n.js';
import { api, el } from '/js/lib.js';

const MAX_SIDE = 1200;
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const IMAGE_TYPES = TYPES;

/** A JPEG Blob of the image, at most MAX_SIDE pixels on its longer side, the right way up. */
export async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = el('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

/**
 * The upload area for one service.
 * `onChange(imageUrl | null)` runs after a photo was saved or removed; after
 * removing, the service's default photo (if it has one) is shown again.
 */
export function photoUploader(service, serviceLabel, onChange) {
  const input = el('input', { type: 'file', accept: TYPES.join(','), hidden: true });
  const status = el('p', { className: 'uploader__status', role: 'status' });
  const choose = el('button', { className: 'uploader__drop', type: 'button' });
  const remove = el('button', { className: 'btn btn--small', type: 'button', textContent: t('admin.remove') });
  const box = el('div', { className: 'uploader' }, [choose, remove, input, status]);

  // Only an uploaded photo can be removed; a default photo just gets replaced
  let current = service.image && !service.imageIsDefault ? service.image : null;
  function refresh() {
    choose.replaceChildren(
      el('strong', { textContent: t(current || service.defaultImage ? 'admin.replace' : 'admin.upload') }),
      el('span', { textContent: t('admin.hint') }),
    );
    remove.hidden = !current;
  }

  async function send(file) {
    status.className = 'uploader__status';
    if (!file) return;
    if (!TYPES.includes(file.type)) { status.textContent = t('admin.badType'); status.classList.add('is-error'); return; }
    if (file.size > MAX_BYTES * 4) { status.textContent = t('admin.tooBig'); status.classList.add('is-error'); return; }
    box.classList.add('is-busy');
    status.textContent = t('admin.uploading');
    try {
      const blob = await shrink(file);
      if (blob.size > MAX_BYTES) throw new Error(t('admin.tooBig'));
      ({ image: current } = await api('PUT', `/api/admin/services/${service.id}/image`, blob));
      status.textContent = t('admin.saved');
      onChange(current);
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('is-error');
    } finally {
      box.classList.remove('is-busy');
      input.value = '';
      refresh();
    }
  }

  choose.addEventListener('click', () => input.click());
  input.addEventListener('change', () => send(input.files[0]));
  for (const type of ['dragenter', 'dragover']) {
    choose.addEventListener(type, (e) => { e.preventDefault(); choose.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    choose.addEventListener(type, () => choose.classList.remove('is-over'));
  }
  choose.addEventListener('drop', (e) => { e.preventDefault(); send(e.dataTransfer.files[0]); });

  remove.addEventListener('click', async () => {
    if (!confirm(t('admin.confirmRemove', { service: serviceLabel }))) return;
    try {
      await api('DELETE', `/api/admin/services/${service.id}/image`);
      current = null;
      status.className = 'uploader__status';
      status.textContent = t('admin.removed');
      onChange(service.defaultImage || null);
      refresh();
    } catch (err) {
      status.textContent = err.message;
      status.classList.add('is-error');
    }
  });

  refresh();
  return box;
}
