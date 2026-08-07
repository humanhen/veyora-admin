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
        box.innerHTML = `<div class="empty"><div class="big">${emptyIcon('package')}</div>No orders yet</div>`;
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
              ${hide ? '' : `<td>${money(o.total, o)}</td>`}
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
          <table class="list"><thead><tr><th>Model</th><th>Item</th><th>Qty</th>
            <th><span class="desktop-only">Shipped</span><span class="mobile-only">Shp.</span></th>
            ${hide ? '' : '<th class="hide-m">Price</th><th>Total</th>'}</tr></thead>
          <tbody>${o.items.map(i => `
            <tr><td><b>${esc(i.modelSku || i.sku)}</b><br/><span class="sub">${esc(i.sku)}</span></td>
            <td>${esc(i.name)}${i.color ? ' · ' + esc(i.color) : ''}
              ${i.brand ? `<br/><span class="sub">${esc(i.brand)}</span>` : ''}</td>
            <td>${i.qty}</td><td>${i.collected}</td>
            ${hide ? '' : `<td class="hide-m">${money(i.price, o)}</td><td>${money(i.qty * i.price, o)}</td>`}</tr>`).join('')}
          </tbody></table>
        </div></div>
        <div class="card" style="flex:1;min-width:250px"><div class="pad">
          <div class="summary-row"><span>Date</span><b>${fmtDate(o.date)}</b></div>
          ${hide ? '' : `
            ${Number(o.discount) ? `<div class="summary-row"><span>Discount</span><b>−${money(o.discount, o)}</b></div>` : ''}
            <div class="summary-row"><span>Shipping</span><b>${o.freeShipping ? 'Free' : money(o.shipping, o)}</b></div>
            <div class="summary-row total"><span>Total</span><span>${money(o.total, o)}</span></div>`}
          ${o.tracking ? `<div class="summary-row"><span>Tracking</span><b>${esc(o.tracking.company || '')} ${esc(o.tracking.number || '')}</b></div>` : ''}
          <button class="btn ghost" style="width:100%;margin-top:14px" id="repeatBtn">${icon('repeat', { size: 15 })} Repeat this order</button>
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
      <p class="sub" style="margin:-8px 0 14px">Quantities that were not available when you ordered.
        They are recorded and our team will process them when stock becomes available —
        there is nothing you need to do. Cancel one at any time if you no longer want it.</p>
      <div id="box"></div>`;
    const box = el.querySelector('#box');
    async function load() {
      const res = await API.get('/user/backorders');
      if (!res.backorders.length) {
        box.innerHTML = `<div class="card"><div class="empty"><div class="big">${emptyIcon('checkCircle')}</div>No backorders</div></div>`;
        return;
      }
      const hide = Store.session.user.hidePrices;
      box.innerHTML = res.backorders.map(b => `
        <div class="card" style="margin-bottom:12px"><div class="pad">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div><b>${esc(b.number)}</b> ${pill(b.status)}
              ${['open', 'approved'].includes(b.status)
                ? `<span class="bo-state">On backorder</span>` : ''}
              <span class="sub">· ${b.orderNumber ? `from order ${esc(b.orderNumber)}` : 'Full backorder'} · ${fmtDate(b.createdAt)}</span></div>
            <div>
              ${['open', 'approved'].includes(b.status) ? `<button class="btn ghost sm" data-ca="${esc(b.id)}">Cancel</button>` : ''}
            </div>
          </div>
          <table class="list" style="margin-top:8px"><tbody>
            ${b.items.map(i => `<tr><td><b>${esc(i.modelSku || i.sku)}</b><br/><span class="sub">${esc(i.sku)}</span></td>
              <td>${esc(i.name)}${i.color ? ' · ' + esc(i.color) : ''}
                ${i.brand ? `<br/><span class="sub">${esc(i.brand)}</span>` : ''}</td>
              <td>× ${i.qty}</td>${hide ? '' : `<td>${money(i.price, b)}</td>`}</tr>`).join('')}
          </tbody></table>
        </div></div>`).join('');
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
      box.innerHTML = `<div class="card"><div class="empty"><div class="big">${emptyIcon('undo')}</div>No returns</div></div>`;
      return;
    }
    box.innerHTML = res.returns.map(x => `
      <div class="card" style="margin-bottom:12px"><div class="pad">
        <div><b>${esc(x.number)}</b> ${pill(x.status)}
          <span class="sub">· ${x.orderNumber ? 'order ' + esc(x.orderNumber) + ' · ' : ''}${fmtDate(x.createdAt)}</span></div>
        <table class="list" style="margin-top:8px"><tbody>
          ${x.items.map(i => `<tr><td><b>${esc(i.sku)}</b></td><td>${esc(i.name)}</td>
            <td>× ${i.qty}</td><td class="sub">${esc(i.resolution)}${i.exchangeSku
              ? ` → ${esc(i.exchangeSku)}` : ''}</td></tr>`).join('')}
        </tbody></table>
        ${x.notes ? `<p class="sub" style="margin-top:6px">${esc(x.notes)}</p>` : ''}
      </div></div>`).join('');
  },
};

/* ---------- New return (client feedback items B and C) ----------

   A return is now filed AGAINST AN ORDER. The customer picks one of their own
   delivered orders and then ticks lines from it, instead of typing a SKU and
   an order number into free-text boxes and hoping.

   That change is cosmetic on its own — the guarantee is on the server, where
   `buildReturn()` re-checks the order belongs to the caller, that every SKU is
   on it, that the quantity is within what remains un-returned, and where THE
   PRICE IS READ FROM THE ORDER LINE. This form cannot send a price at all.
   Everything below is convenience over that boundary, never a substitute. */

/** One debounced, keyboard-navigable exchange picker. */
function exchangePicker(onPick) {
  const box = h(`<div class="ex-pick">
    <input class="ex-input" type="text" role="combobox" aria-expanded="false"
      aria-autocomplete="list" aria-controls="" autocomplete="off"
      placeholder="Search by SKU, model or colour"/>
    <div class="ex-list" role="listbox" hidden></div>
    <input class="ex-sku" type="hidden"/>
  </div>`);
  const input = box.querySelector('.ex-input');
  const list = box.querySelector('.ex-list');
  const hidden = box.querySelector('.ex-sku');
  const listId = `exl-${Math.random().toString(36).slice(2, 9)}`;
  list.id = listId;
  input.setAttribute('aria-controls', listId);

  let results = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const paint = () => {
    if (!results.length) {
      list.innerHTML = `<div class="ex-empty">No frame matches that</div>`;
    } else {
      list.innerHTML = results.map((r, i) => `
        <div class="ex-opt${i === active ? ' on' : ''}" role="option" id="${listId}-${i}"
          aria-selected="${i === active}" data-i="${i}">
          <b>${esc(r.sku)}</b> <span class="sub">${esc(r.name)}${
            r.color ? ' · ' + esc(r.color) : ''}</span>
        </div>`).join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const choose = (i) => {
    const r = results[i];
    if (!r) return;
    hidden.value = r.sku;
    input.value = `${r.sku} — ${r.name}${r.color ? ' · ' + r.color : ''}`;
    close();
    onPick?.(r);
  };

  /* Debounced so typing a SKU is one request, not eight. The token guards
     against an earlier, slower response overwriting a later one. */
  let token = 0;
  const search = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 2) { results = []; close(); return; }
    const mine = ++token;
    try {
      const res = await API.get(`/user/exchange-search?q=${encodeURIComponent(term)}`);
      if (mine !== token) return;
      results = res.results || [];
      active = -1;
      paint();
    } catch { /* a failed suggestion is not worth interrupting the form for */ }
  }, 220);

  input.addEventListener('input', () => {
    /* Typing after a pick invalidates it: the hidden SKU is what gets sent, so
       it must never survive a change to the text the customer can see. */
    hidden.value = '';
    search();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden || !results.length) return;
      e.preventDefault();
      active = e.key === 'ArrowDown'
        ? (active + 1) % results.length
        : (active <= 0 ? results.length - 1 : active - 1);
      paint();
      return;
    }
    if (e.key === 'Enter' && !list.hidden && active >= 0) { e.preventDefault(); choose(active); return; }
    if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); close(); }
  });

  list.onclick = (e) => {
    const opt = e.target.closest('.ex-opt');
    if (opt) choose(Number(opt.dataset.i));
  };
  input.addEventListener('blur', () => setTimeout(close, 140));

  return { el: box, sku: () => hidden.value };
}

async function renderCreateReturn(el) {
  el.innerHTML = `<h1 class="pagetitle">New return</h1>
    <div class="card"><div class="pad" id="rWrap">Loading your orders…</div></div>`;
  const wrap = el.querySelector('#rWrap');

  let orders = [];
  try {
    orders = (await API.get('/user/returnable-orders')).orders || [];
  } catch (ex) {
    wrap.innerHTML = `<div class="empty">${esc(ex.message || 'Your orders could not be loaded.')}</div>`;
    return;
  }

  if (!orders.length) {
    wrap.innerHTML = `<div class="empty"><div class="big">${emptyIcon('package')}</div>
      There is nothing to return yet. A return is filed against an order that has
      already shipped, and you do not have one.</div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="field"><label for="rOrder">Which order?</label>
      <select class="select" id="rOrder">
        ${orders.map((o, i) => `<option value="${esc(o.number)}"${i === 0 ? ' selected' : ''}>${
          esc(o.number)} — ${esc(o.orderDate || '')}</option>`).join('')}
      </select></div>
    <div id="rLines"></div>
    <div class="field" style="margin-top:12px"><label for="rNotes">Notes (optional)</label>
      <textarea id="rNotes" rows="2"></textarea></div>
    <button class="btn" id="submitR">Submit return</button>`;

  const linesBox = wrap.querySelector('#rLines');
  const select = wrap.querySelector('#rOrder');
  /* One picker per line, kept so the SKU can be read back on submit. */
  let pickers = new Map();

  function paintLines() {
    const order = orders.find(o => o.number === select.value);
    pickers = new Map();
    if (!order || !order.lines.length) {
      linesBox.innerHTML = `<p class="sub">That order has no items to return.</p>`;
      return;
    }
    linesBox.innerHTML = `<table class="list ret-lines"><tbody>${order.lines.map(l => `
      <tr class="ret-line" data-sku="${esc(l.sku)}" data-max="${l.returnableQty}">
        <td style="width:34px">${l.returnableQty > 0
          ? `<input type="checkbox" class="r-on" aria-label="Return ${esc(l.sku)}"/>`
          : ''}</td>
        <td><b>${esc(l.sku)}</b><div class="sub">${esc(l.name)}${
          l.color ? ' · ' + esc(l.color) : ''}</div></td>
        <td class="sub" style="white-space:nowrap">${l.returnableQty > 0
          ? `${l.returnableQty} of ${l.qty} returnable`
          : `all ${l.qty} already returned`}</td>
        <td class="r-qty-cell"></td>
        <td class="r-res-cell"></td>
      </tr>`).join('')}</tbody></table>
      <div class="ret-ex-slots"></div>`;

    for (const row of linesBox.querySelectorAll('.ret-line')) {
      const max = Number(row.dataset.max) || 0;
      if (max <= 0) continue;
      const on = row.querySelector('.r-on');
      const qtyCell = row.querySelector('.r-qty-cell');
      const resCell = row.querySelector('.r-res-cell');

      /* Bounded by what the SERVER said remains returnable. The server checks
         it again regardless — this is so the customer is not invited to ask
         for something that will be refused. */
      qtyCell.innerHTML = qtyBox(1, 1, max);
      resCell.innerHTML = `<select class="r-res" aria-label="How to resolve ${esc(row.dataset.sku)}">
        <option value="credit">Credit</option><option value="exchange">Exchange</option></select>`;
      const qty = qtyCell.querySelector('.qtybox');
      bindQtyBox(qty, () => {});

      const picker = exchangePicker();
      const slot = h(`<div class="ret-ex" hidden><label class="sub">Exchange ${
        esc(row.dataset.sku)} for</label></div>`);
      slot.appendChild(picker.el);
      linesBox.querySelector('.ret-ex-slots').appendChild(slot);
      pickers.set(row.dataset.sku, picker);

      const res = resCell.querySelector('.r-res');
      const sync = () => {
        const wants = on.checked && res.value === 'exchange';
        slot.hidden = !wants;
      };
      res.onchange = sync;
      on.onchange = () => {
        qty.style.opacity = on.checked ? '' : '.45';
        sync();
      };
      qty.style.opacity = '.45';
    }
  }

  select.onchange = paintLines;
  paintLines();

  wrap.querySelector('#submitR').onclick = async () => {
    const items = [];
    for (const row of linesBox.querySelectorAll('.ret-line')) {
      const on = row.querySelector('.r-on');
      if (!on || !on.checked) continue;
      const resolution = row.querySelector('.r-res').value;
      const sku = row.dataset.sku;
      const item = {
        sku,
        qty: parseInt(row.querySelector('.qtybox input').value, 10) || 1,
        resolution,
      };
      if (resolution === 'exchange') {
        const chosen = pickers.get(sku)?.sku();
        if (!chosen) {
          toast(`Choose the frame you would like instead of ${sku}`, true);
          return;
        }
        item.exchangeSku = chosen;
      }
      items.push(item);
    }
    if (!items.length) { toast('Tick at least one item to return', true); return; }
    try {
      /* No price is sent. The server reads it from the order line. */
      const res = await API.post('/user/returns', {
        orderNumber: select.value,
        notes: wrap.querySelector('#rNotes').value,
        items,
      });
      toast(`Return ${res.return.number} submitted`);
      location.hash = '#/returns';
    } catch (ex) { toast(ex.message, true); }
  };
}
