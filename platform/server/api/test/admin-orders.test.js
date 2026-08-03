/* Batch 1G — admin order currency, sorting and backorder presentation.

   js/util.js is a plain browser script, so it is loaded into a node:vm sandbox
   and the SHIPPED helpers are called. The admin page markup and handlers are
   asserted against the real source files, not against re-implementations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const readAdmin = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
/* Copy/markup assertions look at code, not at the comments explaining it. */
const codeOf = p => readAdmin(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** Load the real js/util.js and return its helpers. */
function loadUtil() {
  const ctx = { console, document: { createElement: () => ({}) }, window: {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readAdmin('js/util.js'), ctx, { filename: 'util.js' });
  return ctx;
}
const U = loadUtil();

/* ============ TASK 1 — true chronological sorting ============ */

const LEGACY = { number: 'VEYORA000629', createdAt: '2025-03-11T09:00:00Z', date: '2025-03-11' };
const SO11888 = { number: 'SO11888', createdAt: '2026-08-01T10:00:00Z', date: '2026-08-01' };
const SO11889 = { number: 'SO11889', createdAt: '2026-08-01T11:00:00Z', date: '2026-08-01' };

const newest = list => [...list].sort((a, b) => U.compareOrdersByTime(a, b, true)).map(o => o.number);
const oldest = list => [...list].sort((a, b) => U.compareOrdersByTime(a, b, false)).map(o => o.number);

test('a 2025 legacy order does NOT appear before a 2026 SO order', () => {
  const mixed = [LEGACY, SO11888, SO11889];
  assert.deepEqual(newest(mixed), ['SO11889', 'SO11888', 'VEYORA000629']);
  // The old comparator sorted the NUMBER as a string, which put "VEYORA…" first.
  assert.ok('VEYORA000629' > 'SO11889', 'string order really is the wrong order');
});

test('"Oldest first" is the exact reverse', () => {
  assert.deepEqual(oldest([LEGACY, SO11888, SO11889]),
    ['VEYORA000629', 'SO11888', 'SO11889']);
});

test('sorting is independent of the input order', () => {
  const a = newest([LEGACY, SO11888, SO11889]);
  const b = newest([SO11889, LEGACY, SO11888]);
  const c = newest([SO11888, SO11889, LEGACY]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('equal timestamps are deterministic and stable', () => {
  const x = { number: 'SO2', createdAt: '2026-08-01T10:00:00Z' };
  const y = { number: 'SO1', createdAt: '2026-08-01T10:00:00Z' };
  assert.deepEqual(newest([x, y]), newest([y, x]), 'same result whatever the input order');
  assert.deepEqual(newest([x, y]), ['SO2', 'SO1']);
  assert.deepEqual(oldest([x, y]), ['SO1', 'SO2']);
});

test('createdAt wins over date when both exist', () => {
  const early = { number: 'A', createdAt: '2026-08-01T08:00:00Z', date: '2026-08-01' };
  const late = { number: 'B', createdAt: '2026-08-01T20:00:00Z', date: '2026-08-01' };
  assert.deepEqual(newest([early, late]), ['B', 'A'], 'same date, different time');
});

test('date is used when createdAt is absent', () => {
  const a = { number: 'A', date: '2025-01-01' };
  const b = { number: 'B', date: '2026-01-01' };
  assert.deepEqual(newest([a, b]), ['B', 'A']);
  assert.equal(U.orderTimestamp({ date: '2026-01-01' }) > 0, true);
});

test('undated rows sink to the bottom in BOTH directions', () => {
  const undated = { number: 'ZZZ' };
  assert.equal(newest([undated, SO11888]).at(-1), 'ZZZ');
  assert.equal(oldest([undated, SO11888]).at(-1), 'ZZZ',
    'an undated row must not masquerade as the oldest');
  assert.equal(U.orderTimestamp({}), null);
  assert.equal(U.orderTimestamp({ createdAt: 'not a date' }), null);
});

test('the orders page actually calls the chronological comparator', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /list\.sort\(\(a,b\)=>compareOrdersByTime\(a,b,state\.sort==='Newest first'\)\)/);
  assert.ok(!/state\.sort==='Newest first'\?\(b\.number>a\.number/.test(src),
    'the old order-number string sort is gone');
});

test('the date filters are untouched', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /state\.from/, 'From filter still applied');
  assert.match(src, /state\.to/, 'To filter still applied');
});

/* ============ TASK 2 — each order in its OWN stamped currency ============ */

const CAD_ORDER = { number: 'SO11889', total: 49, currency: 'CAD', fxRate: 1.37 };
const USD_ORDER = { number: 'SO11888', total: 49, currency: 'USD', fxRate: 1 };
const LEGACY_ORDER = { number: 'VEYORA000629', total: 49 };   // no stamps at all

test('the RC regression case: CAD order 49.00 @ 1.37 shows CA$67.13', () => {
  assert.equal(U.orderMoney(CAD_ORDER.total, CAD_ORDER), 'CA$67.13');
});

test('it never shows the base figure, the wrong symbol, or a double conversion', () => {
  const out = U.orderMoney(CAD_ORDER.total, CAD_ORDER);
  assert.notEqual(out, '$49.00', 'the base amount with a dollar sign');
  assert.notEqual(out, 'CA$49.00', 'the base amount mislabelled as CAD');
  assert.notEqual(out, 'CA$91.97', 'converted twice (49 x 1.37 x 1.37)');
});

test('converting an already-converted amount is what double conversion looks like', () => {
  const once = 49 * 1.37;
  assert.equal(U.orderMoney(once, CAD_ORDER), 'CA$91.97',
    'so callers must always pass the BASE amount — asserted by the call-site test below');
});

test('a USD order is unchanged', () => {
  assert.equal(U.orderMoney(USD_ORDER.total, USD_ORDER), '$49.00');
});

test('a legacy order with no currency or rate defaults to USD at rate 1', () => {
  assert.equal(U.orderMoney(LEGACY_ORDER.total, LEGACY_ORDER), '$49.00');
  assert.equal(U.orderMoney(49, {}), '$49.00');
  assert.equal(U.orderMoney(49, null), '$49.00');
  assert.equal(U.orderMoney(49, { currency: 'CAD' }), 'CA$49.00', 'missing rate = 1');
  assert.equal(U.orderMoney(49, { currency: 'CAD', fxRate: 0 }), 'CA$49.00', 'a zero rate is not applied');
});

test('line totals, discounts and shipping all use the order rate', () => {
  assert.equal(U.orderMoney(2 * 24.5, CAD_ORDER), 'CA$67.13', 'a line total');
  assert.equal(U.orderMoney(10, CAD_ORDER), 'CA$13.70', 'a discount');
  assert.equal(U.orderMoney(25, CAD_ORDER), 'CA$34.25', 'shipping');
  assert.equal(U.orderMoney(0, CAD_ORDER), 'CA$0.00');
});

test('EUR is supported and thousands are grouped', () => {
  assert.equal(U.orderMoney(100, { currency: 'EUR', fxRate: 0.92 }), '€92.00');
  assert.equal(U.orderMoney(10000, USD_ORDER), '$10,000.00');
});

test('the currency code helper backs the column headings', () => {
  assert.equal(U.orderCurrencyCode(CAD_ORDER), 'CAD');
  assert.equal(U.orderCurrencyCode(LEGACY_ORDER), 'USD');
  assert.equal(U.orderCurrencyCode(null), 'USD');
});

test('NO admin order surface still prints an order amount with plain money()', () => {
  const src = codeOf('js/pages_sales.js');
  const offenders = [
    /money\(o\.total\)/, /money\(x\.total\)/, /money\(DB\.orderTotal\(/,
    /money\(it\.qty\s*\*\s*it\.price\)/, /money\(invc\.amount\)/,
    /money\(price\)/,   // the Add Item confirmation toast
  ];
  for (const re of offenders) {
    assert.ok(!re.test(src), `an order amount still uses money(): ${re}`);
  }
});

test('the shipped order surfaces call orderMoney with the BASE amount', () => {
  const src = codeOf('js/pages_sales.js');
  for (const call of [
    /orderMoney\(o\.total,o\)/,                       // list total
    /orderMoney\(DB\.orderTotal\(o\),o\)/,            // headline + summary total
    /orderMoney\(it\.qty\*it\.price,o\)/,             // line total
  ]) assert.match(src, call, `missing ${call}`);
  /* The merge-order selection list and the Add Item toast also formatted an
     order amount. Batch 1H DISABLED both controls — they moved stock from
     browser state — so the right assertion is now that they are gone, not that
     they convert correctly. Their replacements are asserted below. */
  assert.ok(!/orderMoney\(x\.total,x\)/.test(src), 'the merge selection list is gone');
  assert.ok(!/orderMoney\(price,o\)/.test(src), 'the Add Item toast is gone');
  // nothing pre-multiplies by the rate before calling — that would double-convert
  assert.ok(!/orderMoney\([^)]*fxRate[^)]*\)/.test(src),
    'an amount was scaled by fxRate before being passed to orderMoney');
});

test('the invoice row shows its linked ORDER\'s currency', () => {
  const src = codeOf('js/pages_finance.js');
  assert.match(src, /orderMoney\(iv\.amount,\s*DB\.order\(iv\.orderId\)/);
  assert.ok(!/money\(iv\.amount\)/.test(src));
});

test('print output converts exactly once and is not double-converted', () => {
  const src = codeOf('js/pages_sales.js');
  // The print view builds its own pm() from the order's stamps.
  assert.match(src, /const rate=Number\(o\.fxRate\)\|\|1;/);
  assert.match(src, /const pm=base=>\(SYM\[cur\]\|\|'\$'\)\+\(\(Number\(base\)\|\|0\)\*rate\)/);
  assert.ok(!/pm\(orderMoney/.test(src) && !/orderMoney\(pm\(/.test(src),
    'print must not layer the two converters');
  // and it is fed base amounts
  assert.match(src, /pm\(it\.qty\*it\.price\)/);
  assert.match(src, /pm\(DB\.orderTotal\(o\)\)/);
});

/* ============ TASK 3 — self-explanatory search ============ */

test('the orders search placeholder explains what it searches', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /id="f-q" placeholder="Search order number, customer or email…"/);
  assert.ok(!/id="f-q" placeholder="Search here…"/.test(src));
});

test('the search matches number, customer and email — now against live data', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /o\.number\.toLowerCase\(\)\.includes\(q\)/);
  assert.match(src, /\(c\.business\|\|''\)\.toLowerCase\(\)\.includes\(q\)/);
  /* Batch 1H: the browser no longer holds a fabricated users table, so the
     customer name and email are the ones the SERVER resolved for the row, with
     the local user as a fallback. Searching only the local copy would fail to
     match a real customer the panel had not loaded. */
  assert.match(src, /name=DB\.orderCustomerName\(o\)/);
  assert.match(src, /email=o\.customerEmail\|\|c\.email\|\|''/);
  assert.match(src, /name\.toLowerCase\(\)\.includes\(q\)/);
  assert.match(src, /email\.toLowerCase\(\)\.includes\(q\)/);
});

/* ============ TASKS 4 & 5 — backorder headings and terminal state ============ */

const boHeader = () => {
  const m = codeOf('js/pages_sales.js').match(/<thead><tr><th>Backorder #[\s\S]*?<\/tr><\/thead>/);
  assert.ok(m, 'the backorder table header must exist');
  return m[0];
};

test('the two "Customer" columns are disambiguated', () => {
  const h = boHeader();
  assert.match(h, /<th>Customer<\/th>/);
  assert.match(h, /<th>Customer authorised<\/th>/);
  assert.equal((h.match(/<th>Customer<\/th>/g) || []).length, 1,
    'only ONE column may be labelled plain "Customer"');
});

test('the backorder table colspan matches its column count', () => {
  const cols = (boHeader().match(/<th>/g) || []).length;
  assert.equal(cols, 10);
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /colspan="10" class="empty-cell">No backorders found/);
});

test('a terminal backorder shows no "Stock cleared: Not yet"', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /function TERMINAL_BO\(b\)\{return !!b&&\(b\.status==='converted'\|\|b\.status==='cancelled'\|\|!!b\.convertedOrderId\);?\}/);
  assert.match(src, /TERMINAL_BO\(b\)\?'<span class="muted">—<\/span>'/, 'queue shows an em dash');
  assert.match(src, /TERMINAL_BO\(bo\)\?'<span class="muted">Not applicable<\/span>'/, 'detail says not applicable');
});

/** Mirrors the shipped TERMINAL_BO predicate for behavioural checks. */
const terminal = b => !!b && (b.status === 'converted' || b.status === 'cancelled' || !!b.convertedOrderId);

test('cancelled, converted and order-linked records are all terminal', () => {
  assert.equal(terminal({ status: 'cancelled' }), true);
  assert.equal(terminal({ status: 'converted', convertedOrderId: 'o_1' }), true);
  assert.equal(terminal({ status: 'open', convertedOrderId: 'o_1' }), true);
  assert.equal(terminal({ status: 'open' }), false);
  assert.equal(terminal({ status: 'approved' }), false);
});

test('presentation only — the stored eligibility value is never written', () => {
  const src = codeOf('js/pages_sales.js');
  assert.ok(!/TERMINAL_BO\([^)]*\)[^\n]*\.eligible\s*=/.test(src),
    'the terminal check must not assign eligibility');
  /* Batch 1C moved this to a dedicated server endpoint, so the browser no
     longer toggles eligibility in page state at all — stronger than merely
     not writing it from the terminal check. */
  assert.match(src, /DB\.setBackorderEligibility\(bo\.id,true\)/, 'the staff action still exists…');
  assert.ok(!/\bbo\.eligible\s*=[^=]/.test(src),
    'eligibility is never assigned in browser state');
  assert.match(src, /OPEN_BO\(b\)&&!b\.eligible\?/, '…and is still offered only on a live record');
});

test('terminal records are not made actionable', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /\$\{OPEN_BO\(b\)\?`<button class="btn btn-sm btn-dark" data-cv=/,
    'Convert is still gated on a non-terminal record');
});

/* ============ TASK 7 — dashboard USD labelling ============ */

test('revenue and AOV surfaces state the currency', () => {
  assert.match(codeOf('js/pages_core.js'), /REVENUE \(USD\)/);
  assert.match(codeOf('js/pages_core.js'), /\['Revenue \(USD\)','revenue'/);
  const sales = codeOf('js/pages_sales.js');
  assert.match(sales, /'Revenue \(USD\)','Average order value \(USD\)'/);
  assert.match(codeOf('js/pages_ops.js'), /<div class="page-title">Revenue \(USD\)<\/div>/);
});

test('dashboard totals are still summed in base USD, not converted per order', () => {
  const core = codeOf('js/pages_core.js');
  assert.ok(!/orderMoney/.test(core),
    'converting each order and summing would add mixed currencies together');
});

/* ============ Final micro-correction — the three remaining surfaces ============ */

test('Add Item is disabled rather than quoting a price it cannot save', () => {
  const src = codeOf('js/pages_sales.js');
  /* Batch 1G routed this toast through orderMoney so a CAD order quoted CAD.
     Batch 1H removed the control outright: adding a line reserves stock, there
     is no server endpoint for that, and with orders no longer part of the
     browser sync the edit would have changed nothing anywhere while still
     showing a confirmed price. A disabled control beats a lying one. */
  assert.ok(!/toast\('Item added at '/.test(src), 'no Add Item confirmation remains');
  assert.ok(!/o\.items\.push\(/.test(src), 'no order line is created in page state');
  assert.match(src, /offBtn\('Add item'/, 'the control is present but disabled');
});

test('no admin order item price is quoted with a bare money() anywhere', () => {
  const src = codeOf('js/pages_sales.js');
  for (const re of [/money\(price\)/, /money\(hit\.v\.price\)/, /money\(ex\.price\)/]) {
    assert.ok(!re.test(src), `an item price still uses plain money(): ${re}`);
  }
});

test('Reports → By Customer labels its aggregate column USD', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /case 'By Customer':return \['Customer','Orders','Amount \(USD\)','Frames'\]/);
  assert.ok(!/'Orders','Amount','Frames'/.test(src),
    'the unqualified "Amount" heading is gone');
  // Aggregates stay in base USD — they must NOT be converted per viewer.
  assert.match(src, /a\.revenue\+=o\.total/, 'the aggregate still sums the base total');
});

test('the fixed admin discount input is explicitly labelled USD', () => {
  const src = codeOf('js/pages_sales.js');
  assert.match(src, /<option value="fix">Fixed amount \(USD\)<\/option>/);
  assert.ok(!/Fixed amount \(\$\)/.test(src),
    'the bare $ label is gone — it read as the viewer\'s currency');
  // Labelling only: the stored value and the arithmetic are untouched.
  assert.match(src, /<option value="pct">Percentage \(%\)<\/option>/,
    'the percentage option is unchanged');
  assert.match(src, /id="ad-val"/, 'the value input is unchanged');
});
