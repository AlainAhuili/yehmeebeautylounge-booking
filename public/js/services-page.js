// "Dienstleistungen": the service list; "Weiter" starts the booking with that service.
// Service photos are managed on the admin page, not here.

import { t } from './i18n.js';
import { api } from './lib.js';
import { renderServiceList } from './service-list.js';

const root = document.getElementById('services');
try {
  const catalog = await api('GET', '/api/services');
  renderServiceList(root, catalog, { onNext: (service) => { location.href = `/buchen?service=${service.id}`; } });
} catch {
  root.textContent = t('common.loadError');
}
