/* Orders, order detail, backorders, returns. */
'use strict';

Routes['#/orders'] = {
  title: 'Orders',
  async render(el) {
    el.innerHTML = `<h1 class="pagetitle">Your orders</h1><div class="card" id="box"><div class="pad">Loading…</div></div>`;
    let page = 1;
    const box = el.querySelector('#box');
    async function load() {
      const res = await API.get(`/user/get-user-orders?page=${page}&perPage=20`);
      if (!res.orders.length && page === 1) {
        box.innerHTML = `<div class="empty"><div class="big">📦</div>No orders yet</div>`;
        return;
      }
      const hide = Store.session.user.hidePrices;
      const isAgent = ['agent', 'super-agent'].includes(Store.session.user.role);
      box.innerHTML = `
        <div style="overflow-x:auto"><table class="list">
          <thead><tr><th>Order</th><th>Date</th>${isAgent ? '<th>Customer</th>' : ''}<th>Items</th>${hide ? '' : '<th>Total</th>'}<th>Status</th><th>Tracking</th></tr></thead>
          <tbody>${res.orders.map(o => `
            <tr class="click" data-id="${esc(o.id)}">
              <td><b>${esc(o.number)}</b></td>
              <td>${fmtDate(o.date)}</td>
              ${isAgent ? `<td>${esc(o.customerBusiness || '')}</td>` : ''}
              <td>${o.itemCount}</td>
              ${hide ? '' : `<td>${money(o.total)}</td>`}
              <td>${pill(o.status)}</td>
              <td class="sub">${o.tracking ? esc(o.tracking.company || '') + ' ' + esc(o.tracking.number || '') : '—'}</td>
            </tr>`).join('')}
          </tbody></table></div>
        <div class="pager">
          <button ${page <= 1 ? 'disabled' : ''} data-d="-1">‹ Prev</button>
          <span class="sub">Page ${page}</span>
          <button ${page * 20 >= res.total ? 'disabled' : ''} data-d="1">Next ›</button>
        </div>`;
      box.querySelectorAll('tr.click').forEach(tr =>
        tr.onclick = () => location.hash = '#/order/' + tr.dataset.id);
      box.querySelectorAll('.pager button').forEach(b =>
        b.onclick = () => { page += parseInt(b.dataset.d, 10); load(); });
    }
    await load();
  },
};

Routes['#/order'] = {
  title: 'Order',
  async render(el, [id]) {
    const { order: o } = await API.get('/user/get-order-detail/' + encodeURIComponent(id));
    const hide = Store.session.user.hidePrices;
    el.innerHTML = `
      <h1 class="pagetitle">Order ${esc(o.number)} ${pill(o.status)}</h1>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
        <div class="card" style="flex:2;min-width:300px"><div class="pad">
          <table class="list"><thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Shipped</th>${hide ? '' : '<th>Price</th><th>Total</th>'}</tr></thead>
          <tbody>${o.items.map(i => `
            <tr><td><b>${esc(i.sku)}</b></td><td>${esc(i.name)}${i.color ? ' · ' + esc(i.color) : ''}</td>
            <td>${i.qty}</td><td>${i.collected}</td>
            ${hide ? '' : `<td>${money(i.price)}</td><td>${money(i.qty * i.price)}</td>`}</tr>`).join('')}
          </tbody></table>
        </div></div>
        <div class="card" style="flex:1;min-width:250px"><div class="pad">
          <div class="summary-row"><span>Date</span><b>${fmtDate(o.date)}</b></div>
          ${hide ? '' : `
            ${Number(o.discount) ? `<div class="summary-row"><span>Discount</span><b>−${money(o.discount)}</b></div>` : ''}
            <div class="summary-row"><span>Shipping</span><b>${o.freeShipping ? 'Free' : money(o.shipping)}</b></div>
            <div class="summary-row total"><span>Total</span><span>${money(o.total)}</span></div>`}
          ${o.tracking ? `<div class="summary-row"><span>Tracking</span><b>${esc(o.tracking.company || '')} ${esc(o.tracking.number || '')}</b></div>` : ''}
          <button class="btn ghost" style="width:100%;margin-top:14px" id="repeatBtn">↺ Repeat this order</button>
        </div></div>
      </div>`;
    el.querySelector('#repeatBtn').onclick = async () => {
      const cart = await API.post('/user/repeat-order', { orderId: o.id });
      setCartBadge(cart.totalQty);
      toast('Items added to cart');
      location.hash = '#/cart';
    };
  },
};

Routes['#/backorders'] = {
  title: 'Backorders',
  async render(el) {
    el.innerHTML = `<h1 class="pagetitle">Backorders</h1>
      <p class="sub" style="margin:-8px 0 14px">Items that were out of stock when you ordered. Approve a backorder to receive it automatically when stock arrives.</p>
      <div id="box"></div>`;
    const box = el.querySelector('#box');
    async function load() {
      const res = await API.get('/user/backorders');
      if (!res.backorders.length) {
        box.innerHTML = `<div class="card"><div class="empty"><div class="big">🎉</div>No backorders</div></div>`;
        return;
      }
      const hide = Store.session.user.hidePrices;
      box.innerHTML = res.backorders.map(b => `
        <div class="card" style="margin-bottom:12px"><div class="pad">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div><b>${esc(b.number)}</b> ${pill(b.status)}
              <span class="sub">· from order ${esc(b.orderNumber || '—')} · ${fmtDate(b.createdAt)}</span></div>
            <div>
              ${b.status === 'open' ? `<button class="btn sm" data-ap="${esc(b.id)}">Approve</button>` : ''}
              ${['open', 'approved'].includes(b.status) ? `<button class="btn ghost sm" data-ca="${esc(b.id)}">Cancel</button>` : ''}
            </div>
          </div>
          <table class="list" style="margin-top:8px"><tbody>
            ${b.items.map(i => `<tr><td><b>${esc(i.sku)}</b></td><td>${esc(i.name)}${i.color ? ' · ' + esc(i.color) : ''}</td>
              <td>× ${i.qty}</td>${hide ? '' : `<td>${money(i.price)}</td>`}</tr>`).join('')}
          </tbody></table>
        </div></div>`).join('');
      box.querySelectorAll('[data-ap]').forEach(btn => btn.onclick = async () => {
        await API.post(`/user/backorders/${btn.dataset.ap}/approve`);
        toast('Backorder approved'); load();
      });
      box.querySelectorAll('[data-ca]').forEach(btn => btn.onclick = async () => {
        if (!confirm('Cancel this backorder?')) return;
        await API.post(`/user/backorders/${btn.dataset.ca}/cancel`);
        toast('Backorder cancelled'); load();
      });
    }
    await load();
  },
};

Routes['#/returns'] = {
  title: 'Returns',
  async render(el, [sub]) {
    if (sub === 'create') return renderCreateReturn(el);
    el.innerHTML = `<h1 class="pagetitle" style="display:flex;justify-content:space-between;align-items:center">Returns
      <button class="btn sm" onclick="location.hash='#/returns/create'">+ New return</button></h1>
      <div id="box"></div>`;
    const res = await API.get('/user/returns');
    const box = el.querySelector('#box');
    if (!res.returns.length) {
      box.innerHTML = `<div class="card"><div class="empty"><div class="big">↩️</div>No returns</div></div>`;
      return;
    }
    box.innerHTML = res.returns.map(x => `
      <div class="card" style="margin-bottom:12px"><div class="pad">
        <div><b>${esc(x.number)}</b> ${pill(x.status)}
          <span class="sub">· ${x.orderNumber ? 'order ' + esc(x.orderNumber) + ' · ' : ''}${fmtDate(x.createdAt)}</span></div>
        <table class="list" style="margin-top:8px"><tbody>
          ${x.items.map(i => `<tr><td><b>${esc(i.sku)}</b></td><td>${esc(i.name)}</td>
            <td>× ${i.qty}</td><td class="sub">${esc(i.resolution)}</td></tr>`).join('')}
        </tbody></table>
        ${x.notes ? `<p class="sub" style="margin-top:6px">${esc(x.notes)}</p>` : ''}
      </div></div>`).join('');
  },
};

async function renderCreateReturn(el) {
  el.innerHTML = `<h1 class="pagetitle">New return</h1>
    <div class="card"><div class="pad">
      <div class="field"><label>Order number (optional)</label><input id="rOrder" placeholder="SO…"/></div>
      <div id="rItems"></div>
      <button class="btn ghost sm" id="addRow">+ Add item</button>
      <div class="field" style="margin-top:12px"><label>Notes</label><textarea id="rNotes" rows="2"></textarea></div>
      <button class="btn" id="submitR">Submit return</button>
    </div></div>`;
  const itemsBox = el.querySelector('#rItems');
  function addRow() {
    const row = h(`<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      <input placeholder="SKU (e.g. 20894.1)" style="flex:2;min-width:130px;padding:9px 11px;border:1px solid var(--line);border-radius:8px"/>
      <input type="number" min="1" value="1" style="width:70px;padding:9px 11px;border:1px solid var(--line);border-radius:8px"/>
      <select style="flex:1;min-width:110px;padding:9px 11px;border:1px solid var(--line);border-radius:8px">
        <option value="credit">Credit</option><option value="exchange">Exchange</option>
      </select>
      <button class="btn ghost sm" type="button">✕</button>
    </div>`);
    row.querySelector('button').onclick = () => row.remove();
    itemsBox.appendChild(row);
  }
  addRow();
  el.querySelector('#addRow').onclick = addRow;
  el.querySelector('#submitR').onclick = async () => {
    const items = [...itemsBox.children].map(row => {
      const [skuIn, qtyIn] = row.querySelectorAll('input');
      return { sku: skuIn.value.trim(), qty: parseInt(qtyIn.value, 10) || 1,
               resolution: row.querySelector('select').value };
    }).filter(i => i.sku);
    if (!items.length) { toast('Add at least one item', true); return; }
    try {
      const res = await API.post('/user/returns', {
        orderNumber: el.querySelector('#rOrder').value.trim() || null,
        notes: el.querySelector('#rNotes').value, items,
      });
      toast(`Return ${res.return.number} submitted`);
      location.hash = '#/returns';
    } catch (ex) { toast(ex.message, true); }
  };
}
