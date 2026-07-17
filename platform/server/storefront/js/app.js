/* Shell + hash router. Pages register themselves in Routes. */
'use strict';

const Routes = {};   // '#/products' -> {render(el, args), title, public}

const NAV = [
  { hash: '#/products',    label: 'Products' },
  { hash: '#/orders',      label: 'Orders' },
  { hash: '#/backorders',  label: 'Backorders' },
  { hash: '#/returns',     label: 'Returns' },
  { hash: '#/favourites',  label: 'Favorites' },
  { hash: '#/replenishment', label: 'Reorder' },
  { hash: '#/spare-parts', label: 'Spare Parts' },
  { hash: '#/customers',   label: 'My Customers', roles: ['agent', 'super-agent', 'admin'] },
  { hash: '#/lists',       label: 'Frame Lists',  roles: ['agent', 'super-agent', 'admin'] },
  { hash: '#/account',     label: 'My Account' },
];

function navFor(user) {
  return NAV.filter(n => !n.roles || n.roles.includes(user.role));
}

/** Effective hide-prices = the account setting OR presentation mode. Every
    price on the site reads Store.session.user.hidePrices, so setting it here
    hides prices everywhere with no other changes. */
function applyPricingMode() {
  if (Store.session?.user) Store.session.user.hidePrices = Store.realHide || Store.presenting;
}

function setPresenting(on) {
  Store.presenting = on;
  try { localStorage.setItem('veyora_present', on ? '1' : '0'); } catch { /* private mode */ }
  applyPricingMode();
  route();   // re-render current page with prices shown/hidden
}

function eyeIcon(off) {
  return off
    ? `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 3l18 18"/><path d="M10.6 10.7a2 2 0 002.7 2.8"/><path d="M9.4 5.2A9.5 9.5 0 0112 5c5 0 9 4.5 10 7-.5 1.2-1.6 2.8-3.2 4.1M6.1 6.2C4 7.5 2.6 9.5 2 12c1 2.5 5 7 10 7 1.2 0 2.4-.3 3.4-.7"/></svg>`
    : `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

/* icons for the app-style bottom nav (matching the old site's outline set) */
const NAVICON = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>`,
  glasses: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6.5" cy="14.5" r="3.5"/><circle cx="17.5" cy="14.5" r="3.5"/><path d="M10 14.5q2 -1.6 4 0"/><path d="M3 14.5 2 10M21 14.5 22 10"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>`,
  bag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h12l1 14H5L6 7z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  burger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
};

/* Old-site bottom nav: Home (public home), Products, Spare parts, Cart,
   My Account (→ the dashboard, exactly like the old site). */
const BOTTOM_NAV = [
  { hash: '#/',            label: 'Home',       icon: 'home' },
  { hash: '#/products',    label: 'Products',   icon: 'glasses' },
  { hash: '#/spare-parts', label: 'Spare parts', icon: 'gear' },
  { hash: '#/cart',        label: 'Cart',       icon: 'bag', badge: true },
  { hash: '#/dashboard',   label: 'My Account', icon: 'user' },
];

function shell(contentEl, activeHash) {
  const u = Store.session.user;
  const el = h(`<div>
    <header class="topbar">
      <button class="burger" aria-label="Menu">${NAVICON.burger}</button>
      <img class="logo" src="assets/logo-white.svg" alt="Veyora" style="width:126px;cursor:pointer" onclick="location.hash='#/dashboard'"/>
      <div class="spacer"></div>
      <button class="icon-btn present-toggle ${Store.presenting ? 'on' : ''}" data-present
        title="${Store.presenting ? 'Presentation mode ON — prices hidden. Click to show prices.' : 'Presentation mode — hide your prices to show frames to customers'}">${eyeIcon(Store.presenting)}</button>
      <button class="icon-btn" title="Favorites" onclick="location.hash='#/favourites'">♡</button>
      <button class="icon-btn" title="Cart" onclick="location.hash='#/cart'">🛒<span class="badge" id="cartBadge" style="${Store.cartCount ? '' : 'display:none'}">${Store.cartCount}</span></button>
      <button class="icon-btn" title="My Account" onclick="location.hash='#/account'">👤</button>
    </header>
    <nav class="nav">${navFor(u).map(n =>
      `<a href="${n.hash}" class="${activeHash.startsWith(n.hash) ? 'active' : ''}">${n.label}</a>`).join('')}
    </nav>
    <div class="drawer-back">
      <div class="drawer">
        <div class="dhead"><img src="assets/logo-black.svg" alt="Veyora"/></div>
        <a href="#/dashboard" class="${activeHash === '#/dashboard' ? 'active' : ''}">Dashboard</a>
        ${navFor(u).map(n =>
          `<a href="${n.hash}" class="${activeHash.startsWith(n.hash) ? 'active' : ''}">${n.label}</a>`).join('')}
        <div class="drow" data-present-drawer>${eyeIcon(Store.presenting)}
          ${Store.presenting ? 'Show my prices' : 'Hide prices (presentation)'}</div>
      </div>
    </div>
    ${Store.presenting ? `<div class="present-bar">
      <span>${eyeIcon(true)} <b>Presentation mode</b> — your prices are hidden, so you can show frames to customers.</span>
      <button data-present-exit>Show my prices</button></div>` : ''}
    <main class="page"></main>
    <a class="hm-wa shell-wa" target="_blank" rel="noopener" title="Chat with us on WhatsApp"
       href="${WHATSAPP}?text=${encodeURIComponent(`Hi, it's ${u.business || u.email}${u.customerNumber ? ` (customer #${u.customerNumber})` : ''}`)}">${waIcon()}</a>
    <nav class="bottomnav">${BOTTOM_NAV.map(n => `
      <a href="${n.hash}" class="${(n.hash === '#/' ? activeHash === '#/' : activeHash.startsWith(n.hash)) ? 'active' : ''}">
        ${NAVICON[n.icon]}${n.badge ? `<span class="badge" id="cartBadgeM" style="${Store.cartCount ? '' : 'display:none'}">${Store.cartCount}</span>` : ''}
        <span>${n.label}</span></a>`).join('')}
    </nav>
  </div>`);
  el.querySelector('[data-present]').onclick = () => setPresenting(!Store.presenting);
  const exitBtn = el.querySelector('[data-present-exit]');
  if (exitBtn) exitBtn.onclick = () => setPresenting(false);
  const back = el.querySelector('.drawer-back');
  el.querySelector('.burger').onclick = () => back.classList.add('open');
  back.addEventListener('click', e => { if (e.target === back) back.classList.remove('open'); });
  el.querySelector('[data-present-drawer]').onclick = () => setPresenting(!Store.presenting);
  el.querySelector('main').appendChild(contentEl);
  return el;
}

function setCartBadge(count) {
  Store.cartCount = count;
  for (const id of ['cartBadge', 'cartBadgeM', 'cartBadgeT']) {
    const b = document.getElementById(id);
    if (b) { b.textContent = count; b.style.display = count ? '' : 'none'; }
  }
}

async function refreshCartBadge() {
  try {
    const cart = await API.get('/user/get-cart');
    setCartBadge(cart.totalQty || 0);
  } catch { /* not logged in */ }
}

async function restoreSession() {
  if (Store.session) return true;
  try {
    const me = await API.get('/user/get-user-detail', { noRedirect: true });
    Store.session = { user: me.user };
    Store.realHide = !!me.user.hidePrices;
    applyPricingMode();
    refreshCartBadge();
    return true;
  } catch { return false; }
}

async function route() {
  // Navigating away closes any open overlay (product modal, lightbox)
  document.querySelectorAll('.modal-back, .lightbox').forEach(el => el.remove());
  const app = document.getElementById('app');
  const hash = location.hash || '#/';
  const key = '#/' + (hash.replace(/^#\//, '').split('/')[0] || '');
  const args = hash.replace(/^#\//, '').split('/').slice(1).map(decodeURIComponent);
  const page = Routes[key] || Routes['#/'];

  if (page.public || page.optional) {
    await restoreSession();               // nice-to-have; render either way
  } else if (!(await restoreSession())) {
    sessionStorage.setItem('veyora_after_login', hash);
    location.hash = '#/login';
    return;
  }

  document.body.classList.toggle('hm-dark', key === '#/' || key === '#/home');
  app.innerHTML = '';
  const content = document.createElement('div');
  if (page.public || (page.optional && !Store.session)) {
    app.appendChild(content);
  } else {
    app.appendChild(shell(content, key));
    // keep the active tab visible when the nav scrolls sideways on mobile
    const nav = app.querySelector('.nav'), act = nav?.querySelector('a.active');
    if (nav && act) nav.scrollLeft = act.offsetLeft - (nav.clientWidth - act.offsetWidth) / 2;
  }
  document.title = (page.title ? page.title + ' — ' : '') + 'Veyora';
  try {
    await page.render(content, args);
  } catch (e) {
    if (e.status !== 401) {
      content.innerHTML = `<div class="empty"><div class="big">⚠️</div>${esc(e.message || 'Something went wrong')}</div>`;
    }
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
