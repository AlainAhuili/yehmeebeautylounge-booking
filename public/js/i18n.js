// Translation. The language comes from ?lang=, then the visitor's last choice,
// then the browser, then German. Texts fall back: US English → English → German,
// any other language → German. Elements in the HTML carry their key:
//   data-i18n="key"        text
//   data-i18n-html="key"   HTML (only our own translation files)
//   data-i18n-attr="placeholder:key; aria-label:key"

export const LANGS = [
  { code: 'en', label: 'English', locale: 'en-GB' },
  { code: 'en-US', label: 'English (United States)', locale: 'en-US' },
  { code: 'fr', label: 'Français', locale: 'fr-FR' },
  { code: 'de', label: 'Deutsch', locale: 'de-DE' },
  { code: 'es', label: 'Español', locale: 'es-ES' },
  { code: 'it', label: 'Italiano', locale: 'it-IT' },
  { code: 'nl', label: 'Nederlands', locale: 'nl-NL' },
  { code: 'pt', label: 'Português', locale: 'pt-PT' },
  { code: 'tr', label: 'Türkçe', locale: 'tr-TR' },
  { code: 'el', label: 'Ελληνικά', locale: 'el-GR' },
  { code: 'pl', label: 'Polski', locale: 'pl-PL' },
  { code: 'cs', label: 'Čeština', locale: 'cs-CZ' },
];
const DEFAULT = 'de';
const known = (code) => LANGS.find((l) => l.code === code);

function stored() {
  try { return localStorage.getItem('lang'); } catch { return null; }
}

function remember(code) {
  try { localStorage.setItem('lang', code); } catch { /* not remembered in private mode */ }
}

function detect() {
  // A language in the link is remembered, so it stays when the visitor moves on
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (known(fromUrl)) {
    remember(fromUrl);
    return fromUrl;
  }
  if (known(stored())) return stored();
  for (const tag of navigator.languages || [navigator.language]) {
    if (known(tag)) return tag;
    const base = String(tag).split('-')[0].toLowerCase();
    if (known(base)) return base;
  }
  return DEFAULT;
}

export const lang = detect();
export const locale = known(lang).locale;
const textChain = lang === 'en-US' ? ['en-US', 'en', 'de'] : [...new Set([lang, 'de'])];
/** Order for service names and descriptions (they have no US variant). */
const contentChain = [...new Set([lang === 'en-US' ? 'en' : lang, 'en', 'de'])];

const dictionaries = await Promise.all(textChain.map(async (code) => {
  try {
    const res = await fetch(`/i18n/${code}.json`);
    return res.ok ? res.json() : {};
  } catch {
    return {};
  }
}));

/** Translated UI text; {name} placeholders are filled from `vars`. */
export function t(key, vars = {}) {
  const text = dictionaries.map((d) => d[key]).find((v) => v !== undefined) ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? vars[name] : m));
}

/** Translated content from an object like { de: "...", en: "...", fr: "..." }. */
export function tc(texts) {
  if (!texts) return '';
  for (const code of contentChain) if (texts[code]) return texts[code];
  return Object.values(texts)[0] || '';
}

export function setLang(code) {
  remember(code);
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  location.replace(url);
}

export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}

// Page language, title and description
document.documentElement.lang = lang;
const page = document.body.dataset.page;
if (page) document.title = t(`page.${page}`);
document.querySelector('meta[name="description"]')?.setAttribute('content', t('page.description'));
translatePage();
