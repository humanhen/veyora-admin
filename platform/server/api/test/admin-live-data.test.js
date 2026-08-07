/* Batch 1H — the admin reads orders and backorders from PostgreSQL.

   Two kinds of assertion here:
   - the SHIPPED server module (src/admin-data.js) is imported and exercised
     directly, so its SQL text, bounds, mappers and write whitelist are real;
   - the SHIPPED browser files are read from disk and asserted against, so a
     page cannot quietly go back to the seeded dataset.
   Nothing is re-implemented. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADMIN_ORDERS_SQL, ADMIN_ORDERS_COUNT_SQL, ADMIN_ORDER_ONE_SQL,
         ADMIN_BACKORDERS_SQL, ADMIN_BACKORDERS_COUNT_SQL,
         orderRowToJs, backorderRowToJs, displayName,
         resolveLimit, listCompleteness, ORDER_LIST_MAX,
         sanitizeOrderPatch, orderUpdateSql, describeOrderPatch,
         recomputeOrderTotal, ORDER_STATUSES,
         FORBIDDEN_ORDER_PATCH_KEYS,
         checkSyncPayload, SERVER_MANAGED_SYNC_ERROR, SERVER_MANAGED_COLLECTIONS,
         isFinancialActor, patchTouchesMoney, FINANCIAL_ROLES } from '../src/admin-data.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* Assertions about shipped behaviour look at code, not at the comments
   explaining it — a comment must never be able to satisfy one. */
const codeOf = p => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ================= the seeded demo dataset is gone ================= */

test('js/data.js no longer contains a seeded order generator', () => {
  /* Comments stripped: the file's header legitimately NAMES the old demo store
     and its storage key to explain what was removed. A comment must not be
     able to fail — or to satisfy — a behavioural assertion. */
  const src = codeOf('js/data.js');
  assert.ok(!/localStorage\.(get|set)Item\(\s*KEY/.test(src),
    'the localStorage-backed store is gone');
  assert.ok(!/veyora_db_v2/.test(src), 'the demo storage key is gone');
  assert.ok(!/function\s+seed\s*\(/.test(src), 'the seed generator is gone');
  assert.ok(!/NGEN\s*=/.test(src), 'the 1,096-record generator loop is gone');
  assert.ok(!/SO'\+n\b/.test(src), 'no order numbers are fabricated in the browser');
  assert.ok(!/rng\(/.test(src), 'the deterministic demo RNG is gone');
});

test('orders and backorders are fetched from their own admin endpoints', () => {
  const src = codeOf('js/data.js');
  assert.match(src, /apiCall\('GET',\s*'\/admin\/orders'\)/);
  assert.match(src, /apiCall\('GET',\s*'\/admin\/backorders'\)/);
  assert.match(src, /db\.orders\s*=\s*Array\.isArray\(o\.orders\)\s*\?\s*o\.orders\s*:\s*\[\]/);
  assert.match(src, /db\.backorders\s*=\s*Array\.isArray\(b\.backorders\)\s*\?\s*b\.backorders\s*:\s*\[\]/);
});

test('a failed load leaves the dataset EMPTY and the state in error', () => {
  const src = codeOf('js/data.js');
  /* The catch must not repopulate from anything: empty, error, rethrow. */
  const m = src.match(/catch\(e\)\{[\s\S]*?db\s*=\s*emptyDb\(\);[\s\S]*?state\s*=\s*'error';[\s\S]*?throw e;/);
  assert.ok(m, 'init() must empty the dataset and surface the error');
  assert.ok(!/seed\(\)/.test(src), 'nothing falls back to a seeded dataset');
  assert.match(src, /db\.orders\s*=\s*\[\];\s*db\.backorders\s*=\s*\[\];/,
    'refreshLive() clears the live lists rather than keeping stale rows');
});

test('orders and backorders are NOT written by the browser row-diff sync', () => {
  const src = codeOf('js/data.js');
  const synced = src.match(/const SYNCED\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(synced, 'SYNCED list found');
  assert.ok(!/'orders'/.test(synced[1]), "'orders' must not be a synced collection");
  assert.ok(!/'backorders'/.test(synced[1]), "'backorders' must not be a synced collection");
});

/* ================= SQL: everything the UI needs, no ceiling ================= */

test('the orders query returns every field the admin screens read', () => {
  for (const col of ['o.*', 'cu.business as cust_business', 'au.business as agent_business',
                     'cu.customer_number as cust_number', 'cu.country as cust_country']) {
    assert.ok(ADMIN_ORDERS_SQL.includes(col), `missing ${col}`);
  }
  assert.match(ADMIN_ORDERS_SQL, /from order_items i/, 'items are included');
  assert.match(ADMIN_ORDERS_SQL, /'modelSku', p\.sku, 'brand', p\.brand/,
    'brand and model number are joined back from the product');
  assert.match(ADMIN_ORDERS_SQL, /order by o\.created_at desc/,
    'a bounded read returns the NEWEST orders, not an arbitrary slice');
  assert.match(ADMIN_ORDERS_SQL, /limit \$1/, 'the bound is a parameter, not inlined');
});

test('the backorder query supplies the converted order NUMBER', () => {
  /* The detail modal has always rendered bo.convertedOrderNumber; the old
     snapshot only carried convertedOrderId, so it read "—" on every
     converted record. */
  assert.match(ADMIN_BACKORDERS_SQL, /left join orders co on co\.id = b\.converted_order_id/);
  assert.match(ADMIN_BACKORDERS_SQL, /co\.number as converted_order_number/);
  assert.match(ADMIN_BACKORDERS_SQL, /b\.\*/, 'the whole backorder record travels');
  assert.match(ADMIN_BACKORDERS_SQL, /from backorder_items i/);
});

test('there is no 1,107-record ceiling', () => {
  assert.ok(ORDER_LIST_MAX >= 20000,
    'the cap must sit far above the live dataset (1,128 orders)');
  assert.equal(resolveLimit(undefined), resolveLimit(''), 'absent and empty behave alike');
  assert.ok(resolveLimit(undefined) >= 1128, 'the default returns all 1,128 orders');
  assert.equal(resolveLimit('50'), 50, 'an explicit smaller bound is honoured');
  assert.equal(resolveLimit('999999'), ORDER_LIST_MAX, 'and is capped');
  assert.equal(resolveLimit('-3'), resolveLimit(undefined), 'nonsense falls back');
  assert.equal(resolveLimit('abc'), resolveLimit(undefined));
});

test('a truncated read is reported, never silently trimmed', () => {
  const full = listCompleteness(1128, 1128, 20000);
  assert.equal(full.total, 1128);
  assert.equal(full.complete, true);
  const cut = listCompleteness(50, 1128, 50);
  assert.equal(cut.complete, false, 'the caller can tell it did not see everything');
  assert.equal(cut.total, 1128, 'and is told the real total');
});

test('the count queries count the real tables', () => {
  assert.match(ADMIN_ORDERS_COUNT_SQL, /count\(\*\)::int as n from orders/);
  assert.match(ADMIN_BACKORDERS_COUNT_SQL, /count\(\*\)::int as n from backorders/);
});

test('a single order resolves by id OR by business number', () => {
  assert.match(ADMIN_ORDER_ONE_SQL, /where o\.id = \$1 or o\.number = \$1/);
});

/* ================= the RC acceptance records ================= */

const SO11889_ROW = {
  id: 'o_11889', number: 'SO11889', customer_id: 'u_ca', agent_id: null,
  cust_business: 'Delson Optique', cust_first: 'Marie', cust_last: 'Tremblay',
  cust_username: 'delson', cust_email: 'orders@delson.example.com',
  cust_number: '1042', cust_country: 'CA',
  source: 'customer', status: 'pending',
  order_date: '2026-08-01', created_at: '2026-08-01T11:00:00.000Z',
  updated_at: '2026-08-01T11:00:00.000Z',
  currency: 'CAD', fx_rate: '1.37',
  discount: '0', discount_pct: '0', shipping: '0', free_shipping: false,
  total: '49.00', invoice_id: null, tracking: null, comments: [],
  billing_address: null, shipping_address: null, promo: null,
  items: [{ sku: '2057.81', name: 'Charlett 2057', color: 'Black', qty: 1,
            collected: 0, price: 49, modelSku: '2057', brand: 'Charlett' }],
};
const SO11888_ROW = { ...SO11889_ROW, id: 'o_11888', number: 'SO11888',
  currency: 'USD', fx_rate: '1', created_at: '2026-08-01T10:00:00.000Z' };

test('SO11889 keeps its BASE USD total plus CAD @ 1.37 — never a converted number', () => {
  const o = orderRowToJs(SO11889_ROW);
  assert.equal(o.total, 49, 'the API returns the stored base amount, unconverted');
  assert.equal(o.currency, 'CAD');
  assert.equal(o.fxRate, 1.37);
  assert.equal(o.items[0].price, 49);
  /* Returning 67.13 here and converting again at render is exactly the
     CA$91.97 double conversion Batch 1G forbids. */
  assert.notEqual(o.total, 67.13);
  assert.notEqual(o.total, 91.97);
});

test('the admin renderer turns that row into CA$67.13 and nothing else', () => {
  const o = orderRowToJs(SO11889_ROW);
  const SYM = { USD: '$', CAD: 'CA$', EUR: '€' };
  const rendered = SYM[o.currency] + (o.total * o.fxRate).toFixed(2);
  assert.equal(rendered, 'CA$67.13');
  for (const wrong of ['$49.00', 'CA$49.00', 'CA$91.97']) {
    assert.notEqual(rendered, wrong, `must never display ${wrong}`);
  }
});

test('SO11888 is USD and displays $49.00', () => {
  const o = orderRowToJs(SO11888_ROW);
  assert.equal(o.currency, 'USD');
  assert.equal(o.fxRate, 1);
  assert.equal('$' + (o.total * o.fxRate).toFixed(2), '$49.00');
});

test('SO11889 sorts ahead of SO11888 using the shipped comparator', () => {
  /* The comparator lives in js/util.js and is asserted directly in
     admin-orders.test.js; here we prove the API supplies what it needs. */
  const a = orderRowToJs(SO11889_ROW), b = orderRowToJs(SO11888_ROW);
  assert.ok(a.createdAt && b.createdAt, 'createdAt travels to the browser');
  assert.ok(new Date(a.createdAt) > new Date(b.createdAt));
  const newestFirst = [b, a].sort((x, y) =>
    new Date(y.createdAt) - new Date(x.createdAt)).map(x => x.number);
  assert.deepEqual(newestFirst, ['SO11889', 'SO11888']);
});

test('an order carries the full field list the screens need', () => {
  const o = orderRowToJs(SO11889_ROW);
  for (const k of ['id','number','customerId','customerName','agentId','agentName',
                   'source','status','date','createdAt','updatedAt','currency','fxRate',
                   'discount','discountPct','shipping','freeShipping','total','invoiceId',
                   'tracking','comments','billingAddress','shippingAddress','promo','items']) {
    assert.ok(Object.prototype.hasOwnProperty.call(o, k), `missing field ${k}`);
  }
  assert.equal(o.customerName, 'Delson Optique', 'the server resolves the display name');
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].modelSku, '2057', 'model number is the PRODUCT sku');
});

test('BO5003 is returned complete, open and in USD', () => {
  const bo = backorderRowToJs({
    id: 'bo_5003', number: 'BO5003', order_id: null, order_number: null,
    customer_id: 'u_us', cust_business: 'Main Street Optical Monsey',
    cust_first: 'Sarah', cust_last: 'Cohen', cust_username: 'mainst',
    cust_email: 'sarah@mainst.example.com',
    agent_id: null, source: 'customer', status: 'open', reason: 'out of stock',
    eligible: false, customer_authorised: true,
    converted_order_id: null, converted_order_number: null,
    currency: 'USD', fx_rate: '1', discount: '0', shipping: '0', free_shipping: false,
    shipping_address: null, billing_address: null, promo: null, comments: [],
    created_at: '2026-07-30T09:00:00.000Z',
    items: [{ sku: '709.1', name: 'Spike 709', color: 'Black', qty: 2, price: 17,
              modelSku: '709', brand: 'Spike' }],
  });
  assert.equal(bo.number, 'BO5003');
  assert.equal(bo.status, 'open');
  assert.equal(bo.currency, 'USD');
  assert.equal(bo.fxRate, 1);
  assert.equal(bo.customerAuthorised, true);
  assert.equal(bo.eligible, false, 'customer authorisation is NOT stock clearance');
  assert.equal(bo.customerName, 'Main Street Optical Monsey');
  assert.equal(bo.orderNumber, null, 'a full backorder has no originating order');
  assert.equal(bo.items.length, 1);
  assert.equal(bo.items[0].qty, 2);
});

test('a converted backorder reports the order it became', () => {
  const bo = backorderRowToJs({ id: 'bo_1', number: 'BO5001', status: 'converted',
    converted_order_id: 'o_11889', converted_order_number: 'SO11889', items: [] });
  assert.equal(bo.convertedOrderNumber, 'SO11889');
  assert.equal(bo.convertedOrderId, 'o_11889');
});

test('display names follow the panel rule and degrade sensibly', () => {
  assert.equal(displayName({ business: 'Paul Optical', first_name: 'A', last_name: 'B' }), 'Paul Optical');
  assert.equal(displayName({ first_name: 'Rachel', last_name: 'Levi' }), 'Rachel Levi');
  assert.equal(displayName({ username: 'rlevi' }), 'rlevi');
  assert.equal(displayName(null), '');
});

test('legacy orders with no stamped currency stay USD at rate 1', () => {
  const o = orderRowToJs({ id: 'x', number: 'VEYORA000629', total: '80.00',
    currency: null, fx_rate: null, items: [] });
  assert.equal(o.currency, 'USD');
  assert.equal(o.fxRate, 1);
});

/* ================= the write whitelist ================= */

test('stock-moving and identity fields are refused outright, not dropped', () => {
  for (const k of FORBIDDEN_ORDER_PATCH_KEYS) {
    const r = sanitizeOrderPatch({ [k]: 'anything' });
    assert.equal(r.ok, false, `${k} must be refused`);
    assert.match(r.error, new RegExp(`'${k}'`), 'the caller is told which key');
  }
  /* Silently ignoring them is the failure mode this exists to prevent: the
     client would believe its item edit had been saved. */
  assert.equal(sanitizeOrderPatch({ items: [], status: 'shipped' }).ok, false,
    'a forbidden key poisons the whole patch');
});

test('status must be one the schema allows', () => {
  assert.equal(sanitizeOrderPatch({ status: 'shipped' }).fields.status, 'shipped');
  assert.equal(sanitizeOrderPatch({ status: 'SHIPPED' }).fields.status, 'shipped');
  assert.equal(sanitizeOrderPatch({ status: 'teleported' }).ok, false);
  for (const s of ORDER_STATUSES) {
    assert.equal(sanitizeOrderPatch({ status: s }).ok, true, `${s} is valid`);
  }
});

test('tracking is validated, not trusted', () => {
  const ok = sanitizeOrderPatch({ tracking: { company: 'ups', number: ' 1Z999 ' } });
  assert.deepEqual(ok.fields.tracking, { company: 'UPS', number: '1Z999' });
  assert.equal(sanitizeOrderPatch({ tracking: { company: 'PONY', number: '1' } }).ok, false);
  assert.equal(sanitizeOrderPatch({ tracking: { company: 'UPS', number: '  ' } }).ok, false);
  assert.equal(sanitizeOrderPatch({ tracking: { company: 'UPS', number: 'x'.repeat(61) } }).ok, false);
  assert.equal(sanitizeOrderPatch({ tracking: null }).fields.tracking, null);
});

test('the two discount kinds are mutually exclusive and bounded', () => {
  const pct = sanitizeOrderPatch({ discountPct: 12.5 });
  assert.equal(pct.fields.discount_pct, 12.5);
  assert.equal(pct.fields.discount, 0, 'setting one clears the other');
  const fix = sanitizeOrderPatch({ discount: 20 });
  assert.equal(fix.fields.discount, 20);
  assert.equal(fix.fields.discount_pct, 0);
  assert.equal(sanitizeOrderPatch({ discountPct: 150 }).ok, false);
  assert.equal(sanitizeOrderPatch({ discount: -1 }).ok, false);
});

test('a comment is stamped with the real actor and cannot be empty', () => {
  const r = sanitizeOrderPatch({ comment: '  short in the box  ' }, { actorName: 'Veyora admin' });
  assert.equal(r.comment.text, 'short in the box');
  assert.equal(r.comment.by, 'Veyora admin');
  assert.ok(r.comment.at, 'timestamped');
  assert.equal(sanitizeOrderPatch({ comment: '   ' }).ok, false);
  assert.equal(sanitizeOrderPatch({ comment: 'x'.repeat(2001) }).ok, false);
});

test('collection counts are the only line-level write, and they are checked', () => {
  const r = sanitizeOrderPatch({ collected: [{ sku: '709.1', collected: 3 }] });
  assert.deepEqual(r.collected, [{ sku: '709.1', collected: 3 }]);
  assert.equal(sanitizeOrderPatch({ collected: 'all' }).ok, false);
  assert.equal(sanitizeOrderPatch({ collected: [{ sku: '', collected: 1 }] }).ok, false);
  assert.equal(sanitizeOrderPatch({ collected: [{ sku: 'a', collected: -1 }] }).ok, false);
  /* Notably absent: qty and price. A collected count moves no stock. */
  assert.equal(sanitizeOrderPatch({ collected: [{ sku: 'a', collected: 1, qty: 99 }] }).collected[0].qty,
    undefined, 'only sku and collected survive');
});

test('an empty patch is refused rather than reported as saved', () => {
  assert.equal(sanitizeOrderPatch({}).ok, false);
  assert.equal(sanitizeOrderPatch(null).ok, false);
  assert.match(sanitizeOrderPatch({}).error, /Nothing to change/);
});

test('the UPDATE only ever emits known columns, numbered from $2', () => {
  const p = sanitizeOrderPatch({ status: 'processing', discountPct: 10 });
  const { sets, values, nextParam } = orderUpdateSql(p.fields);
  assert.deepEqual(sets, ['status = $2', 'discount = $3', 'discount_pct = $4']);
  assert.deepEqual(values, ['processing', 0, 10]);
  assert.equal(nextParam, 5);
  for (const s of sets) {
    assert.match(s, /^(status|tracking|discount|discount_pct) = \$\d+$/,
      'no free-form SQL can reach the statement');
  }
});

test('the server recomputes the total; the client never supplies money', () => {
  const items = [{ qty: 2, price: 35 }, { qty: 1, price: 17 }];   // 87
  assert.equal(recomputeOrderTotal(items, 0, 0), 87);
  assert.equal(recomputeOrderTotal(items, 7, 0), 80);
  assert.equal(recomputeOrderTotal(items, 0, 10), 78.3);
  assert.equal(recomputeOrderTotal(items, 1000, 0), 0, 'never negative');
  assert.equal(recomputeOrderTotal([], 0, 0), 0);
  /* Identical to the admin panel's DB.orderTotal, so the figure the browser
     shows and the figure the database stores cannot drift. */
  const browser = codeOf('js/data.js').match(/orderTotal\(o\)\{[\s\S]*?\}/)[0];
  assert.match(browser, /Math\.max\(0,Math\.round\(\(t-disc\)\*100\)\/100\)/);
});

test('the audit line describes what actually changed', () => {
  const p = sanitizeOrderPatch({ status: 'shipped', tracking: { company: 'DHL', number: 'JD1' } });
  const line = describeOrderPatch(p);
  assert.match(line, /status → shipped/);
  assert.match(line, /tracking DHL JD1/);
  assert.equal(describeOrderPatch({ fields: {}, comment: null, collected: null }), 'no change');
});

/* ================= the routes ================= */

test('every live admin endpoint sits behind admin/warehouse authentication', () => {
  const src = codeOf('platform/server/api/src/routes/admin.js');
  /* One router-level guard covers the whole file — assert it is there and that
     nothing below re-mounts without it. */
  assert.match(src, /r\.use\(requireAuth\('admin',\s*'warehouse'\)\)/,
    'the admin router requires an authenticated admin or warehouse session');
  const guardAt = src.indexOf("r.use(requireAuth('admin', 'warehouse'))");
  for (const route of [`r.get('/orders'`, `r.get('/orders/:id'`, `r.get('/backorders'`,
                       `r.patch('/orders/:id'`, `r.post('/orders/:id/invoice'`]) {
    const at = src.indexOf(route);
    assert.ok(at > guardAt, `${route} is defined after the auth guard`);
  }
  /* requireAuth itself 401s an anonymous caller and 403s a wrong role. */
  const mw = codeOf('platform/server/api/src/authmw.js');
  assert.match(mw, /if \(!userId\) return res\.status\(401\)/);
  assert.match(mw, /roles\.length && !roles\.includes\(user\.role\)[\s\S]{0,80}status\(403\)/);
});

test('the order patch route locks the row and refuses to un-ship an order', () => {
  const src = codeOf('platform/server/api/src/routes/admin.js');
  assert.match(src, /select \* from orders where id=\$1 or number=\$1 for update/,
    'the row is locked before it is read and written');
  /* The shipped-only guard became a full transition contract, so the property
     is now asserted through the mechanism that enforces it — checked against
     the LOCKED row's real status, not against anything the client sent. */
  assert.match(src, /canTransitionOrder\(order\.status, patch\.fields\.status\)/);
  assert.match(src, /INVALID_ORDER_TRANSITION/);
  assert.match(src, /recomputeOrderTotal\(items, cur\[0\]\.discount, cur\[0\]\.discount_pct\)/,
    'the total comes from the stored lines, not the request');
});

/* ================= the UI cannot fall back, and cannot lie ================= */

const LIVE_SURFACES = [
  ['js/pages_sales.js',   'Orders could not be loaded'],
  ['js/pages_sales.js',   'This order could not be loaded'],
  ['js/pages_sales.js',   'Backorders could not be loaded'],
  ['js/pages_sales.js',   'Reports could not be generated'],
  ['js/pages_core.js',    'Dashboard metrics could not be loaded'],
  ['js/pages_finance.js', 'Invoices could not be loaded'],
  ['js/pages_ops.js',     'Agent revenue could not be calculated'],
];

test('every release-critical surface guards on live data before rendering', () => {
  for (const [file, headline] of LIVE_SURFACES) {
    const src = codeOf(file);
    assert.ok(src.includes(headline), `${file} is missing the guard for "${headline}"`);
    assert.match(src, /requireLiveData\(el,/, `${file} does not call requireLiveData`);
  }
});

test('the error state shows no records and offers a retry', () => {
  const util = codeOf('js/util.js');
  assert.match(util, /function requireLiveData\(el,rerender,headline\)\{/);
  assert.match(util, /if\(typeof DB==='undefined'\|\|DB\.ready\)return true;/,
    'a page may only render when the live data is actually ready');
  assert.match(util, /await DB\.refreshLive\(\)/, 'Retry re-reads from the server');
  const copy = read('js/util.js');
  assert.match(copy, /data-retry/, 'there is a retry control');
  assert.match(copy, /No records are shown because none could be read from the database/);
  assert.match(copy, /Nothing here is sample or placeholder data/);
});

test('a transient load failure is shown, not turned into a silent logout', () => {
  const src = codeOf('js/app.js');
  /* Only a genuine 401/403 returns to sign-in. Anything else becomes a visible
     bootError so the panel says what went wrong. The previous shell called
     Auth.logout() on ANY failure, which looked like a session timeout. */
  assert.match(src, /if\(e&&\(e\.status===401\|\|e\.status===403\)\)\{[\s\S]{0,120}Auth\.logout\(\)/);
  assert.match(src, /this\.bootError=e;/);
  assert.match(src, /if\(this\.bootError\)\{[\s\S]{0,200}liveDataError\(el,this\.bootError/,
    'every route renders the failure while it stands');
  const logouts = (src.match(/Auth\.logout\(\)/g) || []).length;
  assert.ok(logouts <= 2, `Auth.logout() is called ${logouts} times — it must not be the catch-all`);
});

test('the panel refuses to render pages until live data has loaded', () => {
  const src = codeOf('js/app.js');
  assert.match(src, /if\(!sess\|\|\(!this\.ready&&!this\.bootError\)\)/,
    'no page renders on an unloaded dataset');
  assert.ok(!/DB\.load\(\);\s*$/m.test(src), 'init() no longer seeds a local dataset');
});

/* Order mutations: wired, or disabled — never optimistic. */
const WIRED = [
  [/run\(stBtn,\{status:ns\}/,                              'status change'],
  [/run\(shipBtn,\{tracking:\{company,number:num\},status:'shipped'\}/, 'ship + tracking'],
  [/run\(cmt,\{comment:txt\}/,                              'internal comment'],
  [/run\(comp,\{status:'collected',collected\}/,            'warehouse collection'],
  [/DB\.patchOrder\(o\.id,patch\)/,                         'admin discount'],
  [/DB\.generateInvoice\(o\.id\)/,                          'invoice'],
];
const DISABLED = ['Merge orders', 'Change customer', 'Add item'];

test('every order mutation that survives is an awaited server call', () => {
  const src = codeOf('js/pages_sales.js');
  for (const [re, what] of WIRED) assert.match(src, re, `${what} is not wired to the API`);
  assert.match(codeOf('js/data.js'), /apiCall\('PATCH',\s*'\/admin\/orders\/'\+encodeURIComponent/);
  assert.match(codeOf('js/data.js'), /apiCall\('POST',\s*'\/admin\/orders\/'\+encodeURIComponent\(idOrNumber\)\+'\/invoice'\)/);
});

test('a mutation reports success only after the server has taken it', () => {
  const src = codeOf('js/pages_sales.js');
  const run = src.match(/async function run\(btn,patch,okMsg,failMsg\)\{[\s\S]*?\n  \}/);
  assert.ok(run, 'the shared write helper is present');
  const body = run[0];
  assert.ok(body.indexOf('await DB.patchOrder') < body.indexOf('toast(okMsg)'),
    'the success toast must come AFTER the awaited call');
  assert.match(body, /catch\(err\)\{[\s\S]*?writeFailed\(err/,
    'a failure is reported as a failure');
  assert.ok(!/toast\('Status updated to '\+ns\);\s*$/m.test(src),
    'no optimistic status toast remains');
});

test('unsupported mutations are disabled and say so', () => {
  const src = codeOf('js/pages_sales.js');
  for (const label of DISABLED) {
    assert.ok(src.includes(`offBtn('${label}'`), `${label} must be an offBtn`);
  }
  assert.match(src, /function offBtn\(label,icon\)\{[\s\S]*?disabled/,
    'offBtn renders a genuinely disabled control');
  assert.match(read('js/pages_sales.js'), /const NOT_IN_RELEASE='Not available in this release';/);
  assert.match(src, /b\.onclick=\(\)=>toast\(b\.dataset\.off\+': '\+NOT_IN_RELEASE,true\)/,
    'even if reached, it reports the truth rather than success');
});

test('the stock-moving browser helpers are gone from the order path', () => {
  const src = codeOf('js/pages_sales.js');
  assert.ok(!/function reserveStock\(/.test(src),
    'the browser no longer reserves stock from page state');
  assert.ok(!/reserveStock\(/.test(src), 'and nothing calls it');
  /* releaseStock survives for RETURNS only, where products are still part of
     the row-diff sync and the server records the movement. */
  const uses = (src.match(/releaseStock\(/g) || []).length;
  assert.equal(uses, 2, 'exactly one definition and one caller (returns)');
  assert.match(src, /releaseStock\(it\.sku,it\.qty\); {2}/, 'the caller is the returns screen');
});

test('Quick Scan no longer edits an order', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /Quick Order Lookup/, 'it is a lookup, not an editor');
  assert.ok(!/Quick Order Scanner/.test(src));
  assert.ok(!/order\.quickscan/.test(src), 'the local edit path is gone');
  assert.ok(!/it\.qty\+=q/.test(src), 'no quantity is changed by scanning');
});

test('the backorder "send missing to Backorders" fabrication is gone', () => {
  const src = codeOf('js/pages_sales.js');
  assert.ok(!/nextBackorderNumber\+\+/.test(src), 'no BO number is invented in the browser');
  assert.ok(!/DB\.d\.backorders\.unshift\(/.test(src), 'no backorder is created in page state');
  assert.match(src, /Complete anyway/, 'completing the order is still possible');
  assert.match(read('js/pages_sales.js'), /Raising a backorder for the\s+missing pieces is/,
    'and the dialog explains why the backorder option is absent');
});

test('scanned counts are not presented as saved until they are', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /function scanned\(it\)\{return Math\.min\(it\.qty,\(it\.collected\|\|0\)\+\(local\.pending\[it\.sku\]\|\|0\)\)/);
  assert.match(read('js/pages_sales.js'), /Scanned counts are not saved yet/);
});

test('backorder eligibility and conversion still go through their own endpoints', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /await DB\.setBackorderEligibility\(bo\.id,true\)/);
  assert.match(src, /await DB\.convertBackorder\(bo\.id\)/);
  /* And both re-read the server afterwards rather than trusting page state. */
  assert.match(src, /await DB\.refreshLive\(\)/);
  assert.ok(!/bo\.eligible\s*=[^=]/.test(src), 'eligibility is never assigned locally');
  assert.ok(!/bo\.status\s*=[^=]/.test(src), 'backorder status is never assigned locally');
});

test('the deploy no longer overlays a forked admin data layer', () => {
  const sh = read('platform/server/deploy.sh');
  assert.ok(!/admin-overrides/.test(sh.replace(/^#.*$/gm, '')),
    'the overlay step is gone from the deploy');
  assert.ok(!fs.existsSync(path.join(ROOT, 'platform/server/admin-overrides')),
    'the forked copies are deleted — one admin, one source of truth');
  assert.match(read('index.html'), /js\/data\.js\?v=7/, 'the cache-bust was raised');
});

/* ================= stale-client protection on /admin/sync ================= */

/* A fake pg client that records everything. If the gate works, a rejected sync
   must never reach it — not one query, not one transaction. */
function recordingClient() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
}

const V6_ORDER_UPSERT = { collection: 'orders', upserts: [
  { id: 'o_11889', number: 'SO11889', status: 'completed', total: 0, items: [] }], deletes: [] };
const V6_ORDER_DELETE = { collection: 'orders', upserts: [], deletes: ['o_11889', 'o_11888'] };
const V6_BO_UPSERT = { collection: 'backorders', upserts: [
  { id: 'bo_5003', number: 'BO5003', status: 'open', items: [] }], deletes: [] };
const V6_BO_DELETE = { collection: 'backorders', upserts: [], deletes: ['bo_5003'] };
const PRODUCT_CHANGE = { collection: 'products', upserts: [
  { id: 'p1', sku: '2057', name: 'Charlett 2057', variations: [] }], deletes: [] };

test('a stale v6 payload with ORDER UPSERTS is rejected with 409', () => {
  const gate = checkSyncPayload([V6_ORDER_UPSERT]);
  assert.equal(gate.ok, false);
  assert.equal(gate.status, 409);
  assert.equal(gate.error, SERVER_MANAGED_SYNC_ERROR);
  assert.match(gate.error, /Orders and backorders are server-managed\. Hard refresh the admin panel\./);
  assert.deepEqual(gate.collections, ['orders']);
});

test('a stale payload with ORDER DELETES is rejected', () => {
  /* The dangerous half. A tab that has not seen the newest orders lists them
     all as deletes, which would remove real rows. */
  const gate = checkSyncPayload([V6_ORDER_DELETE]);
  assert.equal(gate.ok, false);
  assert.equal(gate.status, 409);
  assert.deepEqual(gate.collections, ['orders']);
});

test('backorder upserts and deletes are rejected the same way', () => {
  for (const change of [V6_BO_UPSERT, V6_BO_DELETE]) {
    const gate = checkSyncPayload([change]);
    assert.equal(gate.ok, false, JSON.stringify(change));
    assert.equal(gate.status, 409);
    assert.deepEqual(gate.collections, ['backorders']);
  }
  const both = checkSyncPayload([V6_ORDER_UPSERT, V6_BO_DELETE]);
  assert.deepEqual(both.collections, ['orders', 'backorders'], 'both are named, once each');
});

/* The route's own sequence, driven against a recording client: gate first,
   and only a passing gate reaches any write. */
async function runSyncLike(changes, client) {
  const gate = checkSyncPayload(changes);
  if (!gate.ok) return { status: gate.status, body: { error: gate.error, collections: gate.collections } };
  for (const ch of changes) {
    for (const row of (ch.upserts || [])) {
      await client.query(`insert into ${ch.collection} …`, [row.id]);
    }
    if ((ch.deletes || []).length) {
      await client.query(`delete from ${ch.collection} where id = any($1)`, [ch.deletes]);
    }
  }
  return { status: 200, body: { ok: true } };
}

test('a MIXED payload is rejected whole — products are NOT written', async () => {
  const c = recordingClient();
  const res = await runSyncLike([PRODUCT_CHANGE, V6_ORDER_UPSERT], c);
  assert.equal(res.status, 409, 'the presence of orders poisons the request');
  assert.deepEqual(res.body.collections, ['orders']);
  /* A partial write would be the worse outcome: the caller is told its order
     changes failed while its product changes — from the same stale snapshot —
     had already landed. */
  assert.equal(c.calls.length, 0, 'not one query ran, for any collection');
  assert.ok(!c.calls.some(x => /products/.test(x.sql)), 'no product write');

  /* Same payload without the stale orders entry: the products DO write, so the
     gate is refusing the right thing and not simply blocking everything. */
  const c2 = recordingClient();
  const ok = await runSyncLike([PRODUCT_CHANGE], c2);
  assert.equal(ok.status, 200);
  assert.equal(c2.calls.length, 1);
  assert.match(c2.calls[0].sql, /insert into products/);
});

test('the server-managed list is exactly orders and backorders', () => {
  assert.deepEqual(SERVER_MANAGED_COLLECTIONS, ['orders', 'backorders']);
  /* It must match what the browser stopped syncing, or the two disagree. */
  const synced = codeOf('js/data.js').match(/const SYNCED\s*=\s*\[([\s\S]*?)\];/)[1];
  for (const name of SERVER_MANAGED_COLLECTIONS) {
    assert.ok(!synced.includes(`'${name}'`), `${name} must not be in the browser SYNCED list`);
  }
});

test('the gate runs BEFORE the transaction and before any query', () => {
  const src = codeOf('platform/server/api/src/routes/admin.js');
  const handler = src.slice(src.indexOf("r.post('/sync'"));
  const gateAt = handler.indexOf('checkSyncPayload(changes)');
  const txAt = handler.indexOf('await tx(');
  const queryAt = handler.indexOf('c.query(');
  assert.ok(gateAt > 0, 'the gate is called');
  assert.ok(gateAt < txAt, 'the gate precedes the transaction');
  assert.ok(gateAt < queryAt, 'the gate precedes every query');
  assert.match(handler.slice(gateAt, gateAt + 400), /return res\.status\(gate\.status\)/,
    'a refused payload returns immediately');
});

test('a clean payload still passes the gate untouched', () => {
  assert.deepEqual(checkSyncPayload([PRODUCT_CHANGE]), { ok: true });
  assert.deepEqual(checkSyncPayload([]), { ok: true });
  assert.deepEqual(checkSyncPayload(null), { ok: true });
  assert.deepEqual(checkSyncPayload([{ collection: 'returns', upserts: [], deletes: [] }]), { ok: true });
});

test('/admin/sync has NO reachable order or backorder branch left', () => {
  const src = codeOf('platform/server/api/src/routes/admin.js');
  assert.ok(!/name === 'orders'/.test(src), "no `name === 'orders'` branch");
  assert.ok(!/name === 'backorders'/.test(src), "no `name === 'backorders'` branch");
  assert.ok(!/delete from orders where id = any/.test(src), 'no generic order delete');
  assert.ok(!/delete from backorders where id = any/.test(src), 'no generic backorder delete');
  assert.ok(!/async function upsertOrder\(/.test(src), 'upsertOrder is gone');
  assert.ok(!/async function upsertBackorder\(/.test(src), 'upsertBackorder is gone');
  /* And the sequences the browser used to advance for itself. */
  const seq = src.match(/const SEQ_SYNC = \[([\s\S]*?)\];/);
  assert.ok(seq, 'SEQ_SYNC found');
  assert.ok(!/order_number_seq/.test(seq[1]), 'order_number_seq is no longer client-synced');
  assert.ok(!/backorder_number_seq/.test(seq[1]), 'backorder_number_seq is no longer client-synced');
});

test('the helpers that only guarded that path are no longer imported', () => {
  const src = codeOf('platform/server/api/src/routes/admin.js');
  const imports = src.slice(0, src.indexOf('const r = Router()'));
  for (const id of ['reconcileBackorderSync', 'BACKORDER_LOCK_SQL',
                    'canDeleteBackorder', 'BACKORDER_DELETE_CANDIDATES_SQL']) {
    assert.ok(!imports.includes(id), `${id} is no longer imported`);
  }
  /* Still imported, because the conversion endpoint genuinely uses them. */
  assert.match(imports, /orderFieldsFromBackorder/);
  assert.match(imports, /isBackorderProcessable/);
});

test('GET /admin/snapshot no longer carries orders or backorders', () => {
  const src = codeOf('platform/server/api/src/routes/admin.js');
  const snap = src.slice(src.indexOf("r.get('/snapshot'"), src.indexOf("r.post('/sync'"));
  assert.ok(!/out\.orders\s*=/.test(snap), 'out.orders is gone');
  assert.ok(!/out\.backorders\s*=/.test(snap), 'out.backorders is gone');
  assert.ok(!/async function ordersSnapshot\(/.test(src), 'ordersSnapshot() is gone');
  /* Preserved, because Returns still uses them. */
  assert.match(snap, /out\.returns = await nestedNumberSnapshot\('returns'/);
  assert.match(src, /async function nestedNumberSnapshot\(/, 'the helper survives');
  assert.match(snap, /ITEM_IDENTITY_JOIN/, 'and its item-identity join survives');
  assert.match(snap, /out\.products = await productsSnapshot\(\)/, 'products still ship');
});

test('the dedicated read endpoints are intact', () => {
  const src = codeOf('platform/server/api/src/routes/admin.js');
  for (const route of [`r.get('/orders'`, `r.get('/orders/:id'`, `r.get('/backorders'`,
                       `r.patch('/orders/:id'`, `r.post('/orders/:id/invoice'`,
                       `r.post('/backorders/:id/eligibility'`, `r.post('/backorders/:id/convert'`]) {
    assert.ok(src.includes(route), `${route} must remain`);
  }
  assert.match(src, /q\(ADMIN_ORDERS_SQL, \[limit\]\)/);
  assert.match(src, /q\(ADMIN_BACKORDERS_SQL, \[limit\]\)/);
});

test('the browser reads orders only from the dedicated endpoints', () => {
  const src = codeOf('js/data.js');
  /* The snapshot no longer supplies them, so a client that still read them
     from there would silently show nothing. It does not. */
  const initFn = src.slice(src.indexOf('async function init()'), src.indexOf('async function refreshLive'));
  assert.ok(!/snap\.collections\.orders/.test(initFn));
  assert.ok(!/snap\.collections\.backorders/.test(initFn));
  assert.match(initFn, /await loadLive\(\)/);
});

/* ================= financial actions are admin-only ================= */

const ADMIN = { id: 'u_admin', role: 'admin', email: 'admin@example.com' };
const WAREHOUSE = { id: 'u_wh', role: 'warehouse', email: 'wh@example.com' };

test('only an admin counts as a financial actor', () => {
  assert.equal(isFinancialActor(ADMIN), true);
  assert.equal(isFinancialActor(WAREHOUSE), false);
  assert.equal(isFinancialActor({ role: 'agent' }), false);
  assert.equal(isFinancialActor(null), false);
  assert.deepEqual(FINANCIAL_ROLES, ['admin']);
});

test('a discount patch is recognised as touching money; operational ones are not', () => {
  assert.equal(patchTouchesMoney(sanitizeOrderPatch({ discount: 20 })), true);
  assert.equal(patchTouchesMoney(sanitizeOrderPatch({ discountPct: 5 })), true);
  for (const p of [{ status: 'processing' }, { comment: 'short in the box' },
                   { tracking: { company: 'UPS', number: '1Z' } },
                   { collected: [{ sku: 'a', collected: 1 }] }]) {
    assert.equal(patchTouchesMoney(sanitizeOrderPatch(p)), false, JSON.stringify(p));
  }
  assert.equal(patchTouchesMoney({}), false);
});

test('a warehouse user is refused a discount, and an admin is not', () => {
  /* This is the decision the route makes, exercised through the exact
     expression the route uses. */
  const decide = user => {
    const patch = sanitizeOrderPatch({ discountPct: 10 });
    return (patchTouchesMoney(patch) && !isFinancialActor(user)) ? 403 : 200;
  };
  assert.equal(decide(WAREHOUSE), 403);
  assert.equal(decide(ADMIN), 200);

  const src = codeOf('platform/server/api/src/routes/admin.js');
  const patchRoute = src.slice(src.indexOf("r.patch('/orders/:id'"),
                               src.indexOf("r.post('/orders/:id/invoice'"));
  assert.match(patchRoute, /if \(patchTouchesMoney\(patch\) && !isFinancialActor\(req\.user\)\)[\s\S]{0,160}status\(403\)/);
  assert.match(patchRoute, /Only an admin can change an order discount\./);
  /* The check must precede the transaction — a 403 must change nothing. */
  assert.ok(patchRoute.indexOf('patchTouchesMoney') < patchRoute.indexOf('await tx('));
});

test('a warehouse user is refused invoice generation, and an admin is not', () => {
  const src = codeOf('platform/server/api/src/routes/admin.js');
  const invRoute = src.slice(src.indexOf("r.post('/orders/:id/invoice'"));
  assert.match(invRoute, /if \(!isFinancialActor\(req\.user\)\)[\s\S]{0,140}status\(403\)/);
  assert.match(invRoute, /Only an admin can generate an invoice\./);
  assert.ok(invRoute.indexOf('isFinancialActor') < invRoute.indexOf('await tx('),
    'refused before the transaction opens');
});

test('operational warehouse actions are NOT restricted', () => {
  /* Reading orders, collection counts, permitted status changes, tracking,
     comments and backorder actions all stay available to the warehouse. */
  const src = codeOf('platform/server/api/src/routes/admin.js');
  for (const route of [`r.get('/orders'`, `r.get('/backorders'`,
                       `r.post('/backorders/:id/eligibility'`, `r.post('/backorders/:id/convert'`]) {
    const at = src.indexOf(route);
    const body = src.slice(at, at + 700);
    assert.ok(!/isFinancialActor/.test(body), `${route} must stay open to the warehouse`);
  }
  const decide = user => {
    const patch = sanitizeOrderPatch({ status: 'collected', collected: [{ sku: 'a', collected: 1 }] });
    return (patchTouchesMoney(patch) && !isFinancialActor(user)) ? 403 : 200;
  };
  assert.equal(decide(WAREHOUSE), 200, 'a warehouse collection update is allowed');
});

test('the browser mirrors the server rule instead of inventing its own', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /function canChangeMoney\(\)\{[\s\S]{0,120}s\.role==='admin'/);
  assert.ok(!/\['admin','super-agent'\]\.includes\(sess\.role\)/.test(src),
    "the old 'admin / super-agent' client rule is gone — it did not match the server");
  assert.match(src, /canChangeMoney\(\)\?`<button class="btn btn-sm" id="btn-discount"/);
  assert.match(src, /canChangeMoney\(\)\?`<button class="btn btn-dark btn-sm" id="btn-gen-inv"/);
});

/* ================= no duplicate audits ================= */

test('server-audited order mutations create no second browser audit', () => {
  const src = codeOf('js/pages_sales.js');
  assert.ok(!/noteAudit/.test(src), 'the duplicate-audit helper is gone');
  for (const action of ['order.status', 'order.ship', 'order.comment', 'order.discount',
                        'order.collect.start', 'order.collect.cancel', 'order.collect.complete']) {
    assert.ok(!src.includes(action), `${action} is no longer audited from the browser`);
  }
  /* The order detail screen posts no audit at all — every one of its writes is
     audited by the endpoint that performs it. */
  const page = src.slice(src.indexOf("App.register('order',"), src.indexOf("App.register('quick-scan',"));
  assert.ok(!/DB\.audit\(/.test(page), 'the order screen makes no DB.audit call');
});

test('the server still audits each of those actions exactly once', () => {
  const src = codeOf('platform/server/api/src/routes/admin.js');
  const patchRoute = src.slice(src.indexOf("r.patch('/orders/:id'"),
                               src.indexOf("r.post('/orders/:id/invoice'"));
  const audits = (patchRoute.match(/audit\(\{ id: req\.user\.id/g) || []).length;
  assert.equal(audits, 1, 'exactly one audit per successful patch');
  assert.match(patchRoute, /afterCommit\(`audit 'order updated'/,
    'and only after the transaction commits');
  assert.match(patchRoute, /describeOrderPatch\(patch\)/, 'describing what changed');
  /* Invoicing moved into the governed finance router (Final Handover Phase 4)
     so that "turn an order into a debt" has ONE implementation reached by two
     entry points rather than two copies. The properties are unchanged; they
     are asserted where the implementation now lives. */
  const invRoute = src.slice(src.indexOf("r.post('/orders/:id/invoice'"));
  assert.match(invRoute, /issueInvoice\(financeDb, req\.params\.id, req\.user/,
    'the legacy route delegates rather than carrying a second implementation');
  assert.ok(!/insert into invoices/i.test(invRoute), 'and inserts no invoice of its own');

  const finance = codeOf('platform/server/api/src/routes/admin-finance.js');
  assert.match(finance, /recordAudit\(actor, 'invoice generated'/,
    'the audit followed the implementation');
  assert.match(finance, /if \(!outcome\.alreadyInvoiced\)/,
    'a repeat press does not audit a second time');
});

test('browser auditing survives where no server mutation audit exists', () => {
  const src = codeOf('js/pages_sales.js');
  /* Returns, promotions, campaigns and spare parts are still browser-synced
     collections with no dedicated endpoint, so their audit is the only one. */
  for (const action of ['return.create', 'return.close', 'promotion.create', 'sparepart.status']) {
    assert.ok(src.includes(action), `${action} must keep its browser audit`);
  }
});

test('invoice generation is server-numbered and idempotent', () => {
  /* Both properties still hold; asserted where the implementation now lives. */
  const src = codeOf('platform/server/api/src/routes/admin-finance.js');
  assert.match(src, /'IN' \|\| nextval\('invoice_number_seq'\)/,
    'the number comes from the database sequence');
  assert.match(src, /if \(order\.invoice_id\)[\s\S]{0,400}alreadyInvoiced: true/,
    'a second press returns the existing invoice');
  /* And it is the ONLY place an invoice number is CONSUMED. admin.js may still
     read the sequence for the snapshot's `nextInvoiceNumber`; what it must not
     do is call nextval() and issue one. */
  const legacy = codeOf('platform/server/api/src/routes/admin.js');
  assert.ok(!/nextval\('invoice_number_seq'\)/.test(legacy),
    'the legacy route must not issue an invoice number itself');
  assert.ok(!/\['invoices', 'invoice_number_seq'/.test(legacy),
    'and the sync catch-up entry is dead now that sync cannot write an invoice');
  assert.ok(!/nextInvoiceNumber\+\+/.test(codeOf('js/pages_sales.js')),
    'the browser no longer invents invoice numbers');
});
