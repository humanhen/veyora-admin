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

/* ---------- salesperson "ordering for" context ----------
   Set from My Customers, shown as a banner, sent to the server as customerId
   at checkout and as ?forCustomer= on cart previews. The server is the
   authority: it re-checks role, ownership and active status every time. */

function canOrderForOthers() {
  return ['agent', 'super-agent', 'admin'].includes(Store.session?.user?.role);
}

/* "Show to customer" opens a price-free fullscreen card so a REP can turn the
   screen to a shopper. It is a salesperson demonstration action and makes no
   sense on a customer's own account — an optician looking at their own
   wholesale prices has no "customer" to show them to. Staff only.
   This is presentation only: it changes no permission and the server is
   unaffected either way. */
const PRESENT_TO_CUSTOMER_ROLES = ['agent', 'super-agent', 'admin'];
function canPresentToCustomer() {
  return PRESENT_TO_CUSTOMER_ROLES.includes(Store.session?.user?.role);
}
function actingFor() {
  return canOrderForOthers() ? Store.actingFor : null;   // never for a plain customer
}
function setActingFor(customer) {
  Store.actingFor = customer || null;
  // Switching or clearing the target must also drop their currency, otherwise
  // the next screen renders the actor's money with the previous customer's rate.
  Store.orderingFx = null;
  try {
    if (customer) sessionStorage.setItem('veyora_acting_for', JSON.stringify(customer));
    else sessionStorage.removeItem('veyora_acting_for');
  } catch { /* private mode */ }
}
/** Record the target customer's display currency from a priced server response. */
function noteOrderingFx(res) {
  if (Store.actingFor && res && res.fx) Store.orderingFx = res.fx;
  return res;
}

/* Hydrate the assisted-order currency BEFORE anything priced is rendered.

   setActingFor() clears Store.orderingFx (so a switch never keeps the previous
   customer's rate), and the catalogue response does not carry fx. Without this
   the first priced screen after selecting or restoring a customer formatted
   THEIR prices with the SALESPERSON's currency until something happened to
   fetch the cart. The router awaits this, so it cannot be skipped by going
   straight to the catalogue instead of the checkout.

   The endpoint is the authorised one — the server re-checks the actor's right
   to this customer, so a tampered sessionStorage value gets a 403 and the
   context is dropped rather than trusted. */
async function ensureOrderingContext() {
  const target = actingFor();
  if (!target) { Store.orderingFx = null; return null; }   // own currency
  if (Store.orderingFx) return Store.orderingFx;           // already hydrated
  try {
    const ctx = await API.get(
      '/user/checkout-context?forCustomer=' + encodeURIComponent(target.id),
      { noRedirect: true });
    if (ctx?.fx) Store.orderingFx = ctx.fx;
    // Refresh the label from the server's own view of the customer.
    if (ctx?.orderingFor) {
      Store.actingFor = { ...target, ...ctx.orderingFor };
      try { sessionStorage.setItem('veyora_acting_for', JSON.stringify(Store.actingFor)); }
      catch { /* private mode */ }
    }
    return Store.orderingFx;
  } catch (e) {
    /* A 400/403 is a DECISION: the actor may no longer use this customer
       (reassigned, deactivated, or a tampered sessionStorage value). Drop the
       context and carry on as the salesperson. */
    if (e.status === 403 || e.status === 400) {
      setActingFor(null);
      toast('You can no longer order for that customer — back to your own account', true);
      return null;
    }
    /* Anything else — a 5xx, a timeout, a dropped connection — says nothing
       about authorisation. Clearing the context here would silently switch the
       rep to their OWN prices mid-order, which is exactly the mistake this
       whole feature exists to prevent. Keep the customer selected and fail the
       render instead, so the user sees an error and can retry.
       (401 is not caught here: API.call handles the session redirect itself.) */
    console.error('[ordering] could not hydrate customer context:', e);
    throw Object.assign(
      new Error(`Couldn't load prices for ${target.business || 'this customer'}. `
        + 'Nothing was changed — please retry.'),
      { orderingContextUnavailable: true, cause: e });
  }
}
/** Append ?forCustomer=<id> when a customer context is active. */
function withOrderingContext(path) {
  const a = actingFor();
  if (!a) return path;
  return path + (path.includes('?') ? '&' : '?') + 'forCustomer=' + encodeURIComponent(a.id);
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
    ${actingFor() ? `<div class="acting-bar">
      <span>🧾 Ordering for: <b>${esc(actingFor().business || actingFor().id)}</b>${
        actingFor().customerNumber ? ` <span class="sub">(customer #${esc(actingFor().customerNumber)})</span>` : ''}
        — prices and promotions are theirs, and the order will be placed in their name.</span>
      <span class="acting-actions">
        <button data-acting-switch>Switch customer</button>
        <button data-acting-clear>Clear</button>
      </span></div>` : ''}
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
  const actClear = el.querySelector('[data-acting-clear]');
  if (actClear) actClear.onclick = () => {
    setActingFor(null);
    toast('Back to your own account');
    route();                       // re-price the current page as the actor
  };
  const actSwitch = el.querySelector('[data-acting-switch]');
  if (actSwitch) actSwitch.onclick = () => { location.hash = '#/customers'; };
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
    const cart = noteOrderingFx(await API.get(withOrderingContext('/user/get-cart')));
    setCartBadge(cart.totalQty || 0);
  } catch { /* not logged in */ }
}

/** Load the account's display currency + FX rate. Safe to fail → stays USD. */
async function loadFx() {
  try {
    const f = await API.get('/user/fx', { noRedirect: true });
    Store.fx = { currency: f.currency || 'USD', rate: Number(f.rate) || 1, symbol: f.symbol || '$' };
  } catch { /* keep the USD default */ }
}

async function restoreSession() {
  if (Store.session) return true;
  try {
    const me = await API.get('/user/get-user-detail', { noRedirect: true });
    Store.session = { user: me.user };
    if (me.features) Store.features = { ...Store.features, ...me.features };
    Store.realHide = !!me.user.hidePrices;
    applyPricingMode();
    // A stored ordering context only means anything for staff roles. If the
    // session is an ordinary customer, drop it rather than sending a
    // customerId the server will reject anyway.
    if (Store.actingFor && !canOrderForOthers()) setActingFor(null);
    await loadFx();
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

  /* Hydrate the assisted-order currency BEFORE the page renders anything
     priced. Every route goes through here, so no screen can be reached with
     the target's prices and the salesperson's currency. */
  let orderingContextError = null;
  if (Store.session) {
    try { await ensureOrderingContext(); }
    catch (e) {
      // Transient failure: the customer is still selected but we could not get
      // their prices. Render a failure state rather than the actor's prices.
      orderingContextError = e;
    }
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
  if (orderingContextError) {
    /* FAIL CLOSED. The customer is still selected — we simply could not reach
       their prices. Rendering the page now would quietly show the salesperson's
       own prices under a banner naming the customer. */
    content.innerHTML = `<div class="empty"><div class="big">⚠️</div>
      ${esc(orderingContextError.message)}
      <div style="margin-top:16px"><button class="btn" onclick="route()">Retry</button></div></div>`;
    window.scrollTo(0, 0);
    return;
  }
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
