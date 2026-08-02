/* Backorder -> order conversion.

   The old path built the order in the browser, called reserveStock() (which
   silently took whatever existed) and created the order even when it had
   under-reserved. Conversion is now a server transaction gated on planConversion:
   all-or-nothing for this release, with exact shortages when it cannot be met. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planConversion, planAllocation } from '../src/inventory.js';
import { CUSTOMER_BACKORDER } from '../src/ordering.js';

const lines = [
  { sku: '2057.81', name: 'Cameron', color: 'Matte Black', qty: 3, price: 90 },
  { sku: 'VEDETTE-2002', name: 'Vedette', color: 'Havana', qty: 2, price: 120 },
];

/* ---------------- coverage decision ---------------- */

test('fully covered when every line is available in full', () => {
  const r = planConversion(lines, { '2057.81': 5, 'VEDETTE-2002': 2 });
  assert.equal(r.covered, true);
  assert.deepEqual(r.shortages, []);
});

test('exact coverage counts as covered', () => {
  assert.equal(planConversion(lines, { '2057.81': 3, 'VEDETTE-2002': 2 }).covered, true);
});

test('one short line blocks the whole conversion (all-or-nothing)', () => {
  const r = planConversion(lines, { '2057.81': 3, 'VEDETTE-2002': 1 });
  assert.equal(r.covered, false, 'partial conversion is out of scope this release');
  assert.equal(r.shortages.length, 1);
  assert.deepEqual(r.shortages[0], {
    sku: 'VEDETTE-2002', name: 'Vedette', color: 'Havana',
    requested: 2, available: 1, short: 1,
    // Batch 1C: shortages report how many lines demanded the SKU, because
    // `requested` is now the AGGREGATE across lines, not one line's quantity.
    lineCount: 1,
  });
});

test('a completely unavailable SKU reports the full shortfall', () => {
  const r = planConversion(lines, { '2057.81': 3 });
  assert.equal(r.covered, false);
  assert.equal(r.shortages[0].available, 0);
  assert.equal(r.shortages[0].short, 2);
});

test('every short line is reported, not just the first', () => {
  const r = planConversion(lines, {});
  assert.equal(r.shortages.length, 2);
  assert.deepEqual(r.shortages.map(s => s.short), [3, 2]);
});

test('a Map of availability works as well as an object', () => {
  const m = new Map([['2057.81', 3], ['VEDETTE-2002', 2]]);
  assert.equal(planConversion(lines, m).covered, true);
});

test('missing, negative or junk availability is treated as zero, never a credit', () => {
  for (const avail of [null, undefined, {}, { '2057.81': -10, 'VEDETTE-2002': 'x' }]) {
    const r = planConversion(lines, avail);
    assert.equal(r.covered, false);
    assert.ok(r.shortages.every(s => s.available === 0));
  }
});

test('an empty backorder is vacuously covered (the route rejects it separately)', () => {
  assert.equal(planConversion([], { }).covered, true);
  assert.equal(planConversion(null, {}).covered, true);
});

/* ---------------- reservation is exact, and once ---------------- */

test('conversion reserves exactly the requested quantity, not everything on hand', () => {
  const piles = [
    { variation_id: 'v1', warehouse_id: 'wh_main', qty: 10 },
    { variation_id: 'v1', warehouse_id: 'wh_reserve', qty: 10 },
  ];
  const { takes, allocated, backordered } = planAllocation(3, piles);
  assert.equal(allocated, 3);
  assert.equal(backordered, 0);
  assert.equal(takes.reduce((s, t) => s + t.take, 0), 3,
    'the old reserveStock() took whatever it found; this takes what is needed');
  assert.equal(takes.length, 1, 'later piles are untouched once covered');
});

test('reservation draws across warehouses only as far as needed', () => {
  const piles = [
    { variation_id: 'v1', warehouse_id: 'wh_main', qty: 2 },
    { variation_id: 'v1', warehouse_id: 'wh_reserve', qty: 9 },
  ];
  const { takes, allocated } = planAllocation(5, piles);
  assert.equal(allocated, 5);
  assert.deepEqual(takes.map(t => [t.warehouse_id, t.take]),
    [['wh_main', 2], ['wh_reserve', 3]]);
});

test('a refused conversion computes no reservation at all', () => {
  const { covered } = planConversion(lines, { '2057.81': 1, 'VEDETTE-2002': 0 });
  assert.equal(covered, false);
  // The route returns before touching stock; nothing is decremented, the
  // backorder stays open and its preserved context is untouched.
});

/* ---------------- authorisation vs eligibility ---------------- */

test('customer authorisation alone does not make a backorder convertible', () => {
  assert.equal(CUSTOMER_BACKORDER.customerAuthorised, true);
  assert.equal(CUSTOMER_BACKORDER.eligible, false);
  // Conversion is decided by planConversion against real, locked stock —
  // never by the customer having asked for it.
  assert.equal(planConversion(lines, {}).covered, false,
    'no stock means no conversion, however the customer authorised it');
});

test('the record stays in a status the admin queue can still process', () => {
  assert.equal(CUSTOMER_BACKORDER.status, 'open');
  assert.ok(['open', 'approved'].includes(CUSTOMER_BACKORDER.status));
});

/* ---------------- preserved context is reproduced ---------------- */

test('conversion rebuilds the order from the backorder\'s OWN context', async () => {
  const { orderFieldsFromBackorder } = await import('../src/ordering.js');
  const bo = {
    customer_id: 'u_dana', agent_id: 'u_sam', source: 'agent',
    currency: 'CAD', fx_rate: '1.370000',
    shipping_address: { business: 'Dana Optical', city: 'Toronto', country: 'CA' },
    billing_address: { business: 'Dana Optical HQ', country: 'CA' },
    promo: { id: 'pr_1', name: 'Spring 10', discount: 20 },
    discount: '20.00', free_shipping: true, shipping: '0.00',
    comments: [{ by: 'Dana Optical (order note)', text: 'Pack the Kyme separately', at: 'x' }],
  };
  const f = orderFieldsFromBackorder(bo, lines);
  // Everything the browser version used to invent:
  assert.equal(f.agentId, 'u_sam', 'the salesperson is preserved, not nulled');
  assert.equal(f.source, 'agent', "not forced back to 'customer'");
  assert.equal(f.freeShipping, true, 'not hardcoded');
  // ...and everything a full backorder had nowhere else to keep:
  assert.equal(f.customerId, 'u_dana');
  assert.equal(f.currency, 'CAD');
  assert.equal(f.fxRate, 1.37, 'numeric, from the stamped string');
  assert.deepEqual(f.shippingAddress, bo.shipping_address);
  assert.deepEqual(f.billingAddress, bo.billing_address);
  assert.deepEqual(f.promo, bo.promo);
  assert.equal(f.comments[0].text, 'Pack the Kyme separately',
    'the checkout note survives, and not only as an audit message');
});

test('conversion totals come from the LOCKED backorder prices', async () => {
  const { orderFieldsFromBackorder } = await import('../src/ordering.js');
  const f = orderFieldsFromBackorder({ discount: 0, shipping: 0 }, lines);
  assert.equal(f.subtotal, 3 * 90 + 2 * 120);          // 510
  assert.equal(f.total, 510, 'prices are not re-derived from the current catalogue');
});

test('discount and shipping are applied, and a discount cannot exceed the subtotal', async () => {
  const { orderFieldsFromBackorder } = await import('../src/ordering.js');
  assert.equal(orderFieldsFromBackorder({ discount: 10, shipping: 25 }, lines).total, 525);
  assert.equal(orderFieldsFromBackorder({ discount: 9999, shipping: 0 }, lines).total, 0,
    'a stale discount cannot produce a negative order');
});

test('a bare legacy backorder converts to safe defaults rather than throwing', async () => {
  const { orderFieldsFromBackorder } = await import('../src/ordering.js');
  const f = orderFieldsFromBackorder({ customer_id: 'u_old' }, lines);
  assert.equal(f.agentId, null);
  assert.equal(f.source, 'customer');
  assert.equal(f.currency, 'USD');
  assert.equal(f.fxRate, 1);
  assert.deepEqual(f.comments, []);
  assert.equal(f.total, 510);
});

test('every field the context model promises is actually listed', async () => {
  const { BACKORDER_CONTEXT_FIELDS } = await import('../src/ordering.js');
  for (const col of ['customer_id', 'agent_id', 'source', 'currency', 'fx_rate',
    'shipping_address', 'billing_address', 'promo', 'discount', 'free_shipping',
    'shipping', 'comments', 'customer_authorised', 'created_at']) {
    assert.ok(BACKORDER_CONTEXT_FIELDS.includes(col), `${col} must be preserved`);
  }
});
