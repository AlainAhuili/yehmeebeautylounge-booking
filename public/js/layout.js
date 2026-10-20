// Header and footer for every page (one copy instead of five), the mobile menu,
// the language menu, and "Mein Konto" instead of "Einloggen" when logged in.

import { LANGS, lang, setLang, t, translatePage } from './i18n.js';
import { currentUser } from './lib.js';

const page = document.body.dataset.page;
// Like the original, the booking steps count as "Dienstleistungen"
const section = page === 'book' ? 'services' : page;
const current = (name) => (section === name ? ' aria-current="page"' : '');

document.getElementById('site-header').outerHTML = `
  <header class="topbar">
    <div class="wrap topbar__inner">
      <a href="/" class="topbar__logo"><img src="/images/brand/logo.png" alt="YehMee Beauty Lounge" width="74" height="74" /></a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="menu" data-i18n-attr="aria-label: nav.openMenu"><span></span><span></span><span></span></button>
      <nav id="menu" class="menu">
        <a href="/"${current('home')} data-i18n="nav.home"></a>
        <a href="/dienstleistungen"${current('services')} data-i18n="nav.services"></a>
        <a href="/galerie"${current('gallery')} data-i18n="nav.gallery"></a>
        <a href="/login" class="menu__login" id="login-link"${current('login')} data-i18n="nav.login"></a>
        <a href="/buchen" class="btn" data-i18n="nav.book"></a>
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
      </div>
      <div class="footer__bottom">
        <a href="https://yehmeebeautylounge.com/" data-i18n="footer.privacy"></a>
        <a href="/dienstleistungen#bedingungen" data-i18n="footer.terms"></a>
        <a href="https://yehmeebeautylounge.com/" data-i18n="footer.imprint"></a>
      </div>
      <div class="footer__lang">
        <select id="lang-select" data-i18n-attr="aria-label: footer.language">
          ${LANGS.map((l) => `<option value="${l.code}" lang="${l.code}"${l.code === lang ? ' selected' : ''}>${l.label}</option>`).join('')}
        </select>
      </div>
    </div>
  </footer>`;

translatePage(document.querySelector('.topbar'));
translatePage(document.querySelector('.footer'));
document.getElementById('lang-select').addEventListener('change', (e) => setLang(e.target.value));

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
});
