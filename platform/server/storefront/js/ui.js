/* Small DOM helpers shared by all pages. */
'use strict';

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const CURRENCY_SYMBOLS = { USD: '$', CAD: 'CA$', EUR: '€' };

/** Normalise any {currency,rate,symbol} shape into one usable for display. */
function fxContext(src) {
  if (!src) return { currency: 'USD', rate: 1, symbol: '$' };
  const currency = String(src.currency || 'USD').toUpperCase();
  return {
    currency,
    rate: Number(src.rate ?? src.fxRate) || 1,
    symbol: src.symbol || CURRENCY_SYMBOLS[currency] || '$',
  };
}

/** The currency the CURRENT screen should be denominated in.
    While a salesperson is building an order for a customer, that is the
    customer's currency — not the salesperson's. Clearing the context restores
    the actor's own. Store.orderingFx is set from the server's cart/checkout
    response, so the client never guesses a rate. */
function effectiveFx() {
  if (typeof Store === 'undefined') return { currency: 'USD', rate: 1, symbol: '$' };
  if (Store.actingFor && Store.orderingFx) return fxContext(Store.orderingFx);
  return fxContext(Store.fx);
}

/**
 * Format a base-currency (USD) amount for display.
 * @param n   amount in the BASE currency, as stored
 * @param fx  optional explicit context — pass an order's own {currency, fxRate}
 *            so historical orders render in the money they were struck in
 *            rather than in whatever the current viewer happens to be set to.
 */
function money(n, fx) {
  if (n == null) return '—';
  const c = fx ? fxContext(fx) : effectiveFx();
  const v = Number(n) * c.rate;
  return c.symbol + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtDate(d) {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? String(d).slice(0, 10)
    : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function toast(msg, isErr) {
  const el = h(`<div class="toast${isErr ? ' err' : ''}">${esc(msg)}</div>`);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function pill(status) {
  return `<span class="pill ${esc(String(status).replace(/\s+/g, ''))}">${esc(status)}</span>`;
}
/** Whether customers may order beyond available stock (server-controlled). */
function backordersAllowed() {
  return typeof Store !== 'undefined' ? Store.features?.allowBackorders !== false : true;
}
function stockPill(v, opts = {}) {
  // Old-site behavior: availability only, never the quantity number.
  if (v.qty > 0) return `<span class="stockpill in">In Stock</span>`;
  if (v.stockStatus === 'in production') {
    return `<span class="stockpill prod">${opts.short ? 'Production' : 'In Production'}</span>`;
  }
  // Nothing on the shelf, but it can still be ordered — say so plainly rather
  // than showing a dead end.
  if (backordersAllowed()) {
    return `<span class="stockpill back">${opts.short ? 'Backorder' : 'Available to Backorder'}</span>`;
  }
  return `<span class="stockpill out">Out of Stock</span>`;
}
/** "Charlett · Model 2057 · SKU 2057.81" — the full product identity of a line.
    modelSku is the PRODUCT sku supplied by the API; never split the variation
    sku to guess it (dash colorways like VEDETTE-2002 would come out wrong). */
function identityLine(i) {
  const bits = [];
  if (i.brand) bits.push(esc(i.brand));
  if (i.modelSku) bits.push('Model ' + esc(i.modelSku));
  if (i.sku) bits.push('SKU ' + esc(i.sku));
  return bits.join(' · ');
}
/* Order-confirmation sentences. Kept here so the pluralisation is written once
   and can be asserted directly. Deliberately never claims a shipment: an
   allocated item has been taken from stock, and a backordered one is recorded
   for staff to process — neither has left the warehouse. */
function allocatedSentence(n) {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (!count) return '';
  return count === 1
    ? 'One item has been allocated from current stock.'
    : `${count} items have been allocated from current stock.`;
}
function backorderedSentence(n) {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (!count) return '';
  return count === 1
    ? 'One item has been placed on backorder.'
    : `${count} items have been placed on backorder.`;
}
/* Fully backordered request: the backorder number has already been stated, so
   this says what happened to the goods without repeating the reference or
   piling on "nothing is shipping yet" — "unavailable … placed on backorder"
   already carries that, and the following sentence explains the next step. */
function unavailableSentence(n) {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (!count) return '';
  return count === 1
    ? 'One item is currently unavailable and has been placed on backorder.'
    : `${count} items are currently unavailable and have been placed on backorder.`;
}

/** "3 available now · 2 backordered".
    Deliberately avoids "shipping" — an allocated quantity has been taken from
    stock, not dispatched, and a backordered one is recorded, not promised.
    Reads as a STATUS; the surrounding copy explains that staff process it. */
function stockSplitLabel(inStockQty, backorderQty) {
  if (!backorderQty) return '';
  return inStockQty
    ? `${inStockQty} available now · ${backorderQty} backordered`
    : `${backorderQty} backordered`;
}
function imgOr(src, cls) {
  return src
    ? `<img class="${cls || ''}" src="${esc(src)}" loading="lazy" onerror="this.outerHTML='<div class=noimg>∞</div>'"/>`
    : `<div class="noimg">∞</div>`;
}
function qtyBox(value, min, max) {
  // Visible .qtynum is what the user sees (perfectly centred). The input stays
  // for typing / form semantics but is visually overlaid and transparent.
  return `
    <div class="qtybox">
      <button type="button" data-q="-1" aria-label="Decrease">−</button>
      <span class="qtyfield">
        <span class="qtynum">${value}</span>
        <input type="text" inputmode="numeric" pattern="[0-9]*" value="${value}" min="${min ?? 0}" ${max != null ? `max="${max}"` : ''} aria-label="Quantity"/>
      </span>
      <button type="button" data-q="1" aria-label="Increase">+</button>
    </div>`;
}
/** wire +/- buttons inside a .qtybox; onChange(newVal, inputEl) */
function bindQtyBox(box, onChange) {
  const input = box.querySelector('input');
  const num = box.querySelector('.qtynum');
  const paint = v => {
    input.value = String(v);
    if (num) num.textContent = String(v);
  };
  const clamp = v => {
    const min = parseInt(input.min || '0', 10);
    let x = Math.max(min, parseInt(String(v).replace(/\D/g, ''), 10) || 0);
    const maxAttr = input.getAttribute('max');
    if (maxAttr != null && maxAttr !== '') x = Math.min(x, parseInt(maxAttr, 10));
    return x;
  };
  box.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      const next = clamp((parseInt(input.value, 10) || 0) + parseInt(b.dataset.q, 10));
      paint(next);
      onChange(next, input);
    };
  });
  input.addEventListener('input', () => {
    const cleaned = input.value.replace(/\D/g, '');
    input.value = cleaned;
    if (num) num.textContent = cleaned === '' ? '0' : cleaned;
  });
  input.onchange = () => {
    const next = clamp(input.value);
    paint(next);
    onChange(next, input);
  };
}
/**
 * A confirmation in the portal's own design.
 *
 * window.confirm() renders the BROWSER's dialog: it carries the page's URL,
 * cannot be styled, reads "localhost says" in development, and on a phone it
 * is a system sheet that looks nothing like the rest of the portal. It is also
 * the only remaining place the customer sees a control we did not design.
 *
 * The destructive action is the secondary button, and Cancel takes focus, so
 * the reflex Enter keypress does not confirm a deletion.
 */
function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const back = modal(`<h2>${esc(title)}</h2>
      <p class="sub" style="margin-top:8px;line-height:1.55">${esc(body)}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-no type="button">Cancel</button>
        <button class="btn${danger ? ' danger' : ''}" data-yes type="button">${esc(confirmLabel)}</button>
      </div>`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; back.remove(); resolve(v); };
    back.querySelector('[data-yes]').onclick = () => finish(true);
    back.querySelector('[data-no]').onclick = () => finish(false);
    back.querySelector('.close').onclick = () => finish(false);
    back.addEventListener('click', (e) => { if (e.target === back) finish(false); });
    back.querySelector('[data-no]').focus();
  });
}

function modal(innerHtml) {
  const back = h(`<div class="modal-back"><div class="modal">
    <button class="close" type="button" aria-label="Close">×</button>${innerHtml}</div></div>`);
  back.addEventListener('click', e => { if (e.target === back) back.remove(); });
  back.querySelector('.close').onclick = () => back.remove();
  document.body.appendChild(back);
  return back;
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Horizontal finger-swipe / mouse-drag on a gallery stage.
    onSwipe(+1|-1). Vertical scrolling stays native (touch-action: pan-y). */
function bindSwipe(el, onSwipe) {
  let x0 = null, y0 = null, swiped = false;
  el.style.touchAction = 'pan-y';
  el.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    x0 = e.clientX; y0 = e.clientY; swiped = false;
  });
  el.addEventListener('pointermove', e => {
    if (x0 == null || swiped) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      swiped = true;
      onSwipe(dx < 0 ? 1 : -1);
    }
  });
  const end = () => { x0 = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // a drag must not fire the element's click (open zoom / close overlay)
  el.addEventListener('click', e => {
    if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; }
  }, true);
  el.addEventListener('dragstart', e => e.preventDefault());
}

/* Fullscreen image gallery (arrows + dots + caption), like the old veyora.com. */
function imageLightbox(images, startIndex, title, colorFor) {
  if (!images || !images.length) return;
  let i = Math.max(0, Math.min(startIndex || 0, images.length - 1));
  const back = h(`<div class="lightbox">
    <div class="lb-card">
      <button class="lb-close" aria-label="Close">×</button>
      <div class="lb-stage">
        <img alt=""/>
        ${images.length > 1 ? `<button class="lb-nav prev" aria-label="Previous">‹</button>
        <button class="lb-nav next" aria-label="Next">›</button>` : ''}
        ${title ? `<span class="lb-title">${esc(title)}</span>` : ''}
      </div>
      <div class="lb-color"></div>
      ${images.length > 1 ? `<div class="lb-dots">${images.map((_, k) => `<span data-k="${k}"></span>`).join('')}</div>` : ''}
    </div>
  </div>`);
  const img = back.querySelector('img');
  const colorEl = back.querySelector('.lb-color');
  const dots = [...back.querySelectorAll('.lb-dots span')];
  function show(n) {
    i = (n + images.length) % images.length;
    img.src = images[i];
    if (colorFor) colorEl.textContent = colorFor(i) || '';
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
  }
  const prev = back.querySelector('.prev'), next = back.querySelector('.next');
  if (prev) prev.onclick = e => { e.stopPropagation(); show(i - 1); };
  if (next) next.onclick = e => { e.stopPropagation(); show(i + 1); };
  if (images.length > 1) bindSwipe(back.querySelector('.lb-stage'), d => show(i + d));
  dots.forEach(d => d.onclick = e => { e.stopPropagation(); show(parseInt(d.dataset.k, 10)); });
  back.querySelector('.lb-close').onclick = () => close();
  back.addEventListener('click', e => { if (e.target === back) close(); });
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'ArrowRight') show(i + 1);
  }
  function close() { document.removeEventListener('keydown', onKey); back.remove(); }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  show(i);
}
