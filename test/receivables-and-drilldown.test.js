/* Client feedback items K, L and M.

   K — dashboard tiles drill down to the screen behind the number
   L — the receivable as a whole: revenue, open, past due, future due, ageing
   M — backorders in the same design system as everything else

   `receivablesSummary()` is a pure calculation over admin rows, so it is
   loaded and CALLED. The two rendering items are asserted against the real
   shipped source. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOREFRONT = path.join(ROOT, 'platform', 'server', 'storefront');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ---------- load the pure calculation ---------- */

function loadAr() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/receivables.js'), ctx, { filename: 'receivables.js' });
  /* Results are round-tripped through JSON: an array built inside the vm has
     that realm's prototype, and deepEqual refuses to match it against a plain
     one — a failure that reads as a content mismatch and is not. */
  const lift = v => JSON.parse(JSON.stringify(v));
  return {
    receivablesSummary: (...args) => lift(ctx.receivablesSummary(...args)),
    DEFAULT_TERMS_DAYS: vm.runInContext('DEFAULT_TERMS_DAYS', ctx),
    SETTLED: lift(vm.runInContext('SETTLED_INVOICE_STATUSES', ctx)),
  };
}

const USERS = [
  { id: 'c1', role: 'customer', balance: '5000.00', paymentTerms: 30 },
  { id: 'c2', role: 'customer', balance: '1000.00', paymentTerms: 60 },
  { id: 'a1', role: 'agent', balance: '99999.00', paymentTerms: 30 },
];

/* Today is 2026-08-07 throughout. */
const TODAY = '2026-08-07';
const inv = (o) => ({ customerId: 'c1', amount: '1000.00', status: 'open', ...o });

/* ============ L — the figures ============ */

test('revenue counts everything invoiced; open AR counts only what is unsettled', () => {
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([
    inv({ amount: '1000.00', status: 'open' }),
    inv({ amount: '2000.00', status: 'paid' }),
    inv({ amount: '4000.00', status: 'open' }),
  ], USERS, TODAY);
  assert.equal(ar.revenue, 700000, 'billed, not collected');
  assert.equal(ar.openAr, 500000);
});

test('an unrecognised invoice status counts as OPEN, not as settled', () => {
  /* Under-stating a debt is the more dangerous error, so anything this build
     has never seen is treated as still owed. */
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([inv({ status: 'awaiting_something_new' })], USERS, TODAY);
  assert.equal(ar.openAr, 100000);
});

test('every settled status is honoured', () => {
  const { receivablesSummary, SETTLED } = loadAr();
  for (const status of SETTLED) {
    const ar = receivablesSummary([inv({ status })], USERS, TODAY);
    assert.equal(ar.openAr, 0, `${status} is not a receivable`);
    assert.equal(ar.revenue, 100000, 'but it was still invoiced');
  }
});

test('the status check is case-insensitive', () => {
  const { receivablesSummary } = loadAr();
  assert.equal(receivablesSummary([inv({ status: 'PAID' })], USERS, TODAY).openAr, 0);
});

test('past due and future due split open AR, and nothing else', () => {
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([
    inv({ issuedOn: '2026-06-01' }),          // c1, net 30 → due 01-07 → late
    inv({ issuedOn: '2026-08-01' }),          // due 31-08 → not yet
    inv({ amount: '500.00', status: 'paid', issuedOn: '2026-01-01' }),
  ], USERS, TODAY);
  assert.equal(ar.pastDue + ar.futureDue, ar.openAr, 'the split is exhaustive');
  assert.equal(ar.pastDue, 100000);
  assert.equal(ar.futureDue, 100000);
});

test("the due date uses the customer's own terms", () => {
  const { receivablesSummary } = loadAr();
  /* Same invoice date; c1 is net 30 and late, c2 is net 60 and not. */
  const ar = receivablesSummary([
    inv({ customerId: 'c1', issuedOn: '2026-06-20' }),
    inv({ customerId: 'c2', issuedOn: '2026-06-20' }),
  ], USERS, TODAY);
  assert.equal(ar.pastDue, 100000, 'c1 at net 30 is late');
  assert.equal(ar.futureDue, 100000, 'c2 at net 60 is not');
});

test('a customer with no terms is aged on the default, and the count is reported', () => {
  /* A silent default applied to a hundred accounts would make the ageing look
     precise when it is a guess. */
  const { receivablesSummary, DEFAULT_TERMS_DAYS } = loadAr();
  assert.equal(DEFAULT_TERMS_DAYS, 30);
  const users = [{ id: 'x', role: 'customer', balance: '0', paymentTerms: null }];
  const ar = receivablesSummary([
    { customerId: 'x', amount: '100.00', status: 'open', issuedOn: '2026-06-01' },
  ], users, TODAY);
  assert.equal(ar.assumedTerms, 1);
  assert.equal(ar.pastDue, 10000, 'aged as net 30');
});

test('an invoice for an unknown customer is still counted, on default terms', () => {
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([inv({ customerId: 'ghost', issuedOn: '2026-06-01' })], USERS, TODAY);
  assert.equal(ar.openAr, 100000, 'a debt does not vanish with its customer record');
  assert.equal(ar.assumedTerms, 1);
});

test('an invoice with no usable date is counted but not aged, and says so', () => {
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([
    inv({ issuedOn: null }),
    inv({ issuedOn: 'not-a-date' }),
  ], USERS, TODAY);
  assert.equal(ar.openAr, 200000, 'still owed');
  assert.equal(ar.undatable, 2, 'and the ageing is not presented as complete');
});

test('the ageing buckets are exhaustive and sum to open AR', () => {
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([
    inv({ issuedOn: '2026-08-05' }),   // not yet due
    inv({ issuedOn: '2026-07-01' }),   // due 31-07 → 7 days late
    inv({ issuedOn: '2026-06-01' }),   // due 01-07 → 37
    inv({ issuedOn: '2026-05-01' }),   // due 31-05 → 68
    inv({ issuedOn: '2026-01-01' }),   // due 31-01 → 188
  ], USERS, TODAY);
  const summed = Object.values(ar.ageing).reduce((a, b) => a + b, 0);
  assert.equal(summed, ar.openAr, 'every open invoice lands in exactly one bucket');
  assert.deepEqual(
    ar.buckets.map(b => ar.ageing[b.key]),
    [100000, 100000, 100000, 100000, 100000]);
});

test('an invoice due today is not yet late', () => {
  /* Off-by-one at the boundary is the classic way an ageing report starts
     chasing customers a day early. */
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([inv({ issuedOn: '2026-07-08' })], USERS, TODAY);
  assert.equal(ar.pastDue, 0, 'due exactly today');
  assert.equal(ar.ageing.current, 100000);

  const late = receivablesSummary([inv({ issuedOn: '2026-07-07' })], USERS, TODAY);
  assert.equal(late.pastDue, 100000, 'one day past');
  assert.equal(late.ageing.d1_30, 100000);
});

test('the ledger total counts customers only, never agents', () => {
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([], USERS, TODAY);
  assert.equal(ar.totalAr, 600000, "an agent's balance is not a receivable");
});

test('the gap between the ledger and the open invoices is reported, not hidden', () => {
  /* When they differ it is usually unapplied cash or an unmatched credit —
     the thing most worth seeing. Picking one silently would hide it. */
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([inv({ amount: '4500.00' })], USERS, TODAY);
  assert.equal(ar.openAr, 450000);
  assert.equal(ar.totalAr, 600000);
  assert.equal(ar.unreconciled, 150000);
});

test('money never goes through a float', () => {
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([
    inv({ amount: '29.97' }), inv({ amount: '0.10' }), inv({ amount: '0.20' }),
  ], USERS, TODAY);
  assert.equal(ar.revenue, 3027, 'exact cents');
  assert.ok(!/parseFloat/.test(strip(read('js/receivables.js'))));
});

test('an empty ledger produces zeroes, not NaN', () => {
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([], [], TODAY);
  for (const [k, v] of Object.entries(ar)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} is finite`);
  }
  assert.equal(ar.openAr, 0);
  assert.deepEqual(ar.worst, []);
  assert.equal(receivablesSummary(null, null, TODAY).openAr, 0, 'and null is survivable');
});

test('the worst offenders are ordered by how late they are', () => {
  const { receivablesSummary } = loadAr();
  const ar = receivablesSummary([
    inv({ number: 'A', issuedOn: '2026-07-01' }),
    inv({ number: 'B', issuedOn: '2026-01-01' }),
    inv({ number: 'C', issuedOn: '2026-08-06' }),
  ], USERS, TODAY);
  assert.deepEqual(ar.worst.map(w => w.number), ['B', 'A'], 'and C is not late at all');
});

/* ============ L — it is rendered ============ */

test('the receivable is shown on the Collection page', () => {
  const page = read('js/pages_finance.js');
  assert.match(page, /receivablesSummary\(d\.invoices, d\.users, todayISO\(\)\)/);
  for (const label of ['REVENUE INVOICED', 'OPEN AR', 'PAST DUE', 'FUTURE DUE',
    'TOTAL AR (LEDGER)', 'Ageing']) {
    assert.ok(page.includes(label), `the page shows ${label}`);
  }
});

test('the calculation is loaded before any page that calls it', () => {
  const html = read('index.html');
  const srcs = [...html.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
  assert.ok(srcs.includes('js/receivables.js'));
  assert.ok(srcs.indexOf('js/receivables.js') < srcs.indexOf('js/pages_finance.js'),
    'it is called during render, so it must already exist');
});

/* ============ K — the tiles lead somewhere ============ */

test('a tile with a destination is an anchor, not a div with a handler', () => {
  /* Anchors are focusable, announced as links, and ctrl/middle-click work. */
  const core = read('js/pages_core.js');
  const fn = core.slice(core.indexOf('function statCard('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /<a class="stat-card stat-link" href="#\/\$\{to\}"/);
  assert.match(body, /: `<div class="stat-card">/, 'and a tile without one stays a div');
});

test('every dashboard tile destination is a real admin route', () => {
  const core = read('js/pages_core.js');
  const app = read('js/app.js');
  const routes = new Set([...app.matchAll(/route:'([a-z-]+)'/g)].map(m => m[1]));
  const targets = [...core.matchAll(/to: '([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(targets.length >= 8, `expected several drill-downs, found ${targets.length}`);
  for (const t of new Set(targets)) {
    assert.ok(routes.has(t), `a tile points at #/${t}, which is not a route`);
  }
});

test('the tile with no screen behind it does not pretend to have one', () => {
  /* Abandoned-cart tracking does not exist. A tile leading somewhere unrelated
     would be worse than one that leads nowhere. */
  const core = read('js/pages_core.js');
  const at = core.indexOf("label: 'ACTIVE CARTS'");
  assert.ok(at > 0, 'the tile is still there');
  const tile = core.slice(at, core.indexOf('})}', at));
  assert.ok(!/to:/.test(tile), 'it is not a link');
  assert.match(tile, /not yet available/, 'and it says why');
});

test('the AR tiles drill down too', () => {
  const finance = read('js/pages_finance.js');
  assert.match(finance, /label: 'OPEN AR'[\s\S]{0,120}to: 'invoices'/);
  assert.match(finance, /label: 'TOTAL AR \(LEDGER\)'[\s\S]{0,120}to: 'payments'/);
});

/* ============ M — backorders in the same design system ============ */

const sf = p => fs.readFileSync(path.join(STOREFRONT, p), 'utf8');

test('backorder lines use the same renderer as order lines', () => {
  const page = sf('js/pages_orders.js');
  assert.match(page, /\$\{b\.items\.map\(i => orderLineRow\(i, b, hide\)\)/,
    'one renderer, so the two screens cannot drift apart');
  assert.ok(!/\$\{b\.items\.map\(i => `<tr>/.test(page),
    'the hand-rolled duplicate is gone');
});

test('backorders show the stamped delivery address', () => {
  const page = sf('js/pages_orders.js');
  assert.match(page, /stampedAddress\(b\.shippingAddress, 'To be delivered to'\)/,
    'a backorder ships later, which is exactly when a stale address would bite');
});

test('no storefront screen uses the browser\'s own confirm dialog', () => {
  /* window.confirm renders the BROWSER's dialog: it carries the page URL,
     cannot be styled, and on a phone it is a system sheet that looks nothing
     like the portal. */
  for (const file of fs.readdirSync(path.join(STOREFRONT, 'js')).filter(f => f.endsWith('.js'))) {
    const code = strip(sf(`js/${file}`));
    assert.ok(!/(^|[^.\w])confirm\s*\(/.test(code),
      `js/${file} still calls window.confirm`);
  }
});

test('the in-portal confirm defaults to the safe answer', () => {
  const ui = sf('js/ui.js');
  const fn = ui.slice(ui.indexOf('function confirmModal('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /\[data-no\]'\)\.focus\(\)/,
    'Cancel takes focus, so a reflex Enter does not confirm a deletion');
  assert.match(body, /back\.querySelector\('\.close'\)\.onclick = \(\) => finish\(false\)/,
    'closing is declining');
  assert.match(body, /if \(e\.target === back\) finish\(false\)/,
    'and so is clicking away');
  assert.match(body, /let done = false;/, 'it resolves exactly once');
});

test('the destructive choice is marked as destructive', () => {
  const ui = sf('js/ui.js');
  assert.match(ui, /danger \? ' danger' : ''/);
  assert.match(fs.readFileSync(path.join(STOREFRONT, 'css', 'store.css'), 'utf8'),
    /\.btn\.danger\{/);
  const orders = sf('js/pages_orders.js');
  assert.match(orders, /confirmLabel: 'Cancel backorder', danger: true/);
});
