// Header and footer for every page (one copy instead of five), the mobile menu
// (with language, "add to home screen" and legal links, as on the original site),
// the language menu, and "Mein Konto" instead of "Einloggen" when logged in.

import { LANGS, lang, setLang, t, translatePage } from './i18n.js';
import { currentUser } from './lib.js';

const page = document.body.dataset.page;
// Like the original, the booking steps count as "Dienstleistungen"
const section = page === 'book' ? 'services' : page;
const current = (name) => (section === name ? ' aria-current="page"' : '');
const langOptions = LANGS.map((l) => `<option value="${l.code}" lang="${l.code}"${l.code === lang ? ' selected' : ''}>${l.label}</option>`).join('');

// "Add to home screen": the web app manifest and icons, added once for every page
for (const [tag, attrs] of [
  ['link', { rel: 'manifest', href: '/manifest.webmanifest' }],
  ['link', { rel: 'apple-touch-icon', href: '/images/brand/icon-192.png' }],
  ['meta', { name: 'theme-color', content: '#ffffff' }],
]) {
  if (!document.head.querySelector(`${tag}[${Object.keys(attrs)[0]}="${Object.values(attrs)[0]}"]`)) {
    document.head.append(Object.assign(document.createElement(tag), attrs));
  }
}

document.getElementById('site-header').outerHTML = `
  <header class="topbar">
    <div class="wrap topbar__inner">
      <a href="/" class="topbar__logo"><img src="/images/brand/logo.png" alt="YehMee Beauty Lounge" width="74" height="74" /></a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="menu" data-i18n-attr="aria-label: nav.openMenu"><span></span><span></span><span></span></button>
      <nav id="menu" class="menu">
        <a href="/" class="menu__logo" tabindex="-1" aria-hidden="true"><img src="/images/brand/logo.png" alt="" width="74" height="74" /></a>
        <a href="/"${current('home')} data-i18n="nav.home"></a>
        <a href="/dienstleistungen"${current('services')} data-i18n="nav.services"></a>
        <a href="/galerie"${current('gallery')} data-i18n="nav.gallery"></a>
        <a href="/gutschein"${current('voucher')} data-i18n="nav.voucher"></a>
        <a href="/admin" id="admin-link"${current('admin')} data-i18n="nav.admin" hidden></a>
        <a href="/login" class="menu__login" id="login-link"${current('login')} data-i18n="nav.login"></a>
        <a href="/buchen" class="btn" data-i18n="nav.book"></a>
        <div class="menu__extra">
          <select class="lang-select" data-i18n-attr="aria-label: footer.language">${langOptions}</select>
          <div class="app-card" id="app-card">
            <h2 data-i18n="app.title"></h2>
            <p data-i18n="app.text"></p>
            <button class="btn app-card__add" type="button" id="app-add" data-i18n="app.add"></button>
            <p class="app-card__hint" id="app-hint" role="status" hidden></p>
          </div>
          <div class="menu__legal">
            <a href="https://yehmeebeautylounge.com/" data-i18n="footer.privacy"></a>
            <a href="/dienstleistungen#bedingungen" data-i18n="footer.terms"></a>
            <a href="https://yehmeebeautylounge.com/" data-i18n="footer.imprint"></a>
          </div>
        </div>
      </nav>
    </div>
  </header>`;

document.getElementById('site-footer').outerHTML = `
  <footer class="footer">
    <div class="wrap">
      <div class="footer__top">
        <a href="/"><img src="/images/brand/logo.png" alt="YehMee Beauty Lounge" width="74" height="74" /></a>
        <a href="/" data-i18n="nav.home"></a>
        <a href="/dienstleistungen" data-i18n="nav.services"></a>
        <a href="/galerie" data-i18n="nav.gallery"></a>
        <a href="/gutschein" data-i18n="nav.voucher"></a>
      </div>
      <div class="footer__bottom">
        <a href="https://yehmeebeautylounge.com/" data-i18n="footer.privacy"></a>
        <a href="/dienstleistungen#bedingungen" data-i18n="footer.terms"></a>
        <a href="https://yehmeebeautylounge.com/" data-i18n="footer.imprint"></a>
      </div>
      <div class="footer__lang">
        <select id="lang-select" class="lang-select" data-i18n-attr="aria-label: footer.language">${langOptions}</select>
      </div>
    </div>
  </footer>`;

translatePage(document.querySelector('.topbar'));
translatePage(document.querySelector('.footer'));
for (const select of document.querySelectorAll('.lang-select')) select.addEventListener('change', (e) => setLang(e.target.value));

// The phone menu's "add to home screen" card. Chrome and Edge offer their own
// install prompt; Safari on iPhone has none, so there the button explains the two taps.
const appCard = document.getElementById('app-card');
const appHint = document.getElementById('app-hint');
let installPrompt = null;
if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) appCard.hidden = true;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { appCard.hidden = true; });
document.getElementById('app-add').addEventListener('click', async () => {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') appCard.hidden = true;
    return;
  }
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  appHint.textContent = t(iOS ? 'app.iosHint' : 'app.otherHint');
  appHint.hidden = false;
});

const toggle = document.querySelector('.menu-toggle');
const menu = document.getElementById('menu');
toggle.addEventListener('click', () => {
  const open = menu.classList.toggle('is-open');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', t(open ? 'nav.closeMenu' : 'nav.openMenu'));
});

export const userPromise = currentUser();
userPromise.then((user) => {
  if (user) document.getElementById('login-link').textContent = t('nav.account');
  if (user?.isAdmin) document.getElementById('admin-link').hidden = false;
});
