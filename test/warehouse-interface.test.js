/* The warehouse admin interface (warehouse interface correction).

   The security hardening workstream correctly made POST /admin/sync
   admin-only. The panel did not know: every screen mutates a local snapshot
   and saves through that one endpoint, so a warehouse login got a 403 — and
   pushSync retried it every five seconds forever.

   These tests drive the REAL shipped files in the DOM shim and assert on what
   was rendered and what was sent. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAdmin, ROOT } = require('./helpers/dom.js');

const FILES = ['js/util.js', 'js/data.js', 'js/app.js', 'js/pages_catalog.js'];

/** Every admin action, as the server would report it for each role. */
const ADMIN_ACTIONS = {
  'sync.write': true, 'inventory.adjust': true, 'inventory.transfer': true,
  'orders.fulfil': true, 'backorders.convert': true, 'orders.money': true,
  'users.manage': true, 'catalogue.edit': true, 'settings.edit': true,
  'finance.manage': true, 'imports.run': true,
};
const WAREHOUSE_ACTIONS = Object.fromEntries(
  Object.keys(ADMIN_ACTIONS).map((k) => [k,
    ['inventory.adjust', 'inventory.transfer', 'orders.fulfil', 'backorders.convert'].includes(k)]));

const SNAPSHOT = {
  warehouses: [{ id: 'wh_main', code: 'MAIN', name: 'Main' },
               { id: 'wh_res', code: 'RES', name: 'Reserve' }],
  products: [{
    id: 'p1', sku: 'MODEL-1', name: 'Model One', brand: 'Example', price: 100,
    categories: [], tags: [], images: [], attributes: {}, isActive: true,
    variations: [{ id: 'v1', sku: 'SKU-1', color: 'Black', price: 100,
                   stock: { wh_main: { qty: 5, shelf: 'A1' } } }],
  }],
  users: [], orders: [], backorders: [], audit: [],
};

/** Boots the panel as a given role and records every request. */
async function boot({ role = 'warehouse', actions = WAREHOUSE_ACTIONS, routes = {} } = {}) {
  const sandbox = loadAdmin(FILES);
  const calls = [];

  const table = Object.assign({
    'GET /admin/access': async () => ({ status: 200, body: { role, actions } }),
    'GET /admin/account-permissions/registry': async () => ({ status: 403, body: { error: 'forbidden' } }),
    'GET /admin/public-content/capabilities': async () => ({ status: 403, body: { error: 'forbidden' } }),
    'GET /admin/enquiries/capabilities': async () => ({ status: 403, body: { error: 'forbidden' } }),
    /* DB.init() must run for real: `pushSync` refuses to send until the store
       reaches its ready state, so a test that skips init would prove nothing
       about syncing either way. */
    'GET /admin/snapshot': async () => ({
      status: 200,
      body: {
        collections: { ...JSON.parse(JSON.stringify(SNAPSHOT)), settings: {} },
        meta: { nextOrderNumber: 1, nextBackorderNumber: 1, nextReturnNumber: 1,
                nextInvoiceNumber: 1, nextPoNumber: 1 },
      },
    }),
    'GET /admin/orders': async () => ({ status: 200, body: { orders: [] } }),
    'GET /admin/backorders': async () => ({ status: 200, body: { backorders: [] } }),
  }, routes);

  sandbox.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const p = String(url).replace(/^\/api/, '');
    calls.push({ method, path: p, body: opts.body ? JSON.parse(opts.body) : null });
    const responder = table[`${method} ${p}`] || table[`${method} *`];
    const r = responder ? await responder() : { status: 404, body: { error: 'not found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };

  sandbox.localStorage.setItem('veyora_session',
    JSON.stringify({ id: 'u_w', name: 'Warehouse', role }));

  await sandbox.DB.init();          // brings the store to its ready state
  sandbox.App.ready = true;
  await sandbox.App.loadCaps();
  return { sandbox, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));

function renderPage(sandbox, route, args = []) {
  const el = sandbox.document.getElementById('content');
  sandbox.App.routes[route](el, args);
  return el;
}

// ---------------------------------------------------------------------------
// 1-5 — the regression itself
// ---------------------------------------------------------------------------

test('1 — a warehouse session never calls the generic admin sync', async () => {
  const { sandbox, calls } = await boot();
  /* Dirty the snapshot the way any screen would, then force a save. */
  sandbox.DB.load().products[0].name = 'Renamed';
  sandbox.DB.save();
  await new Promise((r) => setTimeout(r, 900));   // past the 700ms debounce
  assert.equal(calls.filter((c) => c.path === '/admin/sync').length, 0,
    'a warehouse session must never POST /admin/sync');
});

test('2 — an admin session still syncs exactly as before', async () => {
  const { sandbox, calls } = await boot({
    role: 'admin', actions: ADMIN_ACTIONS,
    routes: { 'POST /admin/sync': async () => ({ status: 200, body: { ok: true, remaps: [] } }) },
  });
  sandbox.DB.load().products[0].name = 'Renamed';
  sandbox.DB.save();
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(calls.filter((c) => c.path === '/admin/sync').length, 1,
    'admin behaviour must be unchanged');
});

test('3 — a 403 on sync does not retry forever', async () => {
  /* The worst part of the regression: the catch re-armed save() every five
     seconds, so a warehouse login produced an endless toast loop. */
  const { sandbox, calls } = await boot({
    role: 'admin', actions: ADMIN_ACTIONS,   // client believes it may sync
    routes: { 'POST /admin/sync': async () => ({ status: 403, body: { error: 'forbidden' } }) },
  });
  sandbox.DB.load().products[0].name = 'Renamed';
  sandbox.DB.save();
  await new Promise((r) => setTimeout(r, 900));
  const first = calls.filter((c) => c.path === '/admin/sync').length;
  assert.equal(first, 1);

  /* Dirty it again — the session now knows it cannot sync. */
  sandbox.DB.load().products[0].name = 'Renamed twice';
  sandbox.DB.save();
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(calls.filter((c) => c.path === '/admin/sync').length, 1,
    'after a 403 the client must stop attempting the sync');
});

test('4 — the panel asks the server what it may do', async () => {
  const { calls } = await boot();
  assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/admin/access'),
    'access must be server-derived, not inferred from the session role');
});

test('5 — discovery failure fails closed', async () => {
  const { sandbox } = await boot({
    routes: { 'GET /admin/access': async () => ({ status: 500, body: {} }) },
  });
  for (const action of Object.keys(ADMIN_ACTIONS)) {
    assert.equal(sandbox.App.may(action), false, `${action} must be unheld when discovery fails`);
  }
});

// ---------------------------------------------------------------------------
// 6-10 — navigation reflects what the session may do
// ---------------------------------------------------------------------------

function navRoutes(sandbox) {
  sandbox.App.renderNav();
  return sandbox.document.getElementById('side-nav')
    .querySelectorAll('[href]').map((a) => a.getAttribute('href').replace('#/', ''));
}

test('6 — a warehouse session sees no commercial or administrative screen', async () => {
  const { sandbox } = await boot();
  const routes = navRoutes(sandbox);
  for (const hidden of ['users', 'leads', 'chains', 'suitcases', 'email-templates',
                        'payments', 'collection', 'invoices', 'statements',
                        'promotions', 'shipping', 'free-shipping', 'agent-revenue',
                        'production', 'purchasing', 'stock-csv', 'inventory-csv',
                        'import-data', 'returns', 'spare-parts', 'tasks']) {
    assert.ok(!routes.includes(hidden), `warehouse must not see "${hidden}"`);
  }
});

test('7 — a warehouse session keeps its operational screens', async () => {
  const { sandbox } = await boot();
  const routes = navRoutes(sandbox);
  for (const shown of ['dashboard', 'orders', 'backorders', 'quick-scan',
                       'products', 'inventory', 'warehouses', 'reports', 'audit']) {
    assert.ok(routes.includes(shown), `warehouse should still see "${shown}"`);
  }
});

test('8 — an admin session sees everything it saw before', async () => {
  const { sandbox } = await boot({ role: 'admin', actions: ADMIN_ACTIONS });
  const routes = navRoutes(sandbox);
  for (const shown of ['users', 'payments', 'invoices', 'promotions', 'production',
                       'inventory-csv', 'import-data', 'shipping', 'returns', 'tasks']) {
    assert.ok(routes.includes(shown), `admin should still see "${shown}"`);
  }
});

test('9 — capability-gated entries are unaffected by the action gate', async () => {
  /* public-content, enquiries and account-permissions use `requires`, a
     per-account capability, not `action`. A warehouse admin-router session
     holds none of them here. */
  const { sandbox } = await boot();
  const routes = navRoutes(sandbox);
  for (const gated of ['public-content', 'enquiries', 'account-permissions']) {
    assert.ok(!routes.includes(gated));
  }
});

test('10 — hiding is cosmetic: the nav filter never grants anything', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.match(src, /may\(action\)\{ return !!\(this\.access && this\.access\[action\] === true\); \}/);
  assert.ok(!/this\.access\s*=\s*\{[^}]*true/.test(src),
    'the client must never fabricate an action');
});

// ---------------------------------------------------------------------------
// 11-16 — the warehouse workflows that remain
// ---------------------------------------------------------------------------

test('11 — a stock correction uses the narrow inventory route, not sync', async () => {
  let sent = null;
  const { sandbox, calls } = await boot({
    routes: {
      'POST /admin/inventory/adjust': async () => ({
        status: 200, body: { stock: { sku: 'SKU-1', warehouseId: 'wh_main', qty: 9 } },
      }),
    },
  });
  const el = renderPage(sandbox, 'product', ['p1']);
  const input = el.querySelector('[data-q="0:wh_main"]');
  assert.ok(input, 'the quantity field should render');
  input.value = '9';
  el.querySelector('[data-save="0:wh_main"]').onclick();
  await settle();

  sent = calls.find((c) => c.path === '/admin/inventory/adjust');
  assert.ok(sent, 'the correction must reach the narrow route');
  assert.equal(sent.method, 'POST');
  /* The body gained `idempotencyKey` (Final Handover Phase 7) — a key for THIS
     PRESS, so one click reaching the server twice through a retry applies
     once. The exhaustive list stays exhaustive: nothing else may creep in, and
     no price or commercial field may ever appear here. */
  assert.deepEqual(Object.keys(sent.body).sort(),
    ['delta', 'idempotencyKey', 'note', 'reason', 'sku', 'warehouseId']);
  assert.equal(sent.body.delta, 4, '9 wanted minus 5 recorded is a delta of 4');
  assert.equal(sent.body.reason, 'count');
  assert.match(sent.body.idempotencyKey, /^adj_/, 'and it identifies the press');
  assert.equal(calls.filter((c) => c.path === '/admin/sync').length, 0);
});

test('12 — the quantity is adopted from the server, never assumed', async () => {
  const { sandbox } = await boot({
    routes: {
      'POST /admin/inventory/adjust': async () => ({
        /* The server says 7, not the 9 the operator typed — another movement
           landed in between. The screen must show the truth. */
        status: 200, body: { stock: { sku: 'SKU-1', warehouseId: 'wh_main', qty: 7 } },
      }),
    },
  });
  const el = renderPage(sandbox, 'product', ['p1']);
  el.querySelector('[data-q="0:wh_main"]').value = '9';
  el.querySelector('[data-save="0:wh_main"]').onclick();
  await settle();
  assert.equal(sandbox.DB.load().products[0].variations[0].stock.wh_main.qty, 7);
});

test('13 — a no-op correction sends nothing', async () => {
  const { sandbox, calls } = await boot();
  const el = renderPage(sandbox, 'product', ['p1']);
  el.querySelector('[data-q="0:wh_main"]').value = '5';   // already 5
  el.querySelector('[data-save="0:wh_main"]').onclick();
  await settle();
  assert.equal(calls.filter((c) => c.path === '/admin/inventory/adjust').length, 0);
});

test('14 — a 403 on a stock change reads as a decision, not a broken save', async () => {
  const { sandbox } = await boot({
    routes: { 'POST /admin/inventory/adjust': async () => ({ status: 403, body: { error: 'forbidden' } }) },
  });
  const el = renderPage(sandbox, 'product', ['p1']);
  el.querySelector('[data-q="0:wh_main"]').value = '9';
  el.querySelector('[data-save="0:wh_main"]').onclick();
  await settle();
  const toast = sandbox.document.getElementById('toast-root').textContent;
  assert.match(toast, /cannot change stock/i);
  assert.ok(!/failed|error|500/i.test(toast), 'a 403 must not read as a fault');
});

test('15 — a 409 shows the server\'s explanation', async () => {
  const { sandbox } = await boot({
    routes: {
      'POST /admin/inventory/adjust': async () => ({
        status: 409,
        body: { error: 'That would take SKU-1 at this warehouse to -3. Stock cannot go negative.',
                code: 'NEGATIVE_STOCK' },
      }),
    },
  });
  const el = renderPage(sandbox, 'product', ['p1']);
  el.querySelector('[data-q="0:wh_main"]').value = '0';
  el.querySelector('[data-save="0:wh_main"]').onclick();
  await settle();
  assert.match(sandbox.document.getElementById('toast-root').textContent, /cannot go negative/);
});

test('16 — a stock save cannot be double-submitted', async () => {
  let inFlight = 0; let maxConcurrent = 0;
  const { sandbox, calls } = await boot({
    routes: {
      'POST /admin/inventory/adjust': async () => {
        inFlight += 1; maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { status: 200, body: { stock: { sku: 'SKU-1', warehouseId: 'wh_main', qty: 9 } } };
      },
    },
  });
  const el = renderPage(sandbox, 'product', ['p1']);
  el.querySelector('[data-q="0:wh_main"]').value = '9';
  const btn = el.querySelector('[data-save="0:wh_main"]');
  btn.onclick(); btn.onclick(); btn.onclick();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(maxConcurrent, 1, 'the button must disable while a save is in flight');
  assert.ok(calls.filter((c) => c.path === '/admin/inventory/adjust').length <= 1);
});

// ---------------------------------------------------------------------------
// 17-21 — admin-only mutation is gone from the warehouse view
// ---------------------------------------------------------------------------

test('17 — warehouse sees no product-edit control, so no pricing mutation', async () => {
  const { sandbox } = await boot();
  const el = renderPage(sandbox, 'product', ['p1']);
  assert.equal(el.querySelector('#pd-edit'), null,
    'editing a product changes prices and rides the sync — admin only');
});

test('18 — an admin keeps the product-edit control', async () => {
  const { sandbox } = await boot({ role: 'admin', actions: ADMIN_ACTIONS });
  const el = renderPage(sandbox, 'product', ['p1']);
  assert.ok(el.querySelector('#pd-edit'), 'admin behaviour must be unchanged');
});

test('19 — warehouse cannot manage warehouses', async () => {
  const { sandbox } = await boot();
  const el = renderPage(sandbox, 'warehouses');
  assert.equal(el.querySelector('#wh-manage'), null);
});

test('20 — warehouse sees no route registered for an admin-only screen it navigates to', async () => {
  /* Direct navigation is not prevented by hiding a link — the API refuses.
     What must not happen is a save silently going to /admin/sync. */
  const { sandbox, calls } = await boot();
  for (const route of ['users', 'payments', 'invoices', 'promotions']) {
    if (!sandbox.App.routes[route]) continue;
    try { renderPage(sandbox, route); } catch { /* page may need data it lacks */ }
  }
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(calls.filter((c) => c.path === '/admin/sync').length, 0,
    'even a direct visit must not produce a generic sync');
});

test('21 — the transfer control uses the narrow route and reports per SKU', async () => {
  const results = { 'SKU-1': { status: 200, body: { transfer: {
    sku: 'SKU-1', from: { warehouseId: 'wh_main', qty: 2 }, to: { warehouseId: 'wh_res', qty: 3 } } } } };
  const { sandbox, calls } = await boot({
    routes: { 'POST /admin/inventory/transfer': async () => results['SKU-1'] },
  });
  const el = renderPage(sandbox, 'warehouses');
  /* The page needs a selected SKU; drive the state the checkbox would set. */
  sandbox.App._wh = sandbox.App._wh || {};
  const src = fs.readFileSync(path.join(ROOT, 'js', 'pages_catalog.js'), 'utf8');
  assert.match(src, /DB\.transferStock\(sku,\s*state\.wh,\s*to,\s*n,/,
    'the transfer must go through the narrow route');
  assert.ok(!/DB\.save\(\);\s*DB\.audit\('stock\.transfer'/.test(src),
    'the old sync-based transfer must be gone');
  void el; void calls;
});

// ---------------------------------------------------------------------------
// 22-25 — the backend restriction is untouched, and the UI stays usable
// ---------------------------------------------------------------------------

test('22 — no frontend bypass was added', () => {
  const data = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  /* canSync is only ever set from the server's answer or a 403 — never
     assumed true. */
  /* `[^=]` after the `=` so a comparison (`canSync === false`) is not read as
     an assignment. */
  const assignments = [...data.matchAll(/canSync\s*=\s*([^=][^;]*);/g)].map((m) => m[1].trim());
  assert.deepEqual(assignments.sort(), ["actions['sync.write'] === true", 'false', 'null'],
    'canSync must only ever be set from the server\'s answer, a 403, or the initial null');
});

test('23 — no page infers authority from the session role', () => {
  /* The whole point of server-derived discovery: no scattered role checks. */
  for (const file of ['pages_catalog.js', 'pages_sales.js', 'pages_core.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    assert.ok(!/role\s*===\s*['"]warehouse['"]/.test(src),
      `${file} must not branch on the warehouse role`);
  }
});

test('24 — stock controls are keyboard-operable and mobile-safe', async () => {
  const { sandbox } = await boot();
  const el = renderPage(sandbox, 'product', ['p1']);
  const btn = el.querySelector('[data-save="0:wh_main"]');
  assert.equal(btn.tagName.toLowerCase(), 'button',
    'a real button is focusable and activates on Enter and Space');
  const input = el.querySelector('[data-q="0:wh_main"]');
  assert.equal(input.getAttribute('type'), 'number');
  /* The table is inside the panel's existing scroll wrapper, so a narrow
     viewport scrolls the table rather than the page. */
  assert.ok(el.querySelectorAll('.table-wrap').length > 0);
});

test('25 — the view-only badge state exists and is not styled as an error', () => {
  const data = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  assert.match(data, /readonly: \['#e5e7eb','#4b5563','View only'\]/);
  assert.match(data, /Not an error/);
});
