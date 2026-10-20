// Home: photo slider, opening hours from the salon data, click-to-load map.

import { t } from './i18n.js';
import { api, el, formatTime, weekdayName } from './lib.js';

// Slider: dots switch photos; it moves on every 5 seconds unless the visitor prefers less motion
const track = document.querySelector('.slider__track');
const dots = [...document.querySelectorAll('.slider__dots button')];
let current = 0;
function show(index) {
  current = (index + dots.length) % dots.length;
  track.style.transform = `translateX(-${current * 100}%)`;
  dots.forEach((dot, i) => dot.setAttribute('aria-current', String(i === current)));
}
dots.forEach((dot, i) => {
  dot.setAttribute('aria-label', t('home.photo', { n: i + 1 }));
  dot.addEventListener('click', () => show(i));
});
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setInterval(() => show(current + 1), 5000);

// Opening hours, Monday first like the original, weekday names in the visitor's language
const KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const salon = await api('GET', '/api/salon');
document.getElementById('hours').replaceChildren(...KEYS.map((key, i) => {
  const hours = salon.openingHours[key];
  return el('li', { className: hours ? '' : 'closed' }, [
    el('span', { textContent: weekdayName(i) }),
    hours ? el('strong', { textContent: `${formatTime(hours[0])} - ${formatTime(hours[1])}` }) : el('span', { textContent: t('home.closed') }),
  ]);
}));

// Map
document.getElementById('load-map').addEventListener('click', () => {
  const map = document.getElementById('map');
  const { street, postcode, city } = salon.address;
  const iframe = el('iframe', {
    title: `${salon.name}, ${street}, ${postcode} ${city}`,
    loading: 'lazy',
    referrerPolicy: 'no-referrer-when-downgrade',
    src: `https://maps.google.com/maps?q=${encodeURIComponent(`${street}, ${postcode} ${city}`)}&z=15&output=embed`,
  });
  map.replaceChildren(iframe);
  map.classList.add('is-loaded');
});
