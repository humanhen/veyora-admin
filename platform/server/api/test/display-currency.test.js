/* Display currency.

   Money is STORED in base USD; what varies is the currency a transaction was
   struck in and the rate stamped on it. Two rules follow, and both were broken:
     - while ordering for a customer, the screen must use THEIR currency;
     - a historical order must render in ITS OWN currency, not whichever one the
       current viewer happens to be configured for.

   The storefront's money()/effectiveFx() are browser globals, so the same
   formatting rule is reproduced here against the same inputs the server sends. */
import test from 'node:test';
import assert from 'node:assert/strict';

const CURRENCY_SYMBOLS = { USD: '$', CAD: 'CA$', EUR: '€' };

/** Mirrors ui.js fxContext(). */
function fxContext(src) {
  if (!src) return { currency: 'USD', rate: 1, symbol: '$' };
  const currency = String(src.currency || 'USD').toUpperCase();
  return {
    currency,
    rate: Number(src.rate ?? src.fxRate) || 1,
    symbol: src.symbol || CURRENCY_SYMBOLS[currency] || '$',
  };
}
/** Mirrors ui.js effectiveFx(): the target's money wins while assisting. */
function effectiveFx(store) {
  if (store.actingFor && store.orderingFx) return fxContext(store.orderingFx);
  return fxContext(store.fx);
}
/** Mirrors ui.js money(n, fx). */
function money(n, fx, store) {
  if (n == null) return '—';
  const c = fx ? fxContext(fx) : effectiveFx(store);
  return c.symbol + (Number(n) * c.rate).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const USD = { currency: 'USD', rate: 1, symbol: '$' };
const CAD = { currency: 'CAD', rate: 1.37, symbol: 'CA$' };
const EUR = { currency: 'EUR', rate: 0.92, symbol: '€' };

/* ---------------- assisted ordering ---------------- */

test('USD agent ordering for a CAD customer sees CAD', () => {
  const store = { fx: USD, actingFor: { id: 'u_dana' }, orderingFx: CAD };
  assert.equal(money(100, null, store), 'CA$137.00');
  assert.equal(effectiveFx(store).currency, 'CAD');
});

test('CAD agent ordering for a USD customer sees USD', () => {
  const store = { fx: CAD, actingFor: { id: 'u_rey' }, orderingFx: USD };
  assert.equal(money(100, null, store), '$100.00',
    'the actor\'s own CAD rate must not bleed into the customer\'s order');
  assert.equal(effectiveFx(store).currency, 'USD');
});

test('clearing the target restores the actor\'s own currency', () => {
  const store = { fx: CAD, actingFor: { id: 'u_rey' }, orderingFx: USD };
  assert.equal(money(100, null, store), '$100.00');
  store.actingFor = null; store.orderingFx = null;      // setActingFor(null)
  assert.equal(money(100, null, store), 'CA$137.00', 'back to the agent\'s own money');
});

test('switching target swaps the currency and never keeps the previous rate', () => {
  const store = { fx: USD, actingFor: { id: 'u_dana' }, orderingFx: CAD };
  assert.equal(money(100, null, store), 'CA$137.00');
  // setActingFor() drops orderingFx; the next priced response supplies the new one.
  store.actingFor = { id: 'u_paris' }; store.orderingFx = null;
  assert.equal(money(100, null, store), '$100.00',
    'falls back to the actor until the server states the new customer\'s currency');
  store.orderingFx = EUR;
  assert.equal(money(100, null, store), '€92.00');
});

test('an actor with no assisted context is unaffected', () => {
  const store = { fx: EUR, actingFor: null, orderingFx: null };
  assert.equal(money(100, null, store), '€92.00');
});

test('a stale orderingFx is ignored once the target is cleared', () => {
  const store = { fx: USD, actingFor: null, orderingFx: CAD };
  assert.equal(money(100, null, store), '$100.00',
    'actingFor gates the override, so a leftover rate cannot apply');
});

/* ---------------- historical orders ---------------- */

test('each order renders in its OWN stamped currency', () => {
  // An agent's order list mixes customers; the viewer's global context is USD.
  const store = { fx: USD, actingFor: null, orderingFx: null };
  const orders = [
    { number: 'SO1', total: 100, currency: 'USD', fxRate: 1 },
    { number: 'SO2', total: 100, currency: 'CAD', fxRate: 1.37 },
    { number: 'SO3', total: 100, currency: 'EUR', fxRate: 0.92 },
  ];
  assert.deepEqual(orders.map(o => money(o.total, o, store)),
    ['$100.00', 'CA$137.00', '€92.00']);
});

test('an order keeps its stamped rate even if the current rate has moved', () => {
  const store = { fx: { currency: 'CAD', rate: 1.55, symbol: 'CA$' }, actingFor: null };
  const order = { total: 100, currency: 'CAD', fxRate: 1.37 };   // struck at 1.37
  assert.equal(money(order.total, order, store), 'CA$137.00',
    'the transaction is reproducible; today\'s rate does not rewrite history');
});

test('a backorder renders in the currency it was recorded in', () => {
  const store = { fx: USD, actingFor: null };
  const bo = { number: 'BO5001', currency: 'EUR', fxRate: 0.92 };
  assert.equal(money(120, bo, store), '€110.40');
});

test('an order with no stamped currency falls back to base USD', () => {
  const store = { fx: CAD, actingFor: null };
  assert.equal(money(100, { total: 100 }, store), '$100.00');
});

/* ---------------- print document ---------------- */

/** Mirrors the Print order view's formatter in js/pages_sales.js. */
function printMoney(base, order) {
  const cur = (order.currency || 'USD').toUpperCase();
  const rate = Number(order.fxRate) || 1;
  return (CURRENCY_SYMBOLS[cur] || '$') + ((Number(base) || 0) * rate).toFixed(2);
}

test('print output does not hardcode USD "$" for a non-USD order', () => {
  const order = { currency: 'CAD', fxRate: 1.37 };
  const out = printMoney(270, order);
  assert.equal(out, 'CA$369.90');
  assert.ok(!/^\$/.test(out), 'a CAD order must not print a bare dollar sign');
  assert.ok(!out.includes('270.00'),
    'and must not show the unconverted base amount labelled as the customer currency');
});

test('print output covers USD, CAD and EUR consistently', () => {
  assert.equal(printMoney(100, { currency: 'USD', fxRate: 1 }), '$100.00');
  assert.equal(printMoney(100, { currency: 'CAD', fxRate: 1.37 }), 'CA$137.00');
  assert.equal(printMoney(100, { currency: 'EUR', fxRate: 0.92 }), '€92.00');
});

test('print falls back safely on a missing or broken rate', () => {
  assert.equal(printMoney(100, {}), '$100.00');
  assert.equal(printMoney(100, { currency: 'CAD', fxRate: 0 }), 'CA$100.00');
  assert.equal(printMoney(null, { currency: 'CAD', fxRate: 1.37 }), 'CA$0.00');
});

/* ---------------- admin backorder surfaces (Batch 1C, Task 10) ---------------- */

/** Mirrors js/util.js moneyIn(n, doc) — money belonging to a DOCUMENT. */
function moneyIn(n, doc) {
  const cur = ((doc && doc.currency) || 'USD').toUpperCase();
  if (n == null || isNaN(n)) return (CURRENCY_SYMBOLS[cur] || '$') + '—';
  const rate = Number(doc && doc.fxRate) || 1;
  return (CURRENCY_SYMBOLS[cur] || '$') + (Number(n) * rate).toFixed(2);
}

test('admin backorder queue and detail use the BACKORDER\'s currency', () => {
  const bo = { currency: 'CAD', fxRate: 1.37 };
  assert.equal(moneyIn(90, bo), 'CA$123.30', 'line price');
  assert.equal(moneyIn(270, bo), 'CA$369.90', 'line total / queue value');
  assert.ok(!moneyIn(90, bo).startsWith('$'), 'never the admin viewer\'s dollars');
});

test('admin backorder money covers USD, CAD and EUR', () => {
  assert.equal(moneyIn(100, { currency: 'USD', fxRate: 1 }), '$100.00');
  assert.equal(moneyIn(100, { currency: 'CAD', fxRate: 1.37 }), 'CA$137.00');
  assert.equal(moneyIn(100, { currency: 'EUR', fxRate: 0.92 }), '€92.00');
});

test('admin backorder money falls back safely on missing stamps', () => {
  assert.equal(moneyIn(100, {}), '$100.00');
  assert.equal(moneyIn(100, { currency: 'CAD', fxRate: 0 }), 'CA$100.00');
  assert.equal(moneyIn(null, { currency: 'EUR' }), '€—');
});

test('two backorders in one admin session render in their own currencies', () => {
  const rows = [
    { number: 'BO1', currency: 'USD', fxRate: 1 },
    { number: 'BO2', currency: 'CAD', fxRate: 1.37 },
    { number: 'BO3', currency: 'EUR', fxRate: 0.92 },
  ];
  assert.deepEqual(rows.map(b => moneyIn(100, b)), ['$100.00', 'CA$137.00', '€92.00']);
});

test('the conversion result reports the order\'s own currency', () => {
  // POST /admin/backorders/:id/convert returns { total, currency, fxRate }
  const result = { total: 510, currency: 'CAD', fxRate: 1.37 };
  assert.equal(moneyIn(result.total, result), 'CA$698.70');
});
