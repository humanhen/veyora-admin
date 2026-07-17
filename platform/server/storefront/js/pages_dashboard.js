/* Customer dashboard — the page after login, rebuilt from the old
   veyora.com /dashboard index (stat tiles, time-to-reorder, shortcuts).
   Same content and wording as the old site, in the new panel style. */
'use strict';

const DASH_PERIODS = [
  ['month', 'This month'], ['90d', 'Last 90 days'], ['ytd', 'Year to date'],
];

function daysBetween(a, b) { return Math.round((b - a) / 864e5); }

function periodStart(key) {
  const now = new Date();
  if (key === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (key === '90d') return new Date(now.getTime() - 90 * 864e5);
  return new Date(now.getFullYear(), 0, 1);   // ytd
}

Routes['#/dashboard'] = {
  title: 'Dashboard',
  async render(el) {
    const hide = Store.session.user.hidePrices;
    const tile = (cls, go, icon, inner) => `
      <div class="dtile ${cls}" data-go="${go}">
        <div class="chip">${icon}</div><div class="tx">${inner}</div>
      </div>`;
    const I = {
      bag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h12l1 14H5L6 7z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/></svg>`,
      cart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.6 12h10.2L20 8H6"/></svg>`,
      dollar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 2v20M16.5 6.5c-.9-1.2-2.5-2-4.5-2-2.6 0-4.5 1.4-4.5 3.5 0 4.4 9 2.7 9 7 0 2.1-1.9 3.5-4.5 3.5-2 0-3.6-.8-4.5-2"/></svg>`,
      clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
      undo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>`,
    };
    el.innerHTML = `
      <div class="card welcome-card"><div class="pad">
        <h1>Welcome back${Store.session.user.firstName ? ', ' + esc(Store.session.user.firstName) : ''}.</h1>
        <p class="sub">Manage your orders, account, and explore our latest products.</p>
        <div class="dash-links">
          <a href="#/account">My Account</a>
          <a href="#/cart">Cart</a>
          <a href="#/returns">Report a defect</a>
        </div>
      </div></div>
      <div class="dash-tiles">
        ${tile('t-orders', '#/orders', I.bag, `
          <select id="dPeriod" onclick="event.stopPropagation()">
            ${DASH_PERIODS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}
          </select>
          <b id="dOrders">–</b><span>Total Orders</span><i class="sub" id="dOrdersSub"></i>`)}
        ${tile('t-cart', '#/cart', I.cart, `<b id="dCart">–</b><span>Items in Cart</span>`)}
        ${hide ? '' : tile('t-ctot', '#/cart', I.dollar, `<b id="dCartTot">–</b><span>Cart Total</span>`)}
        ${tile('t-back', '#/backorders', I.clock, `<b id="dBack">–</b><span>Backorders open</span><i class="sub" id="dBackSub"></i>`)}
        ${tile('t-ret', '#/returns', I.undo, `<b id="dRet">–</b><span>Returns open</span>`)}
      </div>

      <div class="card" style="margin-top:16px"><div class="pad">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
          <div>
            <h3 style="font-size:15px">↻ Time to reorder</h3>
            <p class="sub">SKUs you regularly order — ranked by how overdue they are.</p>
          </div>
          <a href="#/products" class="sub" style="font-weight:600">Browse all →</a>
        </div>
        <div id="dReorder" style="margin-top:10px"><div class="skeleton" style="height:64px"></div></div>
      </div></div>`;

    el.querySelectorAll('.dtile').forEach(t =>
      t.onclick = () => { location.hash = t.dataset.go; });

    // ---- tiles (all four sources load in parallel) ----
    const [orders, cart, back, rets] = await Promise.all([
      API.get('/user/get-user-orders?page=1&perPage=200').catch(() => ({ orders: [] })),
      API.get('/user/get-cart').catch(() => ({ items: [], totalQty: 0, total: 0 })),
      API.get('/user/backorders').catch(() => ({ backorders: [] })),
      API.get('/user/returns').catch(() => ({ returns: [] })),
    ]);

    function paintOrders() {
      const from = periodStart(el.querySelector('#dPeriod').value);
      const inRange = orders.orders.filter(o => new Date(o.date) >= from);
      el.querySelector('#dOrders').textContent = inRange.length;
      el.querySelector('#dOrdersSub').textContent =
        hide ? '' : money(inRange.reduce((s, o) => s + (Number(o.total) || 0), 0));
    }
    paintOrders();
    el.querySelector('#dPeriod').onchange = paintOrders;

    el.querySelector('#dCart').textContent = cart.totalQty || 0;
    const ctot = el.querySelector('#dCartTot');
    if (ctot) ctot.textContent = money(cart.total || 0);

    const openBack = back.backorders.filter(b => ['open', 'approved'].includes(b.status));
    const approvable = back.backorders.filter(b => b.status === 'open').length;
    el.querySelector('#dBack').textContent = openBack.length;
    el.querySelector('#dBackSub').textContent =
      approvable ? `${approvable} ready to approve` : '';

    el.querySelector('#dRet').textContent =
      rets.returns.filter(x => x.status === 'open').length;

    // ---- time to reorder ----
    const res = await API.get('/user/replenishment').catch(() => ({ items: [] }));
    const box = el.querySelector('#dReorder');
    const today = Date.now();
    const items = res.items.map(i => {
      const last = new Date(i.lastOrdered).getTime();
      const cadence = i.times >= 2
        ? Math.max(7, Math.round(daysBetween(new Date(i.firstOrdered).getTime(), last) / (i.times - 1)))
        : null;
      const sinceLast = daysBetween(last, today);
      return { ...i, cadence, sinceLast,
               overdue: cadence ? sinceLast - cadence : null };
    }).sort((a, b) => (b.overdue ?? -9999) - (a.overdue ?? -9999)).slice(0, 8);

    if (!items.length) {
      box.innerHTML = `<div class="empty" style="padding:24px"><div class="big">📦</div>No purchase history yet</div>`;
      return;
    }
    box.innerHTML = items.map(i => `
      <div class="vrow" data-sku="${esc(i.sku)}">
        ${imgOr(i.image)}
        <span class="vsku">${esc(i.sku)}</span>
        <span class="vcol">${esc(i.name)}${i.color ? ' · ' + esc(i.color) : ''}<br/>
          <span class="sub">${i.cadence ? `Every ${i.cadence}d · ` : ''}last ordered ${i.sinceLast}d ago</span></span>
        ${i.overdue > 0 ? `<span class="stockpill prod">Overdue by ${i.overdue}d</span>` : ''}
        ${stockPill({ qty: i.available, stockStatus: 'in stock' })}
        <button class="btn sm reorder-one" ${i.available > 0 ? '' : 'disabled'}>Reorder</button>
      </div>`).join('');
    box.querySelectorAll('.reorder-one').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      const cart2 = await API.post('/user/add-to-cart', { sku: b.closest('.vrow').dataset.sku, qty: 1 });
      setCartBadge(cart2.totalQty);
      toast('Added to cart — adjust quantity there');
    });
  },
};
