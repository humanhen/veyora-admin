/* Browser findings from the release candidate, tested against the REAL
   storefront source.

   ui.js and pages_catalog.js are plain browser scripts, not modules, so they
   are loaded into a vm sandbox with the few globals they touch and the actual
   functions are CALLED. Nothing here is a re-implementation: if the shipped
   markup changes, these fail.

   The CSS is asserted as text against the real stylesheet, because the defect
   these cover was a layout overflow, not a logic bug. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const STOREFRONT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'storefront');
const readSf = p => fs.readFileSync(path.join(STOREFRONT, p), 'utf8');
const CSS = readSf('css/store.css');
/* Copy assertions must look at RENDERED text, not at the comments explaining
   why the copy is what it is — otherwise a comment saying "never claim an
   email was sent" trips the very check that forbids that claim. */
const copyOf = p => readSf(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** Load the real ui.js + pages_catalog.js with stub globals. */
function loadStorefront({ role = 'customer', allowBackorders = true } = {}) {
  const noop = () => {};
  const stubEl = () => ({
    innerHTML: '', style: {}, classList: { add: noop, remove: noop, toggle: noop },
    appendChild: noop, addEventListener: noop, querySelector: () => null,
    querySelectorAll: () => [], onclick: null, dataset: {},
  });
  const ctx = {
    console,
    Store: {
      session: { user: { role, hidePrices: false } },
      features: { allowBackorders },
      fx: { currency: 'USD', rate: 1, symbol: '$' },
      actingFor: null, orderingFx: null, cartCount: 0,
    },
    Routes: {},
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: {
      createElement: () => ({ innerHTML: '', content: { firstElementChild: stubEl() } }),
      getElementById: () => null,
      addEventListener: noop,
      body: stubEl(),
    },
    location: { hash: '' }, navigator: {}, setTimeout, clearTimeout,
    // pages_catalog.js references helpers that live in other page scripts
    homeHeader: () => '', whatsappFloat: () => '', scanListModal: noop,
    API: { get: () => Promise.resolve({}), post: () => Promise.resolve({}) },
    withOrderingContext: p => p, actingFor: () => null, noteOrderingFx: r => r,
    canPresentToCustomer: () => ['agent', 'super-agent', 'admin'].includes(role),
    setCartBadge: noop, toast: noop, route: noop, bindSwipe: noop,
    productGallery: () => ({ gallery: [], colorAt: () => '' }),
    customerFrameView: noop, imageLightbox: noop, modal: noop, fmtDate: () => '',
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSf('js/ui.js'), ctx, { filename: 'ui.js' });
  vm.runInContext(readSf('js/pages_catalog.js'), ctx, { filename: 'pages_catalog.js' });
  return ctx;
}

const OUT_OF_STOCK = { sku: '1844.9', color: 'Havana', qty: 0, price: 49, stockStatus: 'out of stock' };
const IN_STOCK = { sku: '1844.1', color: 'Black', qty: 44, price: 49, stockStatus: 'in stock' };

/* ============ TASK 1 — out-of-stock variations must be orderable ============ */

test('the shipped helper renders a QUANTITY BOX for a zero-stock variation', () => {
  const sf = loadStorefront({ allowBackorders: true });
  const html = sf.variationOrderControls(OUT_OF_STOCK);
  assert.match(html, /class="qtybox"/, 'the customer must be able to choose a quantity');
  /* A numeric entry field. `type="text"` with `inputmode="numeric"` is
     deliberate rather than `type="number"`: it raises the numeric keypad on a
     phone without the spinner, and a stray scroll wheel cannot silently change
     an order quantity. The cap is enforced in `bindQtyBox`'s clamp(), which
     reads the max attribute itself, so it does not depend on the input type. */
  assert.match(html, /<input[^>]*inputmode="numeric"/);
  assert.match(html, /<input[^>]*pattern="\[0-9\]\*"/);
  assert.equal((html.match(/data-q="-1"/g) || []).length, 1, 'minus button');
  assert.equal((html.match(/data-q="1"/g) || []).length, 1, 'plus button');
});

test('the quantity box for a backordered row is UNCAPPED', () => {
  const sf = loadStorefront({ allowBackorders: true });
  const html = sf.variationOrderControls(OUT_OF_STOCK);
  assert.ok(!/\bmax="/.test(html),
    'a backorder is not limited by stock that does not exist');
});

test('"Notify me" remains, but as a SECONDARY action beside the quantity box', () => {
  const sf = loadStorefront({ allowBackorders: true });
  const html = sf.variationOrderControls(OUT_OF_STOCK);
  assert.match(html, /class="btn ghost sm notify"/);
  assert.ok(html.indexOf('qtybox') < html.indexOf('notify'),
    'the quantity control comes first — it must not be replaced by Notify me');
});

test('the row is labelled "Available to backorder"', () => {
  const sf = loadStorefront({ allowBackorders: true });
  assert.equal(sf.stockPill(OUT_OF_STOCK),
    '<span class="stockpill back">Available to backorder</span>');
});

test('an in-stock row is unchanged: quantity box, no Notify me', () => {
  const sf = loadStorefront({ allowBackorders: true });
  const html = sf.variationOrderControls(IN_STOCK);
  assert.match(html, /class="qtybox"/);
  assert.ok(!/notify/.test(html), 'nothing to notify about — it is in stock');
});

test('backorders DISABLED: a zero-stock row gets no quantity box at all', () => {
  const sf = loadStorefront({ allowBackorders: false });
  const html = sf.variationOrderControls(OUT_OF_STOCK);
  assert.ok(!/qtybox/.test(html), 'it must not be addable');
  assert.match(html, /notify/, 'notification-only behaviour is preserved');
  assert.equal(sf.stockPill(OUT_OF_STOCK),
    '<span class="stockpill out">out of stock</span>');
});

test('backorders DISABLED: an in-stock row is capped at what exists', () => {
  const sf = loadStorefront({ allowBackorders: false });
  assert.match(sf.variationOrderControls(IN_STOCK), /max="44"/);
});

test('the product card CTA and the modal agree for a zero-stock frame', () => {
  const sf = loadStorefront({ allowBackorders: true });
  const cta = sf.orderButton({ qty: 0, price: 49 }, false);
  assert.match(cta, /Backorder/, 'card offers a backorder…');
  assert.ok(!/disabled/.test(cta), '…and is not a dead button');
  assert.match(sf.variationOrderControls(OUT_OF_STOCK), /qtybox/,
    '…and the modal actually lets them choose a quantity');
});

test('the CTA is disabled only when backorders are off', () => {
  const off = loadStorefront({ allowBackorders: false });
  assert.match(off.orderButton({ qty: 0, price: 49 }, false), /disabled/);
});

/* ---- selection is preserved: mixed carts, and Notify me must not clear it ---- */

/** Reproduces the modal's chosen-quantity bookkeeping over the real qtyBox. */
function selectionHarness(sf) {
  const chosen = new Map();
  return {
    chosen,
    setQty(sku, qty) { if (qty > 0) chosen.set(sku, qty); else chosen.delete(sku); },
    // the notify handler only toggles the button's own state
    pressNotify() { /* deliberately touches nothing in `chosen` */ },
    payload() { return [...chosen].map(([sku, qty]) => ({ sku, qty })); },
  };
}

test('a zero-stock variation is included in the add-to-cart payload', () => {
  const sf = loadStorefront({ allowBackorders: true });
  const h = selectionHarness(sf);
  h.setQty(OUT_OF_STOCK.sku, 2);
  assert.deepEqual(h.payload(), [{ sku: '1844.9', qty: 2 }]);
});

test('a MIXED selection keeps both the in-stock and the backordered line', () => {
  const sf = loadStorefront({ allowBackorders: true });
  const h = selectionHarness(sf);
  h.setQty(IN_STOCK.sku, 1);
  h.setQty(OUT_OF_STOCK.sku, 3);
  assert.deepEqual(h.payload(), [{ sku: '1844.1', qty: 1 }, { sku: '1844.9', qty: 3 }]);
});

test('pressing "Notify me" does not erase a selected backorder quantity', () => {
  const sf = loadStorefront({ allowBackorders: true });
  const h = selectionHarness(sf);
  h.setQty(OUT_OF_STOCK.sku, 2);
  h.pressNotify();
  assert.deepEqual(h.payload(), [{ sku: '1844.9', qty: 2 }],
    'notification is independent of the order selection');
});

/* ============ TASK 2 — the quantity control must not be clipped ============ */

test('.qtybox cannot be shrunk by flex — it has overflow:hidden', () => {
  const rule = CSS.match(/\n\.qtybox\{[^}]*\}/);
  assert.ok(rule, '.qtybox rule must exist');
  assert.match(rule[0], /flex:0 0 auto/,
    'without this, flex shrinks the box and overflow:hidden CLIPS the number and +');
  assert.match(rule[0], /overflow:hidden/, 'the clipping behaviour this guards against');
});

test('the qty box children are also fixed-size', () => {
  /* Matched against whitespace-flattened CSS: these rules are written across
     several lines, and an assertion that breaks on a reformat is an assertion
     nobody trusts. The number is now a `.qtyfield` holding an overlaid input
     rather than a bare `.qtybox input`, so that is the child to pin. */
  const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>])\s*/g, '$1');   // keep the spaces inside `0 0 auto`
  for (const sel of ['.qtybox button', '.qtyfield']) {
    assert.ok(flat.includes(sel + '{'), `${sel} rule must exist`);
    const rule = flat.slice(flat.indexOf(sel + '{'), flat.indexOf('}', flat.indexOf(sel + '{')));
    assert.match(rule, /flex:0 0 auto/,
      `${sel} must not shrink, or overflow:hidden clips the control`);
  }
});

test('the variation row WRAPS instead of squeezing', () => {
  const rule = CSS.match(/\n\.vrow\{[^}]*\}/);
  assert.match(rule[0], /flex-wrap:wrap/);
});

test('only the colour name yields space; everything else is fixed', () => {
  assert.match(CSS, /\.vrow \.vcol\{flex:1 1 80px/, 'the colour label absorbs the squeeze');
  for (const sel of ['img', '.vsku', '.vprice', '.stockpill', '.vactions']) {
    const re = new RegExp(`\\.vrow ${sel.replace('.', '\\.')}\\{flex:0 0 auto`);
    assert.match(CSS, re, `.vrow ${sel} must not shrink`);
  }
});

test('the actions travel together as one wrappable unit', () => {
  assert.match(CSS, /\.vrow \.vactions\{[^}]*display:flex/);
  const sf = loadStorefront({ allowBackorders: true });
  const html = sf.variationOrderControls(OUT_OF_STOCK);
  assert.match(html, /^<span class="vactions">/, 'markup and CSS agree');
  assert.match(html, /<\/span>$/);
});

test('on a phone the actions take their own full-width line', () => {
  const mobile = CSS.slice(CSS.indexOf('@media(max-width:760px)'));
  assert.match(mobile, /\.vrow \.vactions\{flex:1 0 100%/);
});

test('nothing important is hidden to make it fit', () => {
  const rows = CSS.match(/\.vrow [^{]*\{[^}]*\}/g) || [];
  for (const rule of rows) {
    assert.ok(!/display:none/.test(rule), `a .vrow rule hides content: ${rule}`);
  }
});

test('the row now fits the modal column budget', () => {
  // .modal 860 − padding 44 − .pdetail-img 340 − gap 24 − .pdetail-info pad 20
  const rowWidth = 860 - 44 - 340 - 24 - 20;                       // 432
  const line1 = 56 + 84 + 150 + 56 + 3 * 12;                        // img+sku+pill+price
  const actions = (34 + 46 + 34) + 8 + 88;                          // qtybox + gap + notify
  assert.ok(line1 <= rowWidth, 'line 1 fits');
  assert.ok(actions <= rowWidth, 'the actions unit fits on its own wrapped line');
});

/* ============ TASK 3 — "Show to customer" is staff-only ============ */

const modalSource = readSf('js/pages_catalog.js');

test('the "Show to customer" button is behind a role check', () => {
  assert.match(modalSource, /canPresentToCustomer\(\)\s*\n?\s*\?\s*`<button[^`]*custViewBtn/,
    'the button must be conditional, not always rendered');
});

test('only agent, super-agent and admin may present to a customer', () => {
  const appSource = readSf('js/app.js');
  const roles = appSource.match(/const PRESENT_TO_CUSTOMER_ROLES = \[([^\]]+)\]/);
  assert.ok(roles, 'the allowed roles must be declared explicitly');
  const list = roles[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
  assert.deepEqual(list.sort(), ['admin', 'agent', 'super-agent']);
  for (const denied of ['customer', 'special customer', 'guest', 'warehouse']) {
    assert.ok(!list.includes(denied), `${denied} must not see it`);
  }
});

test('each role gets the expected visibility', () => {
  for (const role of ['agent', 'super-agent', 'admin']) {
    assert.equal(loadStorefront({ role }).canPresentToCustomer(), true, role);
  }
  for (const role of ['customer', 'special customer', 'warehouse', 'guest', undefined]) {
    assert.equal(loadStorefront({ role }).canPresentToCustomer(), false, String(role));
  }
});

test('hiding the button changes no permission and no server call', () => {
  const appSource = readSf('js/app.js');
  assert.match(appSource, /canOrderForOthers\(\)/, 'assisted-order gate still exists');
  assert.ok(!/canPresentToCustomer/.test(readSf('js/pages_agent.js')),
    'presentation visibility is not entangled with assisted ordering');
});

/* ============ TASK 4 — confirmation wording ============ */

test('allocated wording pluralises correctly', () => {
  const sf = loadStorefront();
  assert.equal(sf.allocatedSentence(1), 'One item has been allocated from current stock.');
  assert.equal(sf.allocatedSentence(2), '2 items have been allocated from current stock.');
  assert.equal(sf.allocatedSentence(0), '');
});

test('backordered wording pluralises correctly', () => {
  const sf = loadStorefront();
  assert.equal(sf.backorderedSentence(1), 'One item has been placed on backorder.');
  assert.equal(sf.backorderedSentence(2), '2 items have been placed on backorder.');
  assert.equal(sf.backorderedSentence(0), '');
});

test('the wording never claims a shipment or automatic fulfilment', () => {
  const sf = loadStorefront();
  for (const s of [sf.allocatedSentence(1), sf.allocatedSentence(3),
                   sf.backorderedSentence(1), sf.backorderedSentence(3)]) {
    assert.ok(!/shipping now|preparing to ship|automatically/i.test(s), s);
  }
});

test('the confirmation page uses the shared sentences, not inline copy', () => {
  const cart = copyOf('js/pages_cart.js');
  assert.match(cart, /has been received\./);
  assert.match(cart, /Total: <b>\$\{money\(order\.total, order\)\}<\/b>/);
  assert.match(cart, /allocatedSentence\(res\.allocatedQty\)/);
  assert.match(cart, /backorderedSentence\(res\.backorderedQty\)/);
  assert.ok(!/piece is|pieces are|was received —/.test(cart),
    'the old awkward wording is gone');
});

/* ============ TASK 5 — no unconditional email promise ============ */

test('the confirmation page no longer promises an email', () => {
  const cart = copyOf('js/pages_cart.js');
  assert.ok(!/confirmation email is on its way/i.test(cart));
  assert.ok(!/email (has been|was) sent/i.test(cart),
    'delivery is post-commit and may fail — never claim it without confirmation');
  assert.match(cart, /You can view the order details below\./);
});

test('no storefront page claims an email was delivered', () => {
  for (const f of fs.readdirSync(path.join(STOREFRONT, 'js'))) {
    const src = copyOf(path.join('js', f));
    assert.ok(!/email is on its way/i.test(src), `${f} still promises an email`);
  }
});

/* ============ BATCH 1G — customer backorder copy ============ */

test('a fully backordered confirmation reads cleanly and states the reference once', () => {
  const cart = copyOf('js/pages_cart.js');
  assert.match(cart, /Your backorder <b>\$\{esc\(bo\.number\)\}<\/b> has been recorded\./);
  assert.match(cart, /unavailableSentence\(res\.backorderedQty\)/);
  assert.match(cart, /Our team will process it when stock becomes available\./);
  assert.ok(!/None of these items are available right now/.test(cart),
    'the old repetitive wording is gone');
});

test('the unavailable sentence pluralises correctly', () => {
  const sf = loadStorefront();
  assert.equal(sf.unavailableSentence(1),
    'One item is currently unavailable and has been placed on backorder.');
  assert.equal(sf.unavailableSentence(2),
    '2 items are currently unavailable and have been placed on backorder.');
  assert.equal(sf.unavailableSentence(0), '');
});

test('backorder copy never claims shipment or automatic fulfilment', () => {
  const sf = loadStorefront();
  for (const s of [sf.unavailableSentence(1), sf.unavailableSentence(3),
                   sf.backorderedSentence(1), sf.backorderedSentence(4)]) {
    assert.ok(!/shipping now|preparing to ship|will ship|automatically/i.test(s), s);
  }
});

test('a full backorder shows a single Backorder total, not "Allocated value $0.00"', () => {
  const cart = copyOf('js/pages_cart.js');
  assert.match(cart, /const fullyBackordered = !order && !!bo;/);
  assert.match(cart, /fullyBackordered \? `[\s\S]*?Backorder total/,
    'a fully backordered request gets one plain total');
  // the three-way breakdown survives for the case where it is informative
  assert.match(cart, /Allocated value/);
  assert.match(cart, /Full requested value/);
});

test('a MIXED order keeps the allocated / backordered / requested breakdown', () => {
  const cart = copyOf('js/pages_cart.js');
  const mixedBranch = cart.slice(cart.indexOf('fullyBackordered ?'));
  for (const label of ['Allocated value', 'Backordered value', 'Full requested value']) {
    assert.ok(mixedBranch.includes(label), `${label} must remain for a mixed order`);
  }
});

test('status labels read as a status, not as an internal workflow note', () => {
  const orders = copyOf('js/pages_orders.js');
  assert.match(orders, /<span class="bo-state">On backorder<\/span>/);
  assert.ok(!/Recorded for staff processing/.test(orders));
  const ui = copyOf('js/ui.js');
  assert.match(ui, /\$\{backorderQty\} backordered/);
  assert.ok(!/recorded for staff processing/.test(ui));
});

test('the split label still distinguishes available from backordered', () => {
  const sf = loadStorefront();
  assert.equal(sf.stockSplitLabel(3, 2), '3 available now · 2 backordered');
  assert.equal(sf.stockSplitLabel(0, 2), '2 backordered');
  assert.equal(sf.stockSplitLabel(3, 0), '');
});

test('a full backorder says "Full backorder" instead of "from order —"', () => {
  const orders = copyOf('js/pages_orders.js');
  assert.match(orders, /b\.orderNumber \? `from order \$\{esc\(b\.orderNumber\)\}` : 'Full backorder'/);
  assert.ok(!/from order \$\{esc\(b\.orderNumber \|\| '—'\)\}/.test(orders));
});

test('the customer backorders page keeps every material detail', () => {
  const orders = copyOf('js/pages_orders.js');
  for (const [what, re] of [
    ['backorder number', /esc\(b\.number\)/],
    ['status', /pill\(b\.status\)/],
    ['SKU', /esc\(i\.sku\)/],
    ['quantity', /× \$\{i\.qty\}/],
    ['value', /money\(i\.price, b\)/],
    ['cancel action', /data-ca="\$\{esc\(b\.id\)\}"/],
  ]) assert.match(orders, re, `${what} must remain`);
});
