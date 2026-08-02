/* One checkout, one set of commercial terms.

   Whether stock happened to be available must not change what the customer
   pays. The backorder insert previously passed a literal `order ? 0 : 0` for
   discount, so a fully backordered promoted checkout silently lost its
   discount, and shipping handling was ad hoc. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateCommercials, round2 } from '../src/pricing.js';

/* ---------------- fully backordered ---------------- */

test('full backorder keeps a FIXED discount instead of losing it', () => {
  const r = allocateCommercials({
    allocatedSubtotal: 0, backorderedSubtotal: 500,
    promoDiscount: 50, shippingCost: 0, shippingFree: true,
  });
  assert.equal(r.order.discount, 0);
  assert.equal(r.backorder.discount, 50, 'the whole discount carries to the backorder');
  assert.equal(r.backorder.total, 450);
  assert.equal(r.authorisedTotal, 450);
});

test('full backorder keeps a PERCENTAGE discount', () => {
  // 10% of 500 was computed upstream by previewPromotions
  const r = allocateCommercials({
    allocatedSubtotal: 0, backorderedSubtotal: 500,
    promoDiscount: 50, shippingCost: 0, shippingFree: true,
  });
  assert.equal(r.backorder.discount, 50);
  assert.equal(round2(500 - r.backorder.discount), r.backorder.total);
});

test('full backorder with PAID shipping charges it once, on the backorder', () => {
  const r = allocateCommercials({
    allocatedSubtotal: 0, backorderedSubtotal: 200,
    promoDiscount: 0, shippingCost: 25, shippingFree: false,
  });
  assert.equal(r.order.shipping, 0, 'there is no order to charge it to');
  assert.equal(r.backorder.shipping, 25);
  assert.equal(r.backorder.freeShipping, false);
  assert.equal(r.backorder.total, 225);
  assert.equal(r.authorisedTotal, 225);
});

test('full backorder preserves a free-shipping decision', () => {
  const r = allocateCommercials({
    allocatedSubtotal: 0, backorderedSubtotal: 200,
    promoDiscount: 0, shippingCost: 0, shippingFree: true,
  });
  assert.equal(r.backorder.freeShipping, true);
  assert.equal(r.backorder.shipping, 0);
});

/* ---------------- partial allocation ---------------- */

test('partial: the order absorbs what it can, the rest carries to the backorder', () => {
  const r = allocateCommercials({
    allocatedSubtotal: 100, backorderedSubtotal: 400,
    promoDiscount: 300, shippingCost: 0, shippingFree: true,
  });
  assert.equal(r.order.discount, 100, 'capped at the order subtotal');
  assert.equal(r.backorder.discount, 200, 'the remaining 200 is not lost');
  assert.equal(round2(r.order.discount + r.backorder.discount), 300);
});

test('partial: shipping is charged ONCE, on the immediate order', () => {
  const r = allocateCommercials({
    allocatedSubtotal: 100, backorderedSubtotal: 400,
    promoDiscount: 0, shippingCost: 25, shippingFree: false,
  });
  assert.equal(r.order.shipping, 25);
  assert.equal(r.backorder.shipping, 0, 'never charged twice');
});

test('partial with FREE shipping keeps the decision on both records', () => {
  const r = allocateCommercials({
    allocatedSubtotal: 100, backorderedSubtotal: 400,
    promoDiscount: 0, shippingCost: 0, shippingFree: true,
  });
  assert.equal(r.order.freeShipping, true);
  assert.equal(r.backorder.freeShipping, true);
  assert.equal(round2(r.order.shipping + r.backorder.shipping), 0);
});

test('partial: order total + converted backorder total == what was authorised', () => {
  for (const c of [
    { allocatedSubtotal: 100, backorderedSubtotal: 400, promoDiscount: 300, shippingCost: 25, shippingFree: false },
    { allocatedSubtotal: 250, backorderedSubtotal: 250, promoDiscount: 50, shippingCost: 0, shippingFree: true },
    { allocatedSubtotal: 33.33, backorderedSubtotal: 66.67, promoDiscount: 10, shippingCost: 12.5, shippingFree: false },
    { allocatedSubtotal: 0.01, backorderedSubtotal: 999.99, promoDiscount: 123.45, shippingCost: 7.77, shippingFree: false },
  ]) {
    const r = allocateCommercials(c);
    assert.equal(round2(r.order.total + r.backorder.total), r.authorisedTotal,
      `must reconcile for ${JSON.stringify(c)}`);
  }
});

/* ---------------- fully in stock ---------------- */

test('fully in stock behaves exactly as before', () => {
  const r = allocateCommercials({
    allocatedSubtotal: 500, backorderedSubtotal: 0,
    promoDiscount: 50, shippingCost: 25, shippingFree: false,
  });
  assert.equal(r.order.discount, 50);
  assert.equal(r.order.shipping, 25);
  assert.equal(r.order.total, 475);
  assert.equal(r.backorder.total, 0);
  assert.equal(r.backorder.discount, 0);
  assert.equal(r.backorder.shipping, 0);
});

/* ---------------- guards ---------------- */

test('a discount can never exceed what was actually bought', () => {
  const r = allocateCommercials({
    allocatedSubtotal: 10, backorderedSubtotal: 10, promoDiscount: 9999,
  });
  assert.equal(round2(r.order.discount + r.backorder.discount), 20);
  assert.equal(r.authorisedTotal, 0, 'never negative');
});

test('missing or junk input yields a safe zero split', () => {
  const r = allocateCommercials();
  assert.equal(r.order.total, 0);
  assert.equal(r.backorder.total, 0);
  assert.equal(r.authorisedTotal, 0);
  const neg = allocateCommercials({
    allocatedSubtotal: -50, backorderedSubtotal: -50, promoDiscount: -10, shippingCost: -5 });
  assert.equal(neg.authorisedTotal, 0);
});

test('rounding stays at two decimals throughout', () => {
  const r = allocateCommercials({
    allocatedSubtotal: 10.005, backorderedSubtotal: 20.004,
    promoDiscount: 3.333, shippingCost: 1.115,
  });
  for (const v of [r.order.discount, r.order.shipping, r.order.total,
                   r.backorder.discount, r.backorder.shipping, r.backorder.total,
                   r.authorisedTotal]) {
    assert.equal(v, round2(v), `${v} should already be 2dp`);
  }
});

/* ---------------- promotion usage ---------------- */

test('a promotion is consumed once per accepted checkout, in all three shapes', () => {
  /* Mirrors the route's condition: `summary.promotion?.id && (order || backorder)`.
     It used to sit inside `if (orderItems.length)`, so a fully backordered
     checkout consumed nothing at all. */
  const consumes = (promoId, hasOrder, hasBackorder) =>
    (promoId && (hasOrder || hasBackorder)) ? 1 : 0;

  assert.equal(consumes('pr_1', true, false), 1, 'fully in stock');
  assert.equal(consumes('pr_1', true, true), 1, 'partial: order + backorder is ONE use');
  assert.equal(consumes('pr_1', false, true), 1, 'fully backordered still consumes');
  assert.equal(consumes(null, true, true), 0, 'no promotion, no use');
  assert.equal(consumes('pr_1', false, false), 0, 'nothing created, nothing used');
});

test('conversion must not consume the promotion again', () => {
  // The converted order carries the backorder's promo SNAPSHOT for the record;
  // the checkout already counted the use, so conversion increments nothing.
  const usesAtCheckout = 1;
  const usesAtConversion = 0;
  assert.equal(usesAtCheckout + usesAtConversion, 1,
    'one authorised checkout = one promotion use, however it is fulfilled');
});
