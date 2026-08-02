/* The three confirmation shapes a checkout can produce, plus the staff alert.
   The wording rule under test: a backordered piece must never be described as
   shipping. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderConfirmation, backorderConfirmation, staffOrderAlert } from '../src/emails.js';

const allocated = [{ sku: '2057.81', modelSku: '2057', brand: 'Kyme', name: 'Cameron',
  color: 'Matte Black', qty: 3, price: 90 }];
const backordered = [{ sku: 'VEDETTE-2002', modelSku: 'VEDETTE', brand: 'Essedue',
  name: 'Vedette', color: 'Havana', qty: 2, price: 120 }];
const customer = { name: 'Dana', email: 'dana@optical.test' };

test('A — fully in stock: confirms the order with full product identity', () => {
  const m = orderConfirmation({ ...customer, hidePrices: false,
    order: { id: 'o_1', number: 'SO11890', total: 270, items: allocated } });
  assert.match(m.subject, /SO11890/);
  for (const bit of ['Kyme', 'Model 2057', 'SKU 2057.81', 'Cameron', 'Matte Black', '×3']) {
    assert.ok(m.html.includes(bit), `confirmation should show ${bit}`);
  }
  assert.ok(m.html.includes('$270.00'), 'total is shown');
  assert.ok(!m.html.includes('backorder'), 'nothing about backorders when everything shipped');
});

test('B — partly allocated: separates what is allocated from what is recorded', () => {
  const m = orderConfirmation({ ...customer, hidePrices: false,
    order: { id: 'o_1', number: 'SO11890', total: 270, items: allocated },
    backorder: { number: 'BO5007', items: backordered } });
  // Wording rule (Batch 1A / Task 7): an allocated quantity has been taken from
  // stock, not shipped, so the section is not called "Shipping now".
  assert.ok(m.html.includes('Allocated from current stock'), 'the allocated section is labelled');
  assert.ok(m.html.includes('Recorded for staff processing'), 'the backorder section is labelled');
  assert.ok(m.html.includes('BO5007'), 'the backorder reference is given');
  assert.ok(m.html.includes('Model VEDETTE'), 'backordered lines carry identity too');
  assert.ok(/not<\/b> part of the allocated quantities above/.test(m.html),
    'must state plainly that backordered pieces are not allocated');
  assert.ok(!/shipping now|preparing to ship/i.test(m.html), 'no premature shipping wording');
});

test('C — fully backordered: still a confirmation, and says nothing is shipping', () => {
  const m = backorderConfirmation({ ...customer, hidePrices: false,
    backorder: { number: 'BO5008', items: backordered } });
  assert.match(m.subject, /BO5008/);
  assert.ok(m.html.includes('nothing is shipping yet'),
    'a full backorder must not read like a dispatch note');
  assert.ok(m.html.includes('Essedue') && m.html.includes('SKU VEDETTE-2002'));
});

test('hidePrices suppresses money but never product identity', () => {
  const m = orderConfirmation({ ...customer, hidePrices: true,
    order: { id: 'o_1', number: 'SO11890', total: 270, items: allocated } });
  assert.ok(!m.html.includes('270.00'), 'no total for a hide-prices account');
  assert.ok(m.html.includes('Model 2057'), 'identity still travels');
});

test('currency is applied to emailed amounts, not hardcoded to dollars', () => {
  const m = orderConfirmation({ ...customer, hidePrices: false, currency: 'CAD', rate: 1.37,
    order: { id: 'o_1', number: 'SO11890', total: 100, items: allocated } });
  assert.ok(m.html.includes('CA$137.00'), 'base USD is converted and symbolised');
});

test('staff alert carries requested / allocated / backordered per line', () => {
  const a = staffOrderAlert({
    order: { id: 'o_1', number: 'SO11890', total: 270 },
    backorder: { number: 'BO5007' },
    customer: { business: 'Dana Optical', email: 'dana@optical.test', customerNumber: '1042' },
    agent: { name: 'Sam Rep', email: 'sam@veyora.test' },
    lines: [
      { sku: '2057.81', modelSku: '2057', brand: 'Kyme', name: 'Cameron', color: 'Matte Black',
        requested: 5, allocated: 3, backordered: 2, price: 90 },
    ],
    currency: 'USD', rate: 1,
  });
  assert.match(a.subject, /SO11890/);
  assert.match(a.subject, /Dana Optical/);
  for (const bit of ['Dana Optical', '#1042', 'SO11890', 'BO5007', 'Sam Rep',
    'Kyme', 'Model 2057', 'SKU 2057.81', 'Matte Black']) {
    assert.ok(a.html.includes(bit), `alert should include ${bit}`);
  }
  assert.ok(a.html.includes('$270.00 USD'), 'total and currency are stated');
});

test('staff alert works for a backorder with no order, and leaks nothing extra', () => {
  const a = staffOrderAlert({
    order: null,
    backorder: { number: 'BO5008' },
    customer: { business: 'Dana Optical', email: 'dana@optical.test', customerNumber: '1042' },
    agent: null,
    lines: [{ sku: 'VEDETTE-2002', modelSku: 'VEDETTE', brand: 'Essedue', name: 'Vedette',
      color: 'Havana', requested: 2, allocated: 0, backordered: 2, price: 120 }],
  });
  assert.match(a.subject, /New backorder BO5008/);
  assert.ok(!a.html.includes('Placed by'), 'no agent row when a customer ordered directly');
  assert.ok(!/password|balance|tax|Total/i.test(a.html.replace(/Totals?:/g, '')),
    'no credentials, balances or tax ids in an operational alert');
});
