/* Cart, checkout, thank-you. */
'use strict';

Routes['#/cart'] = {
  title: 'Cart',
  async render(el) {
    el.innerHTML = `<h1 class="pagetitle">Your cart</h1><div id="box"></div>`;
    const box = el.querySelector('#box');

    async function draw() {
      const cart = noteOrderingFx(await API.get(withOrderingContext('/user/get-cart')));
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
        ${cart.backorderQty ? `<div class="bo-banner">📦 <b>${cart.backorderQty} ${cart.backorderQty === 1 ? 'piece is' : 'pieces are'} not in stock.</b>
          ${cart.allowBackorders === false
            ? `Stock changed since you added them. Please reduce those lines to the quantity shown before checking out.`
            : `The available quantity becomes your order; the rest is recorded as a backorder for our team to process when stock arrives. Nothing is lost, and you'll be told which is which.`}</div>` : ''}
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
            <div class="nm">${esc(i.name || i.sku)}${i.color ? ` <span class="sub">· ${esc(i.color)}</span>` : ''}</div>
            <div class="meta">${identityLine(i)}</div>
            ${i.backorderQty ? `<div class="meta bo-split">${esc(stockSplitLabel(i.inStockQty, i.backorderQty))}</div>` : ''}
            <div class="meta"><a href="javascript:void 0" class="noteLink">${i.note ? '✎ ' + esc(i.note) : '+ add note'}</a></div>
          </div>
          ${qtyBox(i.qty, 0, cart.allowBackorders === false ? i.available : null)}
          ${hide ? '' : `<div class="lt">${money(i.lineTotal)}</div>`}
          <button class="icon-btn" style="color:var(--muted);font-size:16px" title="Remove">🗑</button>
        </div>`).join('');

      lines.querySelectorAll('.cart-line').forEach(line => {
        const sku = line.dataset.sku;
        bindQtyBox(line.querySelector('.qtybox'), debounce(async v => {
          try {
            await API.post('/user/add-to-cart', { sku, qty: v });
          } catch (ex) {
            // Backorders disabled and the shelf can't cover it — say so and
            // redraw so the line goes back to a quantity that is actually valid.
            toast(ex.message, true);
          }
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
    /* /user/checkout-context returns WHOEVER the order is for: their contact
       details, addresses, payment terms and currency. Without ?forCustomer it
       is the signed-in user; with it, the target customer (server-authorised).
       This is what stops an assisted order defaulting to the salesperson's own
       address, terms and country. */
    const [cart, ctx] = await Promise.all([
      noteOrderingFx(await API.get(withOrderingContext('/user/get-cart'))),
      API.get(withOrderingContext('/user/checkout-context')),
    ]);
    if (!cart.items.length) { location.hash = '#/cart'; return; }
    if (ctx.fx) { if (Store.actingFor) Store.orderingFx = ctx.fx; else Store.fx = ctx.fx; }
    const acting = ctx.orderingFor;              // null for a normal checkout
    const addr = ctx.addresses;
    const u = ctx.customer;                      // the ORDER's customer, not the actor
    // A rep must be able to read the customer's prices even if the customer's
    // own account hides them; a customer checking out keeps their preference.
    const hide = acting ? false : Store.session.user.hidePrices;

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
      ${acting ? `<div class="co-acting">
        <div><b>You are placing this order for ${esc(acting.business || '')}</b>${
          acting.customerNumber ? ` <span class="sub">(customer #${esc(acting.customerNumber)})</span>` : ''}</div>
        <div class="sub">The order will belong to them, be priced and charged in
          ${esc((ctx.fx && ctx.fx.currency) || 'USD')} on their terms (net ${u.paymentTerms || 30}),
          and the confirmation goes to ${esc(u.email || '')}. You stay recorded as the salesperson.</div>
      </div>` : ''}
      <form id="coForm" style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:2;min-width:300px">
          <div class="card"><div class="pad">
            <h3 style="font-size:15px;margin-bottom:12px">Shipping address${
              acting ? ` <span class="sub">— ${esc(acting.business || '')}</span>` : ''}</h3>
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
          ${cart.items.map(i => `<div class="co-line">
            <div class="co-line-main">
              <span class="co-nm">${esc(i.name || i.sku)}${i.color ? ` · ${esc(i.color)}` : ''}</span>
              ${hide ? '' : `<span class="co-amt">${money(i.lineTotal)}</span>`}
            </div>
            <div class="co-line-sub">${identityLine(i)} · Qty ${i.qty}</div>
            ${i.backorderQty ? `<div class="co-line-bo">${esc(stockSplitLabel(i.inStockQty, i.backorderQty))}</div>` : ''}
          </div>`).join('')}
          ${cart.backorderQty ? `<div class="co-line-bo" style="padding-top:8px">
            ${cart.inStockQty} available now · ${cart.backorderQty} recorded for staff processing</div>` : ''}
          ${hide ? '' : `
            <div class="summary-row" style="border-top:1px solid var(--line);margin-top:6px;padding-top:10px"><span>Subtotal</span><b>${money(cart.subtotal)}</b></div>
            ${cart.promotion?.discount ? `<div class="summary-row" style="color:var(--ok)"><span>Promotion</span><b>−${money(cart.promotion.discount)}</b></div>` : ''}
            <div class="summary-row"><span>Shipping</span><span class="sub">calculated at approval</span></div>
            <div class="summary-row total"><span>Total</span><span>${money(cart.total)}</span></div>`}
          <p class="sub" style="margin-top:10px">Payment on your usual terms (net ${u.paymentTerms || 30}).${
            cart.allowBackorders === false
              ? ' Orders are limited to stock on hand.'
              : ' Out-of-stock quantities become a backorder automatically.'}</p>
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
        /* Persist the address for next time — but ONLY when customers are
           checking out for themselves. On an assisted order this address
           belongs to the customer, and /user/save-shipping-address writes to
           the CALLER's address book, so saving here would file the customer's
           address under the salesperson. The address still travels with the
           order itself; assisted-order address persistence is out of scope for
           this release. */
        if (!acting) API.post('/user/save-shipping-address', shipping).catch(() => {});
        const res = await API.post('/user/place-order', {
          shippingAddress: shipping, billingAddress: billing, notes: f.notes.value,
          // Server-authoritative: it re-checks role, ownership and active status.
          customerId: actingFor()?.id || undefined,
        });
        setCartBadge(0);
        // The order is placed; the context has done its job. Clearing it here
        // stops the next cart silently belonging to the previous customer.
        setActingFor(null);
        sessionStorage.setItem('veyora_last_order', JSON.stringify(res));
        location.hash = '#/thank-you/' + (res.order ? res.order.id : 'backorder');
      } catch (ex) {
        /* The cart changed between pricing and submission (another tab, a
           second device, a slow click). Nothing was created and the cart is
           untouched — send the customer back to review the real cart rather
           than submitting quantities they never saw. */
        if (ex.status === 409 && ex.data?.cartChanged) {
          toast(ex.message, true);
          location.hash = '#/cart';
          return;
        }
        /* Already submitted: the first request won the lock and this one found
           the cart empty. Do NOT invite a retry — show them the order instead. */
        if (ex.status === 409 && ex.data?.alreadySubmitted) {
          toast('That order was already submitted.', true);
          location.hash = '#/orders';
          return;
        }
        // 409 = backorders are disabled and stock moved under us. Nothing was
        // created and the cart is intact, so name what is short and send the
        // customer back to adjust it.
        const short = ex.data?.shortages;
        if (ex.status === 409 && short?.length) {
          toast(`${ex.message} ${short.map(s =>
            `${s.sku}: ${s.available} of ${s.requested}`).join(', ')}`, true);
          location.hash = '#/cart';
          return;
        }
        toast(ex.message, true);
        f.querySelector('button[type=submit]').disabled = false;
      }
    };
  },
};

/* Confirmation. Three shapes, all of them a successful checkout:
   fully in stock · partly allocated (order + backorder) · fully backordered
   (a backorder and no order at all). The wording must never imply that
   backordered pieces are shipping. */
Routes['#/thank-you'] = {
  title: 'Order received',
  render(el) {
    let res = null;
    try { res = JSON.parse(sessionStorage.getItem('veyora_last_order') || 'null'); } catch {}
    const order = res?.order, bo = res?.backorder;
    // Hide-prices accounts see quantities and references, never money — the
    // same rule the confirmation email applies.
    const hide = Store.session?.user?.hidePrices;
    const v = res?.values;
    const boLines = (bo?.items || []).map(i =>
      `<div class="ty-line">${esc(i.name || i.sku)}${i.color ? ' · ' + esc(i.color) : ''}
        <span class="sub">${identityLine(i)} · ${i.qty} pcs</span></div>`).join('');
    // Requested / allocated / backordered, kept distinct and correctly labelled.
    const valueRows = (!hide && v && res.backorderedQty) ? `
      <div class="ty-values">
        <div><span>Allocated value</span><b>${money(v.allocatedValue, v)}</b></div>
        <div><span>Backordered value</span><b>${money(v.backorderedValue, v)}</b></div>
        <div><span>Full requested value</span><b>${money(v.requestedValue, v)}</b></div>
      </div>` : '';

    el.innerHTML = `<div class="card"><div class="empty">
      <div class="big">${order ? '✅' : '📦'}</div>
      <h2 style="margin-bottom:8px">Thank you!</h2>
      ${res?.placedForCustomer ? `<p class="sub">Placed for <b>${esc(res.placedForCustomer.business || '')}</b>.</p>` : ''}
      ${order ? `<p>Your order <b>${esc(order.number)}</b> was received${
        (!hide && order.total != null) ? ` — order total <b>${money(order.total, order)}</b>` : ''}.
        ${res.allocatedQty ? `<b>${res.allocatedQty} ${
          res.allocatedQty === 1 ? 'piece is' : 'pieces are'} available now</b> and
          allocated from current stock.` : ''}</p>` : ''}
      ${!order && bo ? `<p>None of these pieces are available right now, so
        <b>nothing is shipping yet</b> — your full request is recorded as
        backorder <b>${esc(bo.number)}</b> for our team to process when stock
        becomes available.</p>` : ''}
      ${order && bo ? `<p style="margin-top:6px">${res.backorderedQty} ${
        res.backorderedQty === 1 ? 'piece was' : 'pieces were'} not available and
        <b>is not part of the allocated quantities above</b>. It is recorded on
        backorder <b>${esc(bo.number)}</b> for our team to process when stock
        becomes available.</p>` : ''}
      ${boLines ? `<div class="ty-bo">${boLines}</div>` : ''}
      ${valueRows}
      <p class="sub" style="margin-top:10px">A confirmation email is on its way.</p>
      <div style="margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        ${order ? `<button class="btn ghost" onclick="location.hash='#/order/${esc(order.id)}'">View order</button>` : ''}
        ${bo ? `<button class="btn ghost" onclick="location.hash='#/backorders'">View backorder</button>` : ''}
        <button class="btn" onclick="location.hash='#/products'">Continue shopping</button>
      </div>
    </div></div>`;
  },
};
