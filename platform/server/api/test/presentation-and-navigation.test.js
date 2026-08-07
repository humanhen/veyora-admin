/* Client feedback items D, E and F, asserted against the real shipped source.

   D — purchase history and reorder presentation
   E — a Back control that always goes somewhere
   F — less "bubbly", more like trade software

   D and F are presentation, so most of this reads CSS as text; that is
   deliberate, because the defects reported were layout and visual weight, not
   logic. E has real behaviour, and `backTarget()` is loaded and CALLED. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STOREFRONT = path.resolve(HERE, '..', '..', 'storefront');
const ADMIN = path.resolve(HERE, '..', '..', '..', '..');

const readSf = p => fs.readFileSync(path.join(STOREFRONT, p), 'utf8');
const CSS = readSf('css/store.css');
const ADMIN_CSS = fs.readFileSync(path.join(ADMIN, 'css', 'styles.css'), 'utf8');
/* Whitespace-normalised, comments stripped: these rules are written across
   several lines and several of the comments name the very values being
   asserted. Spaces inside `0 0 auto` are preserved. */
const flat = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{};:,>])\s*/g, '$1');
const FLAT = flat(CSS);
const rule = (sel, src = FLAT) => {
  const at = src.indexOf(sel + '{');
  return at < 0 ? null : src.slice(at, src.indexOf('}', at));
};

/* ============ D — the stock label and the thumbnail ============ */

function loadUi() {
  const ctx = {
    console, Store: { features: { allowBackorders: true } },
    esc: s => String(s ?? ''),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSf('js/ui.js'), ctx, { filename: 'ui.js' });
  return ctx;
}

test('availability labels are capitalised, consistently', () => {
  const ui = loadUi();
  assert.match(ui.stockPill({ qty: 5 }), />In Stock</);
  assert.match(ui.stockPill({ qty: 0, stockStatus: 'in production' }), />In Production</);
  assert.match(ui.stockPill({ qty: 0, stockStatus: 'in production' }, { short: true }), />Production</);
  assert.match(ui.stockPill({ qty: 0 }), />Available to Backorder</);
});

test('every availability label is title-cased, not just the one reported', () => {
  /* "Available to backorder" was already capitalised while "in stock" was not,
     which is what made it look careless. The rule is now uniform. */
  const ui = loadUi();
  ui.Store.features.allowBackorders = false;
  const labels = [
    ui.stockPill({ qty: 5 }),
    ui.stockPill({ qty: 0 }),
    ui.stockPill({ qty: 0, stockStatus: 'in production' }),
  ].map(html => html.replace(/<[^>]*>/g, ''));
  for (const label of labels) {
    assert.match(label, /^[A-Z]/, `"${label}" starts with a capital`);
    for (const word of label.split(' ')) {
      /* Small joining words stay lowercase — "Available to Backorder". */
      if (['to', 'of', 'in', 'on'].includes(word)) continue;
      assert.match(word, /^[A-Z]/, `"${word}" in "${label}" is capitalised`);
    }
  }
});

test('the list thumbnail has no border and no white plate', () => {
  const r = rule('.vrow img');
  assert.ok(r, '.vrow img exists');
  assert.match(r, /border:0/, 'the grey outline is gone');
  assert.match(r, /background:transparent/, 'and so is the white box behind it');
  assert.ok(!/border:1px/.test(r), 'no border survives');
});

test('the reorder row gives the name column a workable width', () => {
  /* It was the only element allowed to yield, so it collapsed to its 80px
     basis and wrapped to four lines while everything else kept its size. */
  const r = rule('.reorder-row .vcol');
  assert.ok(r, '.reorder-row .vcol exists');
  assert.match(r, /flex:1 1 220px/);
  assert.match(FLAT, /@media\(max-width:560px\)\{[\s\S]*?\.reorder-row \.vcol\{flex:1 1 100%\}/,
    'and on a phone it takes the full row rather than sharing it');
});

test('the reorder rows are marked so the rule can reach them', () => {
  assert.match(readSf('js/pages_dashboard.js'), /class="vrow reorder-row"/);
});

/* ============ E — Back always goes somewhere ============ */

function loadNav() {
  const ctx = { console, location: { hash: '#/' }, history: {}, setTimeout };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  /* icons.js first: backButton() renders one. */
  vm.runInContext(readSf('js/icons.js'), ctx, { filename: 'icons.js' });
  const app = readSf('js/app.js');
  /* Only the navigation block is needed, and running the whole file would
     start the router. Everything up to the shell is enough. */
  vm.runInContext(app.slice(0, app.indexOf('function shell(')), ctx, { filename: 'app.js' });
  return ctx;
}

test('a detail screen goes back to its own list', () => {
  const { backTarget } = loadNav();
  assert.equal(backTarget('#/order/SO-100'), '#/orders');
  assert.equal(backTarget('#/list/summer'), '#/products',
    '#/list alone is not a screen, so its parent is used');
  assert.equal(backTarget('#/returns/create'), '#/returns');
});

test('a list screen goes back to the dashboard', () => {
  const { backTarget } = loadNav();
  for (const hash of ['#/orders', '#/returns', '#/backorders', '#/products',
    '#/favourites', '#/account', '#/spare-parts', '#/replenishment']) {
    assert.equal(backTarget(hash), '#/dashboard', `${hash} returns to the dashboard`);
  }
});

test('the checkout path unwinds the way it was walked', () => {
  const { backTarget } = loadNav();
  assert.equal(backTarget('#/checkout'), '#/cart');
  assert.equal(backTarget('#/cart'), '#/products');
});

test('screens with no parent offer no Back control at all', () => {
  /* A control that goes nowhere is worse than no control. */
  const { backTarget, backButton } = loadNav();
  for (const hash of ['#/', '#/home', '#/dashboard', '#/login', '#/forgot',
    '#/activate', '#/set-password']) {
    assert.equal(backTarget(hash), null, `${hash} is a root`);
    assert.equal(backButton(hash), '', `${hash} renders no Back button`);
  }
});

test('an unknown screen still goes somewhere, never nowhere', () => {
  const { backTarget } = loadNav();
  for (const hash of ['#/nonsense', '#/a-route-added-next-year', '#/x/y/z']) {
    assert.ok(backTarget(hash), `${hash} has a destination`);
  }
  assert.equal(backTarget('#/nonsense'), '#/dashboard');
});

test('the fallback is deterministic — the same screen always goes to the same place', () => {
  const { backTarget } = loadNav();
  const once = backTarget('#/order/SO-100');
  const twice = backTarget('#/order/SO-999');
  assert.equal(once, twice, 'it does not depend on where you came from');
});

test('Back renders as a real button with an accessible name', () => {
  const { backButton } = loadNav();
  const html = backButton('#/orders');
  assert.match(html, /<button[^>]*type="button"/);
  assert.match(html, /aria-label="Back"/);
  assert.match(html, /<svg/, 'and carries an icon rather than an arrow glyph');
});

test('history is used only while we know the entries are ours', () => {
  const app = readSf('js/app.js');
  assert.match(app, /if \(inAppDepth > 0 && typeof history !== 'undefined' && history\.back\)/,
    'a deep link has no in-app history, so back() would leave the site');
  assert.match(app, /inAppDepth -= 1;/);
  assert.match(app, /noteNavigation\(\); route\(\);/,
    'each in-app navigation is counted');
});

test('a history step that does not move falls back deterministically', () => {
  /* The browser can decline a pop, or the entry can turn out not to be ours.
     Without this the control silently does nothing. */
  const app = readSf('js/app.js');
  assert.match(app, /if \(location\.hash === before && target\) location\.hash = target;/);
});

test('every parent named in the table is a route that exists', () => {
  /* A fallback pointing at a screen that was renamed is a dead end that no
     amount of history handling can rescue. */
  const files = fs.readdirSync(path.join(STOREFRONT, 'js')).filter(f => f.endsWith('.js'));
  const routes = new Set();
  for (const f of files) {
    for (const m of readSf(`js/${f}`).matchAll(/Routes\['(#\/[a-z-]*)'\]/g)) routes.add(m[1]);
  }
  const { backTarget } = loadNav();
  const targets = new Set();
  for (const hash of [...routes]) {
    const t = backTarget(hash);
    if (t) targets.add(t);
  }
  assert.ok(targets.size > 0, 'there are fallbacks to check');
  for (const t of targets) {
    assert.ok(routes.has(t), `Back sends the customer to ${t}, which is not a route`);
  }
});

/* ============ F — trade software, not a consumer app ============ */

test('status labels are rectangles, not lozenges', () => {
  for (const sel of ['.pill', '.vrow .stockpill', '.bo-state']) {
    const r = rule(sel);
    assert.ok(r, `${sel} exists`);
    assert.match(r, /border-radius:var\(--radius-badge\)/, `${sel} uses the badge radius`);
    assert.ok(!/border-radius:999px/.test(r), `${sel} is no longer fully round`);
  }
  assert.match(FLAT, /--radius-badge:4px/);
});

test('the decision lives in tokens, not in twenty-two separate rules', () => {
  assert.match(FLAT, /--radius-chip:6px/);
  assert.match(FLAT, /--radius:8px/);
  assert.match(flat(ADMIN_CSS), /--radius-badge:4px/, 'the admin panel shares the decision');
});

test('the card shadow no longer lifts everything off the page', () => {
  /* Two stacked shadows, one of them 18px wide, made a dense ordering screen
     look like a set of floating tiles. */
  const shadow = FLAT.match(/--shadow:([^;]+);/)[1];
  const blurs = [...shadow.matchAll(/(\d+)px rgba/g)].map(m => Number(m[1]));
  assert.ok(Math.max(...blurs) <= 8, `the widest blur is ${Math.max(...blurs)}px`);
  const adminShadow = flat(ADMIN_CSS).match(/--shadow:([^;]+);/)[1];
  const adminBlurs = [...adminShadow.matchAll(/(\d+)px rgba/g)].map(m => Number(m[1]));
  assert.ok(Math.max(...adminBlurs) <= 8, 'the admin panel too');
});

test('round shapes survive only where the shape means something', () => {
  /* Count bubbles and circular icon buttons stay round; this is a change of
     visual register, not a purge. */
  for (const sel of ['.topbar .badge', '.pcard2 .fav']) {
    assert.match(rule(sel) ?? '', /border-radius:999px/,
      `${sel} is genuinely circular and stays that way`);
  }
});

test('colour swatches show the whole frame instead of cropping it round', () => {
  const r = rule('.pcard2 .vthumbs img');
  assert.match(r, /border-radius:var\(--radius-chip\)/);
  assert.ok(!/border-radius:999px/.test(r), 'a round crop cut the frame off');
});
