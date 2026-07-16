/* Cart, checkout, thank-you. */
'use strict';

Routes['#/cart'] = {
  title: 'Cart',
  async render(el) {
    el.innerHTML = `<h1 class="pagetitle">Your cart</h1><div id="box"></div>`;
    const box = el.querySelector('#box');

    async function draw() {
      const cart = await API.get('/user/get-cart');
      setCartBadge(cart.totalQty);
      if (!cart.items.length) {
        box.innerHTML = `<div class="card"><div class="empty"><div class="big">🛒</div>
          Your cart is empty<br/><br/>
          <button class="btn" onclick="location.hash='#/products'">Browse products</button></div></div>`;
        return;
      }
      const hide = Store.session.user.hidePrices;
      box.innerHTML = `
        ${cart.promotion ? `<div class="promo-banner">🎁 ${esc(cart.promotion.name)} applied — you save ${money(cart.promotion.discount)}</div>` : ''}
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
          <div class="card" style="flex:2;min-width:300px"><div class="pad" id="lines"></div></div>
          <div class="card" style="flex:1;min-width:260px"><div class="pad">
            <h3 style="font-size:15px;margin-bottom:10px">Summary</h3>
            ${hide ? '' : `
              <div class="summary-row"><span>Subtotal (${cart.totalQty} pcs)</span><b>${money(cart.subtotal)}</b></div>
              ${cart.promotion?.discount ? `<div class="summary-row" style="color:var(--ok)"><span>Promotion</span><b>−${money(cart.promotion.discount)}</b></div>` : ''}
              <div class="summary-row total"><span>Total</span><span>${money(cart.total)}</span></div>`}
            <button class="btn" style="width:100%;margin-top:14px" id="checkoutBtn">Checkout</button>
            <button class="btn ghost" style="width:100%;margin-top:8px" id="saveDraft">Save as draft</button>
            <div id="drafts" style="margin-top:12px"></div>
          </div></div>
        </div>`;
      const lines = box.querySelector('#lines');
      lines.innerHTML = cart.items.map(i => `
        <div class="cart-line" data-sku="${esc(i.sku)}">
          ${imgOr(i.image)}
          <div class="info">
            <div class="nm">${esc(i.name || i.sku)}</div>
            <div class="meta">${esc(i.sku)}${i.color ? ' · ' + esc(i.color) : ''}
              ${i.available < i.qty ? ` · <span style="color:var(--warn)">not all in stock — the rest will backorder</span>` : ''}
            </div>
            <div class="meta"><a href="javascript:void 0" class="noteLink">${i.note ? '✎ ' + esc(i.note) : '+ add note'}</a></div>
          </div>
          ${qtyBox(i.qty, 0)}
          ${hide ? '' : `<div class="lt">${money(i.lineTotal)}</div>`}
          <button class="icon-btn" style="color:var(--muted);font-size:16px" title="Remove">🗑</button>
        </div>`).join('');

      lines.querySelectorAll('.cart-line').forEach(line => {
        const sku = line.dataset.sku;
        bindQtyBox(line.querySelector('.qtybox'), debounce(async v => {
          await API.post('/user/add-to-cart', { sku, qty: v });
          draw();
        }, 400));
        line.querySelector('[title="Remove"]').onclick = async () => {
          await API.post('/user/delete-cart-item', { sku });
          draw();
        };
        line.querySelector('.noteLink').onclick = async () => {
          const note = prompt('Note for this item:', '');
          if (note === null) return;
          await API.post('/user/cart-item-note', { sku, note });
          draw();
        };
      });

      box.querySelector('#checkoutBtn').onclick = () => location.hash = '#/checkout';
      box.querySelector('#saveDraft').onclick = async () => {
        const name = prompt('Draft name:', 'My draft');
        if (name === null) return;
        await API.post('/user/cart/drafts', { name });
        toast('Draft saved');
        drawDrafts();
      };
      drawDrafts();
    }

    async function drawDrafts() {
      const d = await API.get('/user/cart/drafts');
      const dbox = box.querySelector('#drafts');
      if (!dbox || !d.drafts.length) { if (dbox) dbox.innerHTML = ''; return; }
      dbox.innerHTML = `<h4 style="font-size:12.5px;color:var(--muted);margin-bottom:6px">Saved drafts</h4>` +
        d.drafts.map(x => `
          <div class="summary-row" style="align-items:center">
            <span>${esc(x.name)} <span class="sub">(${x.itemCount} pcs)</span></span>
            <span>
              <button class="btn ghost sm" data-load="${esc(x.id)}">Load</button>
              <button class="btn ghost sm" data-del="${esc(x.id)}">✕</button>
            </span>
          </div>`).join('');
      dbox.querySelectorAll('[data-load]').forEach(b => b.onclick = async () => {
        await API.post(`/user/cart/drafts/${b.dataset.load}/load`);
        toast('Draft loaded into cart');
        draw();
      });
      dbox.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        await API.del(`/user/cart/drafts/${b.dataset.del}`);
        drawDrafts();
      });
    }

    await draw();
  },
};

Routes['#/checkout'] = {
  title: 'Checkout',
  async render(el) {
    const [cart, addr, me] = await Promise.all([
      API.get('/user/get-cart'),
      API.get('/user/get-addresses'),
      API.get('/user/get-user-detail'),
    ]);
    if (!cart.items.length) { location.hash = '#/cart'; return; }
    const hide = Store.session.user.hidePrices;
    const u = me.user;

    function addrFields(prefix, saved) {
      const s = saved || {};
      return `
        <div class="grid2">
          <div class="field"><label>Contact name</label><input name="${prefix}_name" value="${esc(s.name || (u.firstName + ' ' + u.lastName).trim())}"/></div>
          <div class="field"><label>Business</label><input name="${prefix}_business" value="${esc(s.business || u.business)}"/></div>
          <div class="field"><label>Phone</label><input name="${prefix}_phone" value="${esc(s.phone || u.phone)}"/></div>
          <div class="field"><label>Street address</label><input name="${prefix}_address" value="${esc(s.address || u.address)}"/></div>
          <div class="field"><label>City</label><input name="${prefix}_city" value="${esc(s.city || u.city)}"/></div>
          <div class="field"><label>State / Province</label><input name="${prefix}_state" value="${esc(s.state || u.state)}"/></div>
          <div class="field"><label>ZIP / Postal code</label><input name="${prefix}_zip" value="${esc(s.zip || u.zip)}"/></div>
          <div class="field"><label>Country</label>
            <select name="${prefix}_country">
              <option value="US" ${(s.country || u.country) === 'US' ? 'selected' : ''}>United States</option>
              <option value="CA" ${(s.country || u.country) === 'CA' ? 'selected' : ''}>Canada</option>
            </select></div>
        </div>`;
    }

    el.innerHTML = `
      <h1 class="pagetitle">Checkout</h1>
      <form id="coForm" style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:2;min-width:300px">
          <div class="card"><div class="pad">
            <h3 style="font-size:15px;margin-bottom:12px">Shipping address</h3>
            ${addrFields('ship', addr.shipping[0])}
          </div></div>
          <div class="card" style="margin-top:14px"><div class="pad">
            <label style="display:flex;gap:8px;align-items:center;font-weight:600;font-size:13px">
              <input type="checkbox" id="sameAsShip" checked style="width:auto"/> Billing address same as shipping
            </label>
            <div id="billBox" style="display:none;margin-top:12px">${addrFields('bill', addr.billing[0])}</div>
          </div></div>
          <div class="card" style="margin-top:14px"><div class="pad">
            <div class="field"><label>Order notes (optional)</label><textarea name="notes" rows="2"></textarea></div>
          </div></div>
        </div>
        <div class="card" style="flex:1;min-width:260px"><div class="pad">
          <h3 style="font-size:15px;margin-bottom:10px">Order summary</h3>
          ${cart.items.map(i => `<div class="summary-row"><span>${esc(i.sku)} × ${i.qty}</span>${hide ? '' : `<span>${money(i.lineTotal)}</span>`}</div>`).join('')}
          ${hide ? '' : `
            <div class="summary-row" style="border-top:1px solid var(--line);margin-top:6px;padding-top:10px"><span>Subtotal</span><b>${money(cart.subtotal)}</b></div>
            ${cart.promotion?.discount ? `<div class="summary-row" style="color:var(--ok)"><span>Promotion</span><b>−${money(cart.promotion.discount)}</b></div>` : ''}
            <div class="summary-row"><span>Shipping</span><span class="sub">calculated at approval</span></div>
            <div class="summary-row total"><span>Total</span><span>${money(cart.total)}</span></div>`}
          <p class="sub" style="margin-top:10px">Payment on your usual terms (net ${u.paymentTerms || 30}). Out-of-stock quantities become a backorder automatically.</p>
          <button class="btn" style="width:100%;margin-top:12px" type="submit">Place order</button>
        </div>
      </form>`;

    el.querySelector('#sameAsShip').onchange = e => {
      el.querySelector('#billBox').style.display = e.target.checked ? 'none' : '';
    };

    el.querySelector('#coForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const collect = prefix => ({
        name: f[`${prefix}_name`].value, business: f[`${prefix}_business`].value,
        phone: f[`${prefix}_phone`].value, address: f[`${prefix}_address`].value,
        city: f[`${prefix}_city`].value, state: f[`${prefix}_state`].value,
        zip: f[`${prefix}_zip`].value, country: f[`${prefix}_country`].value,
      });
      const shipping = collect('ship');
      const billing = el.querySelector('#sameAsShip').checked ? shipping : collect('bill');
      f.querySelector('button[type=submit]').disabled = true;
      try {
        // persist addresses for next time
        API.post('/user/save-shipping-address', shipping).catch(() => {});
        const res = await API.post('/user/place-order', {
          shippingAddress: shipping, billingAddress: billing, notes: f.notes.value,
        });
        setCartBadge(0);
        sessionStorage.setItem('veyora_last_order', JSON.stringify(res));
        location.hash = '#/thank-you/' + (res.order ? res.order.id : 'backorder');
      } catch (ex) {
        toast(ex.message, true);
        f.querySelector('button[type=submit]').disabled = false;
      }
    };
  },
};

Routes['#/thank-you'] = {
  title: 'Order received',
  render(el) {
    let res = null;
    try { res = JSON.parse(sessionStorage.getItem('veyora_last_order') || 'null'); } catch {}
    const order = res?.order, bo = res?.backorder;
    el.innerHTML = `<div class="card"><div class="empty">
      <div class="big">✅</div>
      <h2 style="margin-bottom:8px">Thank you!</h2>
      ${order ? `<p>Your order <b>${esc(order.number)}</b> was received${order.total != null ? ` — total <b>${money(order.total)}</b>` : ''}.</p>` : ''}
      ${bo ? `<p style="margin-top:6px">Out-of-stock items were saved as backorder <b>${esc(bo.number)}</b> — we'll fulfill it when stock arrives.</p>` : ''}
      <p class="sub" style="margin-top:10px">A confirmation email is on its way.</p>
      <div style="margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        ${order ? `<button class="btn ghost" onclick="location.hash='#/order/${esc(order.id)}'">View order</button>` : ''}
        <button class="btn" onclick="location.hash='#/products'">Continue shopping</button>
      </div>
    </div></div>`;
  },
};
