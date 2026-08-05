import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeKey,
  isForbiddenKey,
  isForbiddenLabelValue,
  scanForForbiddenKeys,
  assertNoForbiddenKeys,
} from '../src/public-forbidden-keys.js';

test('normalizeKey collapses snake_case, camelCase and separators to the same form', () => {
  assert.equal(normalizeKey('sale_price'), 'saleprice');
  assert.equal(normalizeKey('salePrice'), 'saleprice');
  assert.equal(normalizeKey('SALE-PRICE'), 'saleprice');
  assert.equal(normalizeKey('Sale Price'), 'saleprice');
});

test('every key named in the B2.2 brief is detected, in both snake_case and camelCase', () => {
  const pairs = [
    ['price', 'price'],
    ['sale_price', 'salePrice'],
    ['purchase_price', 'purchasePrice'],
    ['basePrice', 'basePrice'],
    ['cost', 'cost'],
    ['margin', 'margin'],
    ['wholesale', 'wholesale'],
    ['discount', 'discount'],
    ['promotion', 'promotion'],
    ['qty', 'qty'],
    ['quantity', 'quantity'],
    ['stock', 'stock'],
    ['stockStatus', 'stock_status'],
    ['onHand', 'on_hand'],
    ['available', 'available'],
    ['availability', 'availability'],
    ['warehouse', 'warehouse'],
    ['shelf', 'shelf'],
    ['customer', 'customer'],
    ['customerNumber', 'customer_number'],
    ['customer_id', 'customerId'],
    ['user_id', 'userId'],
    ['email', 'email'],
    ['phone', 'phone'],
    ['tax_id', 'taxId'],
    ['balance', 'balance'],
    ['payment_terms', 'paymentTerms'],
    ['pricing', 'pricing'],
    ['hide_prices', 'hidePrices'],
    ['order', 'order'],
    ['order_id', 'orderId'],
    ['invoice', 'invoice'],
    ['credit', 'credit'],
    ['agent_id', 'agentId'],
    ['zoho_item_id', 'zohoItemId'],
  ];
  for (const [snake, camel] of pairs) {
    assert.ok(isForbiddenKey(snake), `snake_case "${snake}" was not detected`);
    assert.ok(isForbiddenKey(camel), `camelCase "${camel}" was not detected`);
  }
});

test('purchase-order identifiers and governance/administration internals are detected', () => {
  for (const key of ['po_number', 'poNumber', 'purchase_order_id', 'purchaseOrderId', 'fact_owner', 'factOwner', 'approver_id', 'rights_holder', 'rights_expiry']) {
    assert.ok(isForbiddenKey(key), `"${key}" was not detected`);
  }
});

test('avoids naive substring false positives: "discontinued" and lookalikes are never flagged', () => {
  for (const key of ['discontinued', 'is_discontinued', 'isDiscontinued', 'sortOrder', 'sort_order', 'orderIndex', 'order_index', 'displayOrder']) {
    assert.ok(!isForbiddenKey(key), `"${key}" was incorrectly flagged as forbidden`);
  }
});

test('isForbiddenLabelValue only matches strings literally starting with "label:", case-insensitively', () => {
  assert.ok(isForbiddenLabelValue('label:best-seller'));
  assert.ok(isForbiddenLabelValue('LABEL:foo'));
  assert.ok(isForbiddenLabelValue('  label:padded'));
  assert.ok(!isForbiddenLabelValue('New'));
  assert.ok(!isForbiddenLabelValue('mislabeled')); // contains "label" but does not START with "label:"
  assert.ok(!isForbiddenLabelValue(42));
  assert.ok(!isForbiddenLabelValue(null));
});

test('scanForForbiddenKeys walks nested objects and arrays and reports every violation', () => {
  const value = {
    brand: { slug: 'x', logoMedia: { path: '/a.jpg' } },
    models: [
      { sku: '1', hidden: { cost: 5 } },
      { sku: '2', tags: ['New', 'label:hot'] },
    ],
  };
  const violations = scanForForbiddenKeys(value);
  assert.equal(violations.length, 2);
  const paths = violations.map((v) => v.path).sort();
  assert.deepEqual(paths, ['$.models[0].hidden.cost', '$.models[1].tags[1]']);
});

test('scanForForbiddenKeys returns an empty array for clean input', () => {
  assert.deepEqual(scanForForbiddenKeys({ slug: 'x', name: 'Y', tags: ['New', 'Optical'] }), []);
  assert.deepEqual(scanForForbiddenKeys([1, 2, 'three']), []);
  assert.deepEqual(scanForForbiddenKeys(null), []);
  assert.deepEqual(scanForForbiddenKeys(undefined), []);
});

test('assertNoForbiddenKeys throws with a readable message including the path, and is silent when clean', () => {
  assert.throws(() => assertNoForbiddenKeys({ a: { price: 1 } }, 'test object'), /test object contains forbidden data.*\$\.a\.price/);
  assert.doesNotThrow(() => assertNoForbiddenKeys({ a: { name: 'ok' } }));
});

test('a forbidden key wrapping further forbidden data reports both, not just the outer one', () => {
  const violations = scanForForbiddenKeys({ pricing: { cost: 5 } });
  const paths = violations.map((v) => v.path).sort();
  assert.deepEqual(paths, ['$.pricing', '$.pricing.cost']);
});
