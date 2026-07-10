/* Shell + hash router. Pages register themselves in Routes. */
'use strict';

const Routes = {};   // '#/products' -> {render(el, args), title, public}

const NAV = [
  { hash: '#/products',    label: 'Products' },
  { hash: '#/orders',      label: 'Orders' },
  { hash: '#/backorders',  label: 'Backorders' },
  { hash: '#/returns',     label: 'Returns' },
  { hash: '#/favourites',  label: 'Favourites' },
  { hash: '#/replenishment', label: 'Reorder' },
  { hash: '#/spare-parts', label: 'Spare Parts' },
  { hash: '#/customers',   label: 'My Customers', roles: ['agent', 'super-agent', 'admin'] },
  { hash: '#/account',     label: 'My Account' },
];

function navFor(user) {
  return NAV.filter(n => !n.roles || n.roles.includes(user.role));
}

function shell(contentEl, activeHash) {
  const u = Store.session.user;
  const el = h(`<div>
    <header class="topbar">
      <img class="logo" src="assets/logo-white.svg" alt="Veyora" style="width:126px;cursor:pointer" onclick="location.hash='#/products'"/>
      <div class="spacer"></div>
      <button class="icon-btn" title="Favourites" onclick="location.hash='#/favourites'">♡</button>
      <button class="icon-btn" title="Cart" onclick="location.hash='#/cart'">🛒<span class="badge" id="cartBadge" style="${Store.cartCount ? '' : 'display:none'}">${Store.cartCount}</span></button>
      <button class="icon-btn" title="My Account" onclick="location.hash='#/account'">👤</button>
    </header>
    <nav class="nav">${navFor(u).map(n =>
      `<a href="${n.hash}" class="${activeHash.startsWith(n.hash) ? 'active' : ''}">${n.label}</a>`).join('')}
    </nav>
    <main class="page"></main>
  </div>`);
  el.querySelector('main').appendChild(contentEl);
  return el;
}

function setCartBadge(count) {
  Store.cartCount = count;
  const b = document.getElementById('cartBadge');
  if (b) { b.textContent = count; b.style.display = count ? '' : 'none'; }
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
    refreshCartBadge();
    return true;
  } catch { return false; }
}

async function route() {
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
