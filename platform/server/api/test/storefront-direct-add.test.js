/* DIRECT ADD TO CART — the post-handover client feedback.
 *
 * The product detail modal no longer asks the customer to dial a quantity and
 * then submit it. Each colourway has its own "Add to cart" button, one click
 * adds one piece of that exact sku to the REAL cart, and the row states how
 * many of it the cart actually holds.
 *
 * These run the SHIPPED storefront source in a vm sandbox and call the real
 * functions — nothing here is a re-implementation. `createDirectAddController`
 * takes its collaborators as arguments, so the parts that matter most (rapid
 * clicking, stale replies, failure reconciliation) are exercised as behaviour
 * rather than asserted as source text.
 */
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

/* ---------------------------------------------------------------------------
   A sandbox with just enough browser for the modal to build itself.

   `modal()` is stubbed to CAPTURE the markup the page produced. Everything the
   modal then looks up is answered from that captured markup — the rows, their
   skus, their add buttons — so a template that stops rendering a control has
   nothing to wire and the tests fail rather than passing on a stub.
   --------------------------------------------------------------------------- */

function stubEl(extra = {}) {
  const el = {
    innerHTML: '', textContent: '', style: {}, dataset: {}, onclick: null,
    removed: false, classes: new Set(),
    appendChild() {}, prepend() {}, addEventListener() {}, focus() {},
    remove() { el.removed = true; },
    querySelector: () => null, querySelectorAll: () => [],
    ...extra,
  };
  el.classList = {
    add: c => el.classes.add(c),
    remove: c => el.classes.delete(c),
    toggle: (c, on) => { if (on === undefined) { el.classes.has(c) ? el.classes.delete(c) : el.classes.add(c); } else if (on) el.classes.add(c); else el.classes.delete(c); return el.classes.has(c); },
    contains: c => el.classes.has(c),
  };
  return el;
}

/** Every `data-sku` attached to the given class, in document order. */
function skusFor(html, cls) {
  const re = new RegExp(`<[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*data-sku="([^"]+)"`, 'g');
  return [...html.matchAll(re)].map(m => m[1]);
}
/** `<div class="vrow" data-sku="…">` — the rows the modal actually rendered. */
function rowSkus(html) {
  return [...html.matchAll(/<div class="vrow" data-sku="([^"]+)"/g)].map(m => m[1]);
}

/** The modal object the page gets back, answering from the captured markup. */
function modalFromMarkup(html) {
  const rows = new Map();
  for (const sku of rowSkus(html)) {
    const incart = stubEl();
    const bo = stubEl();
    rows.set(sku, stubEl({
      dataset: { sku },
      querySelector: sel => (sel === '.vincart' ? incart : sel === '.vbo' ? bo : null),
      incart, bo,
    }));
  }
  const addButtons = skusFor(html, 'addone').map(sku => stubEl({ dataset: { sku } }));
  const notifyButtons = skusFor(html, 'notify').map(sku => stubEl({ dataset: { sku } }));
  const live = /id="cartLive"/.test(html) ? stubEl() : null;
  const byId = {
    '#mainImg': stubEl(),
    '#revealP': /id="revealP"/.test(html) ? stubEl() : null,
    '#custViewBtn': /id="custViewBtn"/.test(html) ? stubEl() : null,
    '#addBtn': /id="addBtn"/.test(html) ? stubEl() : null,
    '#addSummary': /id="addSummary"/.test(html) ? stubEl() : null,
    '#cartLive': live,
  };
  const m = stubEl({
    html,
    rows, addButtons, notifyButtons, live,
    querySelector(sel) {
      if (sel in byId) return byId[sel];
      if (sel === '.pdetail' || sel === '.pdetail-img' || sel === '.modal' || sel === '.close') {
        return stubEl();
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.vrow') return [...rows.values()];
      if (sel === '.addone') return addButtons;
      if (sel === '.notify') return notifyButtons;
      if (sel === '.vrow .qtybox') return [];
      return [];
    },
  });
  return m;
}

function loadStorefront({ role = 'customer', allowBackorders = true, api = {} } = {}) {
  const noop = () => {};
  const calls = { badge: [], toasts: [], api: [], modals: [] };
  const ctx = {
    console, calls,
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
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    homeHeader: () => '', whatsappFloat: () => '', scanListModal: noop,
    API: {
      get: (p) => { calls.api.push(['GET', p]); return (api.get || (() => Promise.resolve({})))(p); },
      post: (p, b) => { calls.api.push(['POST', p, b]); return (api.post || (() => Promise.resolve({})))(p, b); },
    },
    withOrderingContext: p => p, actingFor: () => null, noteOrderingFx: r => r,
    canPresentToCustomer: () => ['agent', 'super-agent', 'admin'].includes(role),
    setCartBadge: n => calls.badge.push(n),
    toast: (msg, err) => calls.toasts.push({ msg, err }),
    route: noop, bindSwipe: noop,
    eyeIcon: () => '', customerFrameView: noop,
    fmtDate: () => '',
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSf('js/icons.js'), ctx, { filename: 'icons.js' });
  vm.runInContext(readSf('js/ui.js'), ctx, { filename: 'ui.js' });
  /* The four ui.js helpers that need a real document. Everything else — esc,
     money, imgOr, stockPill, qtyBox, bindQtyBox — is the shipped code, because
     substituting those would be testing the substitute. */
  ctx.modal = (html) => { const m = modalFromMarkup(html); calls.modals.push(m); return m; };
  ctx.toast = (msg, err) => calls.toasts.push({ msg, err });
  ctx.imageLightbox = noop;
  ctx.bindSwipe = noop;
  vm.runInContext(readSf('js/pages_catalog.js'), ctx, { filename: 'pages_catalog.js' });
  return ctx;
}

const BLACK = { sku: '1844.1', color: 'Black', qty: 44, price: 49, stockStatus: 'in stock' };
const BLUE = { sku: '1844.4', color: 'Blue', qty: 6, price: 49, stockStatus: 'in stock' };
const HAVANA = { sku: '1844.9', color: 'Havana', qty: 0, price: 49, stockStatus: 'out of stock' };
const PRODUCT = {
  id: 'p_1', sku: '1844', name: 'Vedette', brand: 'Charlett', price: 49,
  images: ['a.jpg'], attributes: {}, variations: [BLACK, BLUE, HAVANA],
};

/** A cart response in the server's real shape. */
function cartOf(lines, avail = { '1844.1': 44, '1844.4': 6, '1844.9': 0 }) {
  const items = Object.entries(lines).map(([sku, qty]) => {
    const inStockQty = Math.max(0, Math.min(qty, avail[sku] ?? 0));
    return { sku, qty, inStockQty, backorderQty: qty - inStockQty };
  });
  return { items, totalQty: items.reduce((s, i) => s + i.qty, 0) };
}

/* =====================================================================
   1-3. the product detail markup
   ===================================================================== */

test('an orderable colourway has NO quantity box on the product detail row', () => {
  const sf = loadStorefront();
  for (const v of [BLACK, HAVANA]) {
    const html = sf.variationOrderControls(v);
    assert.ok(!/qtybox/.test(html), `${v.color} still offers a pre-selection quantity`);
    assert.ok(!/data-q="/.test(html), 'no +/- control belongs on the product page');
  }
});

test('every orderable colourway has its own Add to cart button', () => {
  const sf = loadStorefront();
  for (const v of [BLACK, BLUE, HAVANA]) {
    const html = sf.variationOrderControls(v);
    assert.match(html, /class="btn sm addone"/, `${v.color} must be addable`);
    assert.match(html, />Add to cart</);
    assert.match(html, new RegExp(`data-sku="${v.sku.replace('.', '\\.')}"`));
  }
});

test('the button carries the colour and sku in its accessible name', () => {
  const sf = loadStorefront();
  assert.match(sf.variationOrderControls(BLACK),
    /aria-label="Add Black — SKU 1844\.1 to cart"/);
  // …and the visible text stays short, so sighted users do not read it twice.
  assert.match(sf.variationOrderControls(BLACK), />Add to cart<\/button>/);
});

test('the row carries a dedicated, sku-scoped state element', () => {
  const sf = loadStorefront();
  for (const v of [BLACK, HAVANA]) {
    assert.match(sf.variationOrderControls(v),
      new RegExp(`<span class="vincart" data-incart="${v.sku.replace('.', '\\.')}"></span>`),
      'the count is a per-sku element, filled from the cart — never rendered from a guess');
  }
});

test('the count element starts EMPTY in the template, so it can only come from the cart', () => {
  const sf = loadStorefront();
  assert.ok(!/In cart:/.test(sf.variationOrderControls(BLACK)),
    'a number baked into the markup would be a number the server never agreed to');
});

test('the whole modal renders no quantity box and no bottom submit action', () => {
  const sf = loadStorefront();
  sf.productModal(PRODUCT);
  const html = sf.calls.modals[0].html;
  assert.ok(!/qtybox/.test(html), 'the two-stage quantity selection is gone');
  assert.ok(!/id="addBtn"/.test(html), 'the global "Add to cart" submit is gone');
  assert.ok(!/id="addSummary"/.test(html), 'the "N pcs selected" summary is gone');
  assert.ok(!/Add selection to cart/.test(html));
  assert.equal(rowSkus(html).length, 3);
  assert.deepEqual(skusFor(html, 'addone'), ['1844.1', '1844.4', '1844.9']);
});

test('the modal source no longer carries the old selection machinery', () => {
  const src = readSf('js/pages_catalog.js');
  const modalFn = src.slice(src.indexOf('function productModal'),
    src.indexOf('function customerFrameView'));
  for (const gone of ['chosen', 'boTotals', 'addSummary', 'addBtn',
    'Choose quantities first', 'variationQtyControls']) {
    assert.ok(!modalFn.includes(gone), `the product modal still references ${gone}`);
  }
});

test('the modal calls the helper the tests assert — no second copy of the markup', () => {
  const src = readSf('js/pages_catalog.js');
  assert.match(src, /\$\{guest \? '' : variationOrderControls\(v\)\}/,
    'the shipped row must be built by the function under test');
});

/* =====================================================================
   4. hydration — the row shows the CART, not a fresh zero
   ===================================================================== */

function controller(sf, { cart, addOne, available = () => 0 } = {}) {
  const painted = [];
  const errors = [];
  const c = sf.createDirectAddController({
    getCart: cart,
    addOne,
    available,
    render: s => painted.push({
      counts: new Map(s.counts), splits: new Map(s.splits),
      total: s.total, changed: s.changed,
    }),
    onError: e => errors.push(e),
  });
  return { c, painted, errors, last: () => painted[painted.length - 1] };
}

test('opening the modal hydrates every row from the authoritative cart', async () => {
  const sf = loadStorefront();
  const { c, last } = controller(sf,
    { cart: async () => cartOf({ '1844.1': 3, '1844.9': 1 }) });
  await c.hydrate();
  assert.equal(last().counts.get('1844.1'), 3, 'three Black were already in the cart');
  assert.equal(last().counts.get('1844.9'), 1);
  assert.equal(last().counts.get('1844.4') ?? 0, 0, 'Blue has none');
  assert.equal(last().total, 4);
});

test('reopening the modal reproduces the server quantity, not a local counter', async () => {
  const sf = loadStorefront();
  let served = cartOf({ '1844.1': 2 });
  const { c, last } = controller(sf, {
    cart: async () => served,
    addOne: async () => { served = cartOf({ '1844.1': 3 }); return served; },
    available: () => 44,
  });
  await c.hydrate();
  await c.add('1844.1');
  // a fresh modal, a fresh controller, the same server
  const second = controller(sf, { cart: async () => served });
  await second.c.hydrate();
  assert.equal(second.last().counts.get('1844.1'), 3);
  assert.equal(last().counts.get('1844.1'), 3);
});

test('the modal asks the server for the cart as soon as it opens', async () => {
  const sf = loadStorefront({ api: { get: () => Promise.resolve(cartOf({ '1844.1': 3 })) } });
  sf.productModal(PRODUCT);
  await new Promise(r => setTimeout(r, 5));
  assert.ok(sf.calls.api.some(([m, p]) => m === 'GET' && p === '/user/get-cart'),
    'a newly opened modal must not assume every row is at zero');
  const row = sf.calls.modals[0].rows.get('1844.1');
  assert.equal(row.incart.textContent, 'In cart: 3');
  assert.equal(sf.calls.modals[0].rows.get('1844.4').incart.textContent, '',
    'a colour with none in the cart shows no count at all');
});

/* =====================================================================
   5-8. clicking
   ===================================================================== */

/** A server that owns the quantities, exactly as the API does. */
function fakeServer(initial = {}, { avail = {}, fail = null } = {}) {
  const qty = { ...initial };
  return {
    qty,
    cart: async () => cartOf({ ...qty }, avail),
    addOne: async (sku) => {
      if (fail && fail(sku, qty)) throw Object.assign(new Error('nope'), { status: 409 });
      qty[sku] = (qty[sku] || 0) + 1;
      return cartOf({ ...qty }, avail);
    },
  };
}

test('one click makes the row read one', async () => {
  const sf = loadStorefront();
  const s = fakeServer({}, { avail: { '1844.1': 44 } });
  const { c, last } = controller(sf, { ...s, available: () => 44 });
  await c.add('1844.1');
  assert.equal(last().counts.get('1844.1'), 1);
  assert.equal(s.qty['1844.1'], 1);
});

test('a second click makes it two, and a third three', async () => {
  const sf = loadStorefront();
  const s = fakeServer({}, { avail: { '1844.1': 44 } });
  const { c, last } = controller(sf, { ...s, available: () => 44 });
  await c.add('1844.1');
  assert.equal(last().counts.get('1844.1'), 1);
  await c.add('1844.1');
  assert.equal(last().counts.get('1844.1'), 2);
  await c.add('1844.1');
  assert.equal(last().counts.get('1844.1'), 3);
  assert.equal(s.qty['1844.1'], 3);
});

test('adding Black does not move Blue', async () => {
  const sf = loadStorefront();
  const s = fakeServer({ '1844.4': 1 }, { avail: { '1844.1': 44, '1844.4': 6 } });
  const { c, last } = controller(sf, { ...s, available: () => 44 });
  await c.hydrate();
  await c.add('1844.1');
  await c.add('1844.1');
  assert.equal(last().counts.get('1844.1'), 2);
  assert.equal(last().counts.get('1844.4'), 1, "Blue's count is its own");
  assert.equal(s.qty['1844.4'], 1);
});

test('the count is per SKU even when two colours are clicked alternately', async () => {
  const sf = loadStorefront();
  const s = fakeServer({}, { avail: { '1844.1': 44, '1844.4': 6 } });
  const { c, last } = controller(sf, { ...s, available: () => 44 });
  for (const sku of ['1844.1', '1844.4', '1844.1', '1844.4', '1844.1']) await c.add(sku);
  assert.equal(last().counts.get('1844.1'), 3);
  assert.equal(last().counts.get('1844.4'), 2);
});

test('the header badge counts the WHOLE cart, not this product', async () => {
  const sf = loadStorefront();
  // 4 units of some other product are already in the cart
  const s = fakeServer({ 'OTHER.1': 4 }, { avail: { '1844.1': 44, 'OTHER.1': 9 } });
  const { c, last } = controller(sf, { ...s, available: () => 44 });
  await c.hydrate();
  assert.equal(last().total, 4);
  await c.add('1844.1');
  await c.add('1844.1');
  await c.add('1844.4');
  assert.equal(last().counts.get('1844.1'), 2, 'the ROW shows this sku only');
  assert.equal(last().total, 7, 'the BADGE shows every unit in the cart');
});

test('the badge moves on the click, before the server has answered', async () => {
  const sf = loadStorefront();
  let release;
  const held = new Promise(r => { release = r; });
  const { c, painted } = controller(sf, {
    cart: async () => cartOf({}),
    addOne: async () => { await held; return cartOf({ '1844.1': 1 }); },
    available: () => 44,
  });
  const pending = c.add('1844.1');
  assert.equal(painted[0].counts.get('1844.1'), 1, 'the row moved immediately');
  assert.equal(painted[0].total, 1, 'and so did the badge');
  release();
  await pending;
});

test('clicking a row button posts the increment for that exact sku', async () => {
  const sf = loadStorefront({
    api: {
      get: () => Promise.resolve(cartOf({})),
      post: () => Promise.resolve(cartOf({ '1844.4': 1 })),
    },
  });
  sf.productModal(PRODUCT);
  await new Promise(r => setTimeout(r, 5));
  const blue = sf.calls.modals[0].addButtons.find(b => b.dataset.sku === '1844.4');
  blue.onclick({ stopPropagation() {} });
  await new Promise(r => setTimeout(r, 5));
  // The request objects are built inside the vm realm, so compare structurally.
  const [method, url, body] = sf.calls.api.filter(([m]) => m === 'POST').at(-1);
  assert.equal(method, 'POST');
  assert.equal(url, '/user/add-one-to-cart');
  assert.deepEqual({ ...body }, { sku: '1844.4' }, 'no quantity is sent — one click is one piece');
  assert.equal(sf.calls.modals[0].rows.get('1844.4').incart.textContent, 'In cart: 1');
  assert.equal(sf.calls.badge.at(-1), 1);
});

/* =====================================================================
   9-10. rapid clicking and stale replies
   ===================================================================== */

test('five rapid clicks are five units — none is lost', async () => {
  const sf = loadStorefront();
  const s = fakeServer({}, { avail: { '1844.1': 99 } });
  const { c, last } = controller(sf, { ...s, available: () => 99 });
  const clicks = [];
  for (let i = 0; i < 5; i++) clicks.push(c.add('1844.1'));
  await Promise.all(clicks);
  assert.equal(s.qty['1844.1'], 5, 'the server received five increments');
  assert.equal(last().counts.get('1844.1'), 5);
  assert.equal(last().total, 5);
});

test('a reply that is already behind the customer cannot pull the count back', async () => {
  const sf = loadStorefront();
  const gates = [];
  const { c, last } = controller(sf, {
    cart: async () => cartOf({ '1844.1': 5 }),
    // every reply is held until the test releases it, and each one reports a
    // quantity that was true when it was issued
    addOne: async () => {
      const n = gates.length + 1;
      await new Promise(r => gates.push(r));
      return cartOf({ '1844.1': n });
    },
    available: () => 99,
  });
  const clicks = [c.add('1844.1'), c.add('1844.1'), c.add('1844.1')];
  assert.equal(last().counts.get('1844.1'), 3, 'the customer has clicked three times');
  // the FIRST reply lands last-but-two, claiming the line holds only one
  await new Promise(r => setTimeout(r, 1));
  gates[0]();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(last().counts.get('1844.1'), 3,
    'a stale reply must not overwrite a newer optimistic quantity');
  gates[1](); await new Promise(r => setTimeout(r, 5));
  gates[2]();
  await Promise.all(clicks);
  assert.equal(last().counts.get('1844.1'), 3, 'and the final reply reconciles to the truth');
});

test('requests for one sku are sent one at a time', async () => {
  const sf = loadStorefront();
  let live = 0, peak = 0;
  const { c } = controller(sf, {
    cart: async () => cartOf({}),
    addOne: async () => {
      live += 1; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 2));
      live -= 1;
      return cartOf({ '1844.1': 1 });
    },
    available: () => 44,
  });
  await Promise.all([c.add('1844.1'), c.add('1844.1'), c.add('1844.1')]);
  assert.equal(peak, 1, 'overlapping writes to one line are serialised by the client too');
});

/* =====================================================================
   11-12. failure
   ===================================================================== */

test('a server failure reconciles the row from the authoritative cart', async () => {
  const sf = loadStorefront();
  let gets = 0;
  const { c, last, errors } = controller(sf, {
    cart: async () => { gets += 1; return cartOf({ '1844.1': 2 }); },
    addOne: async () => { throw Object.assign(new Error('Server error'), { status: 500 }); },
    available: () => 44,
  });
  await c.hydrate();
  assert.equal(last().counts.get('1844.1'), 2);
  await c.add('1844.1');
  assert.equal(errors.length, 1, 'the customer is told');
  assert.equal(errors[0].message, 'Server error');
  assert.equal(last().counts.get('1844.1'), 2,
    'the optimistic 3 is gone — the cart never took it');
  assert.equal(last().total, 2, 'and the badge is authoritative again');
  assert.equal(gets, 2, 'the cart was re-read rather than guessed at');
});

test('a stock refusal rolls the row back and says why', async () => {
  const sf = loadStorefront();
  const s = fakeServer({ '1844.1': 2 }, { avail: { '1844.1': 2 } });
  const refusing = {
    cart: s.cart,
    addOne: async () => {
      throw Object.assign(new Error('Only 2 left in stock for 1844.1.'),
        { status: 409, data: { sku: '1844.1', available: 2, requested: 3 } });
    },
    available: () => 2,
  };
  const { c, last, errors } = controller(sf, refusing);
  await c.hydrate();
  await c.add('1844.1');
  assert.equal(errors[0].message, 'Only 2 left in stock for 1844.1.');
  assert.equal(last().counts.get('1844.1'), 2, 'reconciled to what the shelf allows');
  assert.equal(last().total, 2);
});

test('a failure drops the rest of that colour\'s queued clicks', async () => {
  const sf = loadStorefront();
  let attempts = 0;
  const { c, last, errors } = controller(sf, {
    cart: async () => cartOf({ '1844.1': 2 }),
    addOne: async () => {
      attempts += 1;
      throw Object.assign(new Error('Only 2 left in stock for 1844.1.'), { status: 409 });
    },
    available: () => 2,
  });
  await Promise.all([c.add('1844.1'), c.add('1844.1'), c.add('1844.1')]);
  assert.equal(attempts, 1, 'the refusal is not collected three times over');
  assert.equal(errors.length, 1, 'nor reported three times over');
  assert.equal(last().counts.get('1844.1'), 2, 'and the truth still wins');
});

test('a failure on one colour does not roll back another colour that succeeded', async () => {
  const sf = loadStorefront();
  const qty = { '1844.4': 0 };
  const { c, last } = controller(sf, {
    cart: async () => cartOf({ ...qty, '1844.1': 0 }),
    addOne: async (sku) => {
      if (sku === '1844.9') throw Object.assign(new Error('1844.9 is out of stock.'), { status: 409 });
      qty[sku] = (qty[sku] || 0) + 1;
      return cartOf({ ...qty });
    },
    available: () => 44,
  });
  await Promise.all([c.add('1844.4'), c.add('1844.9')]);
  assert.equal(last().counts.get('1844.4'), 1, 'the good add survived');
  assert.equal(last().counts.get('1844.9') ?? 0, 0, 'the refused one did not');
});

test('the failure toast reaches the customer through the real modal wiring', async () => {
  const sf = loadStorefront({
    api: {
      get: () => Promise.resolve(cartOf({})),
      post: () => Promise.reject(Object.assign(new Error('1844.9 is out of stock.'),
        { status: 409 })),
    },
  });
  sf.productModal(PRODUCT);
  await new Promise(r => setTimeout(r, 5));
  const havana = sf.calls.modals[0].addButtons.find(b => b.dataset.sku === '1844.9');
  havana.onclick({ stopPropagation() {} });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sf.calls.toasts.at(-1), { msg: '1844.9 is out of stock.', err: true });
  assert.equal(sf.calls.modals[0].rows.get('1844.9').incart.textContent, '',
    'no optimistic count is left standing on an add that did not happen');
});

/* =====================================================================
   13. the modal stays open
   ===================================================================== */

test('a successful add does NOT close the modal', async () => {
  const sf = loadStorefront({
    api: {
      get: () => Promise.resolve(cartOf({})),
      post: () => Promise.resolve(cartOf({ '1844.1': 1 })),
    },
  });
  sf.productModal(PRODUCT);
  await new Promise(r => setTimeout(r, 5));
  const m = sf.calls.modals[0];
  m.addButtons[0].onclick({ stopPropagation() {} });
  m.addButtons[0].onclick({ stopPropagation() {} });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(m.removed, false,
    'the customer may want a second piece, or another colour');
});

test('nothing in the modal removes itself after adding', () => {
  const src = readSf('js/pages_catalog.js');
  const modalFn = src.slice(src.indexOf('function productModal'),
    src.indexOf('function customerFrameView'));
  assert.ok(!/m\.remove\(\)/.test(modalFn),
    'the old flow closed the modal on a successful bulk add');
});

/* =====================================================================
   14-15. backorders and Notify me
   ===================================================================== */

test('BACKORDERS ON: an out-of-stock colour keeps BOTH Add to cart and Notify me', () => {
  const sf = loadStorefront({ allowBackorders: true });
  const html = sf.variationOrderControls(HAVANA);
  assert.match(html, /class="btn sm addone"/, 'a backorder is a real order');
  assert.match(html, /class="btn ghost sm notify"/, 'waiting for stock is a different intent');
  assert.ok(html.indexOf('addone') < html.indexOf('notify'),
    'ordering leads; notification is the secondary action');
  assert.equal(sf.stockPill(HAVANA),
    '<span class="stockpill back">Available to Backorder</span>');
});

test('BACKORDERS OFF: an out-of-stock colour offers Notify me and NO add control', () => {
  const sf = loadStorefront({ allowBackorders: false });
  const html = sf.variationOrderControls(HAVANA);
  assert.ok(!/addone/.test(html), 'a control that cannot work must not be presented');
  assert.match(html, /notify/);
  assert.equal(sf.stockPill(HAVANA), '<span class="stockpill out">Out of Stock</span>');
});

test('BACKORDERS OFF: an out-of-stock colour still states what the cart holds', () => {
  const sf = loadStorefront({ allowBackorders: false });
  assert.match(sf.variationOrderControls(HAVANA), /class="vincart"/,
    '"In cart: 2" is worth knowing even when no more may be added');
});

test('an in-stock colour has no Notify me — there is nothing to notify about', () => {
  const sf = loadStorefront();
  assert.ok(!/notify/.test(sf.variationOrderControls(BLACK)));
  assert.match(sf.variationOrderControls(BLACK), /addone/);
});

test('the card CTA and the modal still agree about a zero-stock frame', () => {
  const on = loadStorefront({ allowBackorders: true });
  assert.match(on.orderButton({ qty: 0, price: 49 }, false), /Backorder/);
  assert.ok(!/disabled/.test(on.orderButton({ qty: 0, price: 49 }, false)));
  assert.match(on.variationOrderControls(HAVANA), /addone/);
  const off = loadStorefront({ allowBackorders: false });
  assert.match(off.orderButton({ qty: 0, price: 49 }, false), /disabled/);
  assert.ok(!/addone/.test(off.variationOrderControls(HAVANA)));
});

test('the per-row backorder note reads from the cart\'s own split', () => {
  const sf = loadStorefront();
  assert.equal(sf.variationBackorderNote({ inStockQty: 2, backorderQty: 1 }),
    '2 now · 1 on backorder');
  assert.equal(sf.variationBackorderNote({ inStockQty: 0, backorderQty: 3 }),
    '3 on backorder');
  assert.equal(sf.variationBackorderNote({ inStockQty: 4, backorderQty: 0 }), '');
});

test('the note appears on the row as soon as the quantity passes the shelf', async () => {
  const sf = loadStorefront({
    api: {
      get: () => Promise.resolve(cartOf({ '1844.4': 8 }, { '1844.4': 6 })),
      post: () => Promise.resolve({}),
    },
  });
  sf.productModal(PRODUCT);
  await new Promise(r => setTimeout(r, 5));
  const blue = sf.calls.modals[0].rows.get('1844.4');
  assert.equal(blue.incart.textContent, 'In cart: 8');
  assert.equal(blue.bo.textContent, '6 now · 2 on backorder');
  assert.ok(blue.bo.classList.contains('on'), 'and it is actually visible');
  const black = sf.calls.modals[0].rows.get('1844.1');
  assert.equal(black.bo.textContent, '', 'a fully covered colour says nothing');
});

test('the backorder split comes from the SERVER, not from a client formula', async () => {
  const sf = loadStorefront();
  // the server insists on a split the client could not have derived
  const { c, last } = controller(sf, {
    cart: async () => ({
      items: [{ sku: '1844.1', qty: 5, inStockQty: 1, backorderQty: 4 }], totalQty: 5,
    }),
  });
  await c.hydrate();
  assert.deepEqual({ ...last().splits.get('1844.1') }, { inStockQty: 1, backorderQty: 4 });
  assert.equal(sf.variationBackorderNote(last().splits.get('1844.1')),
    '1 now · 4 on backorder', 'and the row says exactly what the server decided');
});

test('Notify me still toggles independently of the cart', async () => {
  const sf = loadStorefront({
    api: {
      get: (p) => Promise.resolve(p === '/user/restock-notify'
        ? { skus: ['1844.9'] } : cartOf({ '1844.9': 2 })),
      post: () => Promise.resolve({ notify: false }),
    },
  });
  sf.productModal(PRODUCT);
  await new Promise(r => setTimeout(r, 5));
  const m = sf.calls.modals[0];
  assert.equal(m.notifyButtons.length, 1, 'only the out-of-stock colour offers it');
  assert.equal(m.notifyButtons[0].dataset.sku, '1844.9');
  assert.ok(m.notifyButtons[0].classes.has('on'), 'an existing subscription shows as set');
  await m.notifyButtons[0].onclick();
  assert.ok(!m.notifyButtons[0].classes.has('on'));
  assert.equal(m.rows.get('1844.9').incart.textContent, 'In cart: 2',
    'toggling a notification does not disturb the cart quantity');
});

/* =====================================================================
   16-18. the ACTUAL cart keeps its quantity controls
   ===================================================================== */

const CART_SRC = readSf('js/pages_cart.js');

test('the cart page still renders a +/- quantity box per line', () => {
  assert.match(CART_SRC, /\$\{qtyBox\(i\.qty, 0, cart\.allowBackorders === false \? i\.available : null\)\}/,
    'quantity EDITING belongs in the cart, and it stays there');
  assert.match(CART_SRC, /bindQtyBox\(line\.querySelector\('\.qtybox'\)/);
});

test('the cart still posts an ABSOLUTE quantity, which is what that endpoint means', () => {
  assert.match(CART_SRC, /API\.post\('\/user\/add-to-cart', \{ sku, qty: v \}\)/);
  assert.ok(!/add-one-to-cart/.test(CART_SRC),
    'the cart sets a quantity; it does not increment');
});

test('the cart keeps an explicit Remove control alongside the +/-', () => {
  assert.match(CART_SRC, /title="Remove" aria-label="Remove"/);
  assert.match(CART_SRC, /API\.post\('\/user\/delete-cart-item', \{ sku \}\)/);
});

test('a cart line at 1 can be decremented to 0 — the box is not floored at 1', () => {
  const sf = loadStorefront();
  // The REAL bindQtyBox, over a box built the way the cart builds it: qtyBox(1, 0, null)
  const seen = [];
  const input = {
    value: '1', min: '0', getAttribute: () => null,
    addEventListener() {}, set onchange(fn) { this._c = fn; }, get onchange() { return this._c; },
  };
  const minus = { dataset: { q: '-1' }, onclick: null };
  const box = {
    querySelector: sel => (sel === 'input' ? input : null),
    querySelectorAll: () => [minus],
  };
  sf.bindQtyBox(box, v => seen.push(v));
  minus.onclick();
  assert.deepEqual(seen, [0], 'decrementing the last piece asks the server for zero');
  assert.equal(input.value, '0');
});

test('the shipped cart markup floors the box at zero, not at one', () => {
  const sf = loadStorefront();
  assert.match(sf.qtyBox(1, 0, null), /min="0"/);
});

/* =====================================================================
   19-20. accessibility and layout
   ===================================================================== */

test('quantity changes are announced through one polite live region', async () => {
  const sf = loadStorefront({
    api: {
      get: () => Promise.resolve(cartOf({})),
      post: () => Promise.resolve(cartOf({ '1844.1': 1 })),
    },
  });
  sf.productModal(PRODUCT);
  const html = sf.calls.modals[0].html;
  assert.match(html, /<span class="sr-only" id="cartLive" role="status" aria-live="polite">/);
  await new Promise(r => setTimeout(r, 5));
  sf.calls.modals[0].addButtons[0].onclick({ stopPropagation() {} });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sf.calls.modals[0].live.textContent, 'Black — SKU 1844.1: 1 in cart');
});

test('the live region names the colour that changed, not the whole cart', async () => {
  const sf = loadStorefront({
    api: {
      get: () => Promise.resolve(cartOf({ '1844.1': 4 })),
      post: () => Promise.resolve(cartOf({ '1844.1': 4, '1844.4': 1 })),
    },
  });
  sf.productModal(PRODUCT);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(sf.calls.modals[0].live.textContent, '',
    'hydration is not an announcement — nothing changed for the customer');
  sf.calls.modals[0].addButtons.find(b => b.dataset.sku === '1844.4')
    .onclick({ stopPropagation() {} });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sf.calls.modals[0].live.textContent, 'Blue — SKU 1844.4: 1 in cart');
});

test('the controls are real buttons, keyboard reachable, with no emoji', () => {
  const sf = loadStorefront();
  const html = sf.variationOrderControls(HAVANA);
  assert.match(html, /<button class="btn sm addone" type="button"/,
    'type="button" so a stray Enter never submits something else');
  assert.equal((html.match(/<button/g) || []).length, 2, 'add + notify, both buttons');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html),
    'a functional control must not be an emoji');
});

test('the focus ring is not suppressed on the new control', () => {
  assert.ok(!/\.addone[^{]*\{[^}]*outline:\s*none/.test(CSS));
  assert.ok(!/\.vincart[^{]*\{[^}]*outline:\s*none/.test(CSS));
});

test('the ordering controls wrap instead of overflowing a narrow row', () => {
  const rule = CSS.match(/\n\.pdetail \.vctrl\{[^}]*\}/);
  assert.ok(rule, '.pdetail .vctrl must exist — it is the ordering unit');
  assert.match(rule[0], /display:flex/);
  assert.match(rule[0], /flex-wrap:wrap/,
    'price + count + Add to cart + Notify me do not fit one line on a 360px phone');
  assert.match(rule[0], /justify-content:flex-end/);
});

test('a row with nothing in the cart is no wider than before the count existed', () => {
  assert.match(CSS, /\.vincart:empty\{display:none\}/,
    'an empty count must contribute neither width nor a flex gap');
});

test('the count itself cannot be clipped or wrapped', () => {
  const rule = CSS.match(/\n\.vincart\{[^}]*\}/);
  assert.match(rule[0], /flex:0 0 auto/);
  assert.match(rule[0], /white-space:nowrap/);
  assert.match(rule[0], /tabular-nums/, 'the number must not jitter as it changes');
});

test('the Add to cart button keeps a real touch target on a phone', () => {
  const desktop = CSS.match(/\n\.pdetail \.vctrl \.addone\{[^}]*\}/);
  assert.match(desktop[0], /min-height:36px/);
  const mobile = CSS.slice(CSS.indexOf('@media(max-width:760px)'));
  assert.match(mobile, /\.pdetail \.vctrl \.addone\{min-height:40px/);
});

test('no dead quantity-box styling is left behind in the product modal', () => {
  assert.ok(!/\.pdetail \.qtybox/.test(CSS), 'the modal has no quantity box any more');
  assert.ok(!/\.pdetail \.qtyfield/.test(CSS));
  assert.ok(!/\.vactions/.test(CSS), 'the old actions wrapper is gone from the markup too');
  // …but the shared control itself stays, because the cart and the scan list use it.
  assert.match(CSS, /\n\.qtybox\{/);
});

test('the shared quantity control is untouched for the screens that still use it', () => {
  const src = readSf('js/pages_catalog.js');
  assert.match(src, /bindQtyBox\(qb, v => \{ if \(v > 0\) chosen\.set\(sku, v\)/,
    'Quick reorder still selects quantities and submits them');
  assert.match(src, /box\.querySelectorAll\('\.qtybox'\)/);
  assert.match(readSf('js/pages_catalog.js'), /\$\{qtyBox\(x\.available > 0 \? x\.qty : 0/,
    'Scan your list is unchanged');
});
