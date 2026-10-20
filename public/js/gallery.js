// Gallery: photos from /api/gallery in the original order (top block, Nails, Wimpern),
// opened large in a dialog.

import { t } from './i18n.js';
import { api, el } from './lib.js';

const SECTIONS = [
  { key: 'featured', title: null },
  { key: 'nails', title: 'gallery.nails' },
  { key: 'lashes', title: 'gallery.lashes' },
];

const main = document.getElementById('gallery');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
document.getElementById('lightbox-close').addEventListener('click', () => lightbox.close());
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.close(); });

function photoLink(src, label) {
  const img = el('img', { src, alt: label, loading: 'lazy' });
  const a = el('a', { href: src }, [img]);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    lightboxImg.src = src;
    lightboxImg.alt = label;
    lightbox.showModal();
  });
  return a;
}

try {
  const groups = await api('GET', '/api/gallery');
  const parts = [];
  for (const { key, title } of SECTIONS) {
    const photos = groups[key] || [];
    if (!photos.length) continue;
    const section = t(title || 'gallery.title');
    if (title) parts.push(el('h2', { textContent: section }));
    parts.push(el('div', { className: 'grid' }, photos.map((src, i) => photoLink(src, t('gallery.photo', { section, n: i + 1 })))));
  }
  main.replaceChildren(...parts);
} catch {
  main.textContent = t('common.loadError');
}
