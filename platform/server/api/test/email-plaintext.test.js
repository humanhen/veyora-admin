/* The plaintext part of every customer email is the part that leaks. It is
   generated beside the HTML from the same inputs, and these tests hold both to
   the same rules: no money for a hide-prices account, and correct currency
   conversion for everyone else. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderConfirmation, backorderConfirmation, staffOrderAlert } from '../src/emails.js';

const allocated = [{ sku: '2057.81', modelSku: '2057', brand: 'Kyme', name: 'Cameron',
  color: 'Matte Black', qty: 3, price: 90 }];
const backordered = [{ sku: 'VEDETTE-2002', modelSku: 'VEDETTE', brand: 'Essedue',
  name: 'Vedette', color: 'Havana', qty: 2, price: 120 }];
const who = { name: 'Dana', email: 'dana@optical.test' };
const totals = { allocatedValue: 270, backorderedValue: 240, requestedValue: 510 };

const order = { id: 'o_1', number: 'SO11890', total: 270, items: allocated };

/* Money that must never reach a hide-prices customer. Matches a currency symbol
   followed by digits — deliberately NOT a bare "1234.56", because a variation
   SKU such as 2057.81 has exactly that shape and is not money. */
const MONEY_RE = /(?:[$€]|CA\$)\s*\d/;
/** Amounts these fixtures would print if prices leaked. */
const AMOUNTS = ['270.00', '240.00', '510.00', '369.90', '248.40'];
function assertNoMoney(text, label) {
  assert.ok(!MONEY_RE.test(text), `${label}: currency symbol leaked:\n${text}`);
  for (const a of AMOUNTS) {
    assert.ok(!text.includes(a), `${label}: amount ${a} leaked:\n${text}`);
  }
}

test('plaintext exists for all three confirmation shapes', () => {
  const a = orderConfirmation({ ...who, order, hidePrices: false });
  const b = orderConfirmation({ ...who, order, hidePrices: false,
    backorder: { number: 'BO5007', items: backordered } });
  const c = backorderConfirmation({ ...who, hidePrices: false,
    backorder: { number: 'BO5008', items: backordered } });
  for (const m of [a, b, c]) {
    assert.equal(typeof m.text, 'string');
    assert.ok(m.text.length > 40, 'plaintext is a real body, not a stub');
  }
});

test('hide-prices: NO money in plaintext — fully in stock', () => {
  const m = orderConfirmation({ ...who, order, hidePrices: true, totals });
  assertNoMoney(m.text, 'fully in stock');
  assert.ok(m.text.includes('Model 2057'), 'identity still travels');
  assert.ok(m.text.includes('3 pcs'), 'quantities still travel');
});

test('hide-prices: NO money in plaintext — partial backorder', () => {
  const m = orderConfirmation({ ...who, order, hidePrices: true, totals,
    backorder: { number: 'BO5007', items: backordered } });
  assertNoMoney(m.text, 'partial backorder');
  assert.ok(m.text.includes('BO5007'), 'the reference is not money and must stay');
});

test('hide-prices: NO money in plaintext — fully backordered', () => {
  const m = backorderConfirmation({ ...who, hidePrices: true, totals,
    backorder: { number: 'BO5008', items: backordered } });
  assertNoMoney(m.text, 'fully backordered');
});

test('hide-prices: HTML and plaintext agree — neither shows money', () => {
  for (const m of [
    orderConfirmation({ ...who, order, hidePrices: true, totals }),
    orderConfirmation({ ...who, order, hidePrices: true, totals,
      backorder: { number: 'BO5007', items: backordered } }),
    backorderConfirmation({ ...who, hidePrices: true, totals,
      backorder: { number: 'BO5008', items: backordered } }),
  ]) {
    assertNoMoney(m.text, 'plaintext');
    // strip the styling, which legitimately contains numbers like "8px"
    const visible = m.html.replace(/<[^>]+>/g, ' ');
    assert.ok(!/[$€]|CA\$/.test(visible), 'HTML shows no currency symbol either');
  }
});

test('non-USD plaintext totals use the order\'s stamped FX rate', () => {
  const m = orderConfirmation({ ...who, order, hidePrices: false,
    currency: 'CAD', rate: 1.37, totals });
  assert.ok(m.text.includes('CA$369.90'), `270 x 1.37 expected in text:\n${m.text}`);
  assert.ok(!m.text.includes('$270.00'), 'the unconverted base amount must not appear');
});

test('currency label always matches the amount shown', () => {
  const eur = orderConfirmation({ ...who, order, hidePrices: false,
    currency: 'EUR', rate: 0.92, totals });
  assert.ok(eur.text.includes('€248.40'), '270 x 0.92');
  assert.ok(!/CA\$|\$\d/.test(eur.text.replace(/€/g, '')), 'no other currency symbol');
  // the labelled value lines carry the same code as the symbol
  assert.ok(/€\d+\.\d\d EUR/.test(eur.text), 'value lines read "€X EUR"');
});

test('plaintext line items carry brand, model, colour, SKU and quantity', () => {
  const m = orderConfirmation({ ...who, order, hidePrices: false, totals });
  for (const bit of ['Kyme', 'Model 2057', 'SKU 2057.81', 'Cameron', 'Matte Black', '3 pcs']) {
    assert.ok(m.text.includes(bit), `plaintext should contain ${bit}`);
  }
});

test('plaintext never claims a backordered piece is shipping', () => {
  const partial = orderConfirmation({ ...who, order, hidePrices: false, totals,
    backorder: { number: 'BO5007', items: backordered } });
  const full = backorderConfirmation({ ...who, hidePrices: false, totals,
    backorder: { number: 'BO5008', items: backordered } });
  assert.ok(/ALLOCATED FROM CURRENT STOCK/i.test(partial.text));
  assert.ok(partial.text.includes('RECORDED FOR STAFF PROCESSING'));
  assert.ok(partial.text.includes('NOT part of the allocated'));
  assert.ok(full.text.includes('NOTHING IS SHIPPING YET'));
  for (const m of [partial, full]) {
    assert.ok(!/shipping now|preparing to ship/i.test(m.text), 'no premature shipping wording');
    assert.ok(!/automatically (ship|dispatch|send)/i.test(m.text), 'no automatic-fulfilment promise');
  }
});

test('partial backorder distinguishes allocated / backordered / requested value', () => {
  const m = orderConfirmation({ ...who, order, hidePrices: false, totals,
    backorder: { number: 'BO5007', items: backordered } });
  assert.ok(m.text.includes('Allocated value: $270.00 USD'));
  assert.ok(m.text.includes('Backordered value: $240.00 USD'));
  assert.ok(m.text.includes('Full requested value: $510.00 USD'));
});

test('a fully in-stock order shows no backordered/requested value clutter', () => {
  const m = orderConfirmation({ ...who, order, hidePrices: false,
    totals: { allocatedValue: 270, backorderedValue: 0, requestedValue: 270 } });
  assert.ok(!m.text.includes('Backordered value'));
  assert.ok(!m.text.includes('Full requested value'));
});

test('staff alerts still carry money even for a hide-prices customer', () => {
  const a = staffOrderAlert({
    order, backorder: { number: 'BO5007' }, totals, currency: 'USD', rate: 1,
    customer: { business: 'Dana Optical', email: 'dana@optical.test', customerNumber: '1042' },
    agent: null,
    lines: [{ sku: '2057.81', modelSku: '2057', brand: 'Kyme', name: 'Cameron',
      color: 'Matte Black', requested: 5, allocated: 3, backordered: 2, price: 90 }],
  });
  assert.ok(a.text.includes('$270.00'), 'the warehouse needs the values');
  assert.ok(a.text.includes('requested 5 · allocate 3 · backorder 2'));
  assert.ok(a.text.includes('Model 2057'));
});

test('a customer order note reaches staff but is not invented when absent', () => {
  const base = { order, totals, currency: 'USD', rate: 1, agent: null,
    customer: { business: 'Dana Optical', email: 'd@o.test', customerNumber: '1042' },
    lines: [{ sku: '2057.81', modelSku: '2057', name: 'Cameron', requested: 1,
      allocated: 1, backordered: 0, price: 90 }] };
  const withNote = staffOrderAlert({ ...base, note: 'Please pack the two Kyme separately' });
  assert.ok(withNote.text.includes('Please pack the two Kyme separately'));
  assert.ok(withNote.html.includes('Customer note'));
  const without = staffOrderAlert(base);
  assert.ok(!without.html.includes('Customer note'));
});

/* ---------------- backorder conversion notification (Batch 1C, Task 8) ------- */

const CONVERSION_INTRO =
  'Good news — the pieces you had on backorder BO5007 are now available and have '
  + 'been allocated to order SO11890. They have not shipped yet; we\'ll let you '
  + 'know when they do.';

test('a conversion notice says ALLOCATED, never shipped', () => {
  const m = orderConfirmation({ ...who, hidePrices: false, intro: CONVERSION_INTRO,
    order: { id: 'o_1', number: 'SO11890', total: 270, items: allocated } });
  for (const body of [m.html, m.text]) {
    assert.ok(/allocated to order/i.test(body), 'states what actually happened');
    assert.ok(/have not shipped yet/i.test(body), 'and what has not');
    assert.ok(!/has shipped|have shipped|on its way|dispatched/i.test(body),
      'conversion reserves stock and creates a pending order — nothing left the warehouse');
  }
});

test('the conversion notice carries the backorder reference it came from', () => {
  const m = orderConfirmation({ ...who, hidePrices: false, intro: CONVERSION_INTRO,
    order: { id: 'o_1', number: 'SO11890', total: 270, items: allocated } });
  assert.ok(m.text.includes('BO5007'));
  assert.ok(m.html.includes('BO5007'));
});

test('hide-prices protection still applies to a conversion notice', () => {
  const m = orderConfirmation({ ...who, hidePrices: true, intro: CONVERSION_INTRO, totals,
    order: { id: 'o_1', number: 'SO11890', total: 270, items: allocated } });
  assertNoMoney(m.text, 'conversion notice');
  const visible = m.html.replace(/<[^>]+>/g, ' ');
  assert.ok(!/[$€]|CA\$/.test(visible), 'no currency symbol in the HTML either');
  assert.ok(m.text.includes('Model 2057'), 'identity still travels');
});

test('a non-USD conversion notice converts with the order\'s stamped rate', () => {
  const m = orderConfirmation({ ...who, hidePrices: false, intro: CONVERSION_INTRO,
    currency: 'CAD', rate: 1.37,
    order: { id: 'o_1', number: 'SO11890', total: 270, items: allocated } });
  assert.ok(m.text.includes('CA$369.90'));
  assert.ok(!m.text.includes('$270.00'), 'never the unconverted base amount');
});

test('a normal confirmation is unchanged when no intro is supplied', () => {
  const m = orderConfirmation({ ...who, hidePrices: false,
    order: { id: 'o_1', number: 'SO11890', total: 270, items: allocated } });
  assert.ok(m.text.includes("Thank you for your order SO11890"));
  assert.ok(!/allocated to order/i.test(m.text));
});
