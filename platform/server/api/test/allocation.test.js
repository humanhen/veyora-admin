/* The order-splitting rule: how a requested quantity divides into what ships
   now and what becomes a backorder, and how ALLOW_CUSTOMER_BACKORDERS decides
   whether a shortfall is accepted or rejected. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planAllocation } from '../src/inventory.js';
import { allowCustomerBackorders } from '../src/config.js';

const pile = (warehouse_id, qty) => ({ variation_id: 'v_1', warehouse_id, qty });

test('fully in stock — one pile covers the request, nothing backorders', () => {
  const r = planAllocation(3, [pile('wh_main', 10)]);
  assert.equal(r.allocated, 3);
  assert.equal(r.backordered, 0);
  assert.deepEqual(r.takes.map(t => [t.warehouse_id, t.take]), [['wh_main', 3]]);
});

test('partial — takes everything available and backorders the shortfall', () => {
  const r = planAllocation(5, [pile('wh_main', 2)]);
  assert.equal(r.allocated, 2);
  assert.equal(r.backordered, 3);
});

test('fully backordered — no stock anywhere, the whole request is held', () => {
  const r = planAllocation(4, [pile('wh_main', 0), pile('wh_reserve', 0)]);
  assert.equal(r.allocated, 0);
  assert.equal(r.backordered, 4);
  assert.deepEqual(r.takes, [], 'nothing is decremented when nothing is available');
});

test('no stock rows at all is a full backorder, not a crash', () => {
  for (const piles of [[], null, undefined]) {
    const r = planAllocation(2, piles);
    assert.equal(r.allocated, 0);
    assert.equal(r.backordered, 2);
  }
});

test('draws across warehouses in the order given, main first', () => {
  const r = planAllocation(9, [pile('wh_main', 4), pile('wh_reserve', 3), pile('wh_x', 5)]);
  assert.deepEqual(r.takes.map(t => [t.warehouse_id, t.take]),
    [['wh_main', 4], ['wh_reserve', 3], ['wh_x', 2]]);
  assert.equal(r.allocated, 9);
  assert.equal(r.backordered, 0);
});

test('stops as soon as the request is covered — later piles are untouched', () => {
  const r = planAllocation(2, [pile('wh_main', 5), pile('wh_reserve', 5)]);
  assert.equal(r.takes.length, 1);
  assert.equal(r.allocated, 2);
});

test('allocated + backordered always reconciles to the requested quantity', () => {
  for (const [need, stock] of [[0, 5], [1, 0], [7, 3], [3, 3], [100, 99]]) {
    const r = planAllocation(need, [pile('wh_main', stock)]);
    assert.equal(r.allocated + r.backordered, Math.max(0, need),
      `${need} requested against ${stock} on hand must reconcile`);
  }
});

test('negative or junk stock is treated as zero, never as a credit', () => {
  const r = planAllocation(3, [pile('wh_main', -5), pile('wh_reserve', 2)]);
  assert.equal(r.allocated, 2);
  assert.equal(r.backordered, 1);
  assert.ok(r.takes.every(t => t.take > 0), 'no zero/negative decrements are emitted');
});

/* The checkout decision itself: identical allocation, opposite outcome
   depending on the flag. */
function checkoutOutcome(need, piles) {
  const { allocated, backordered } = planAllocation(need, piles);
  if (!allowCustomerBackorders() && backordered > 0) {
    return { rejected: true, reason: 'insufficient stock', allocated, backordered };
  }
  return {
    rejected: false,
    createsOrder: allocated > 0,
    createsBackorder: backordered > 0,
    allocated, backordered,
  };
}

function withFlag(value, fn) {
  const saved = process.env.ALLOW_CUSTOMER_BACKORDERS;
  process.env.ALLOW_CUSTOMER_BACKORDERS = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.ALLOW_CUSTOMER_BACKORDERS;
    else process.env.ALLOW_CUSTOMER_BACKORDERS = saved;
  }
}

test('flag TRUE: a shortfall becomes an order plus a backorder', () => {
  withFlag('true', () => {
    assert.deepEqual(checkoutOutcome(5, [pile('wh_main', 2)]),
      { rejected: false, createsOrder: true, createsBackorder: true, allocated: 2, backordered: 3 });
  });
});

test('flag TRUE: a fully unavailable request is a valid full backorder', () => {
  withFlag('true', () => {
    const out = checkoutOutcome(4, [pile('wh_main', 0)]);
    assert.equal(out.rejected, false);
    assert.equal(out.createsOrder, false, 'no order object exists');
    assert.equal(out.createsBackorder, true);
  });
});

test('flag FALSE: the same shortfall is rejected outright', () => {
  withFlag('false', () => {
    const out = checkoutOutcome(5, [pile('wh_main', 2)]);
    assert.equal(out.rejected, true);
    assert.equal(out.backordered, 3, 'the shortfall is reported so the cart can be fixed');
  });
});

test('flag FALSE: a request fully covered by stock still succeeds', () => {
  withFlag('false', () => {
    assert.deepEqual(checkoutOutcome(2, [pile('wh_main', 9)]),
      { rejected: false, createsOrder: true, createsBackorder: false, allocated: 2, backordered: 0 });
  });
});
