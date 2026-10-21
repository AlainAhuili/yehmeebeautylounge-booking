// The service list of booking step 1, used on "Dienstleistungen" and "Jetzt buchen".
// One service per booking: choosing a service replaces the previous choice.

import { t, tc } from './i18n.js';
import { el, formatDuration, formatPrice, serviceName } from './lib.js';

const VISIBLE_PER_CATEGORY = 2;

/** Shows (or hides) the service photo at the top of its card. */
function setPhoto(card, url, alt) {
  card.querySelector('.service__photo')?.remove();
  card.classList.toggle('has-photo', Boolean(url));
  if (url) card.prepend(el('img', { className: 'service__photo', src: url, alt, loading: 'lazy' }));
}

function serviceCard(service, onPick) {
  const description = tc(service.description);
  const name = serviceName(service);
  const card = el('article', { className: 'service' });
  card.dataset.id = service.id;
  const pick = el('button', { className: 'service__pick', type: 'button', textContent: t('list.pick') });
  pick.addEventListener('click', () => onPick(service));
  card.append(el('h4', { textContent: name }), pick);

  if (description) {
    const desc = el('p', { className: 'service__desc is-clamped', textContent: description });
    card.append(desc);
    if (description.length > 110) {
      const toggle = el('button', { className: 'service__toggle', type: 'button', textContent: t('list.more') });
      toggle.addEventListener('click', () => {
        toggle.textContent = t(desc.classList.toggle('is-clamped') ? 'list.more' : 'list.less');
      });
      card.append(toggle);
    }
  }
  card.append(el('p', { className: 'service__meta' }, [
    el('span', { className: 'duration', textContent: formatDuration(service.durationMin) }),
    ` · ${formatPrice(service.priceEur)}`,
  ]));
  setPhoto(card, service.image, name);
  return card;
}

function categorySection(category, onPick, selectedId) {
  const section = el('section', { className: 'category' });
  section.append(el('h3', { textContent: tc(category.name) }));
  if (category.note) section.append(el('p', { className: 'category__note', textContent: tc(category.note) }));

  const cards = category.services.map((s) => serviceCard(s, onPick));
  const showAll = category.services.findIndex((s) => s.id === selectedId) >= VISIBLE_PER_CATEGORY;
  cards.forEach((card, i) => { card.hidden = !showAll && i >= VISIBLE_PER_CATEGORY; });
  section.append(...cards);

  if (!showAll && cards.length > VISIBLE_PER_CATEGORY) {
    const more = el('button', { className: 'category__more', type: 'button', textContent: t('list.showAll', { n: cards.length }) });
    more.addEventListener('click', () => {
      cards.forEach((card) => { card.hidden = false; });
      more.remove();
    });
    section.append(more);
  }
  return section;
}

/**
 * Renders the selection bar and the categories into `root`.
 * `onNext(service)` runs when "Weiter" is clicked with a service chosen.
 */
export function renderServiceList(root, catalog, { selectedId = null, onNext }) {
  const services = new Map(catalog.categories.flatMap((c) => c.services.map((s) => [s.id, s])));
  let selected = services.get(selectedId) || null;

  const text = el('p', { id: 'selection-text' });
  const next = el('button', { className: 'btn', type: 'button', id: 'next', textContent: t('list.next') });
  next.addEventListener('click', () => selected && onNext(selected));
  const bar = el('div', { className: 'selection' }, [text, next]);
  bar.setAttribute('aria-live', 'polite');

  const list = el('div');
  function update() {
    for (const card of list.querySelectorAll('.service')) {
      const on = card.dataset.id === selected?.id;
      card.classList.toggle('is-selected', on);
      card.querySelector('.service__pick').textContent = t(on ? 'list.picked' : 'list.pick');
    }
    text.textContent = selected
      ? t('list.one', { name: serviceName(selected), duration: formatDuration(selected.durationMin) })
      : t('list.none');
    next.disabled = !selected;
  }
  const onPick = (service) => {
    selected = selected?.id === service.id ? null : service;
    update();
  };

  list.append(...catalog.categories.map((c) => categorySection(c, onPick, selectedId)));
  root.replaceChildren(bar, list);
  update();
}
