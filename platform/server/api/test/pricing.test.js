/* Guards the salesperson-pricing defect: an order placed by an agent for a
   customer must be costed with the CUSTOMER's pricing profile, never the
   agent's. priceForCustomer is the single decision point, so pinning its
   behaviour here pins the whole path. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceForCustomer } from '../src/pricing.js';

const product = { brand: 'Kyme', price: 100, sale_price: null };
const variation = { sku: '2057.81', price: 100, sale_price: null };

const agent    = { id: 'u_agent',    role: 'agent',    pricing: { mode: 'brand', brands: { Kyme: 40 } } };
const customer = { id: 'u_customer', role: 'customer', pricing: { mode: 'brand', brands: { Kyme: 10 } } };
const plain    = { id: 'u_plain',    role: 'customer', pricing: { mode: 'none' } };

test('each identity gets its own price from the same product', () => {
  assert.equal(priceForCustomer(agent, product, variation), 60);
  assert.equal(priceForCustomer(customer, product, variation), 90);
  assert.equal(priceForCustomer(plain, product, variation), 100);
});

test('an agent-assisted order must not leak the agent discount to the customer', () => {
  // The bug: pricing with the signed-in agent. The fix: pricing with the customer.
  const wrong = priceForCustomer(agent, product, variation);
  const right = priceForCustomer(customer, product, variation);
  assert.notEqual(wrong, right);
  assert.equal(right, 90, 'the customer pays their own contracted price');
});

test('per-SKU customer pricing wins over the brand rule', () => {
  const skuPriced = { id: 'u_x', role: 'customer',
    pricing: { mode: 'sku', skuPrices: { '2057.81': 73.5 } } };
  assert.equal(priceForCustomer(skuPriced, product, variation), 73.5);
});

test('a missing or empty pricing profile falls back to list price', () => {
  assert.equal(priceForCustomer(null, product, variation), 100);
  assert.equal(priceForCustomer({ id: 'u_y' }, product, variation), 100);
});

test('a variation sale price beats the product price before any discount', () => {
  const onSale = { sku: '2057.81', price: 100, sale_price: 80 };
  assert.equal(priceForCustomer(plain, product, onSale), 80);
  assert.equal(priceForCustomer(customer, product, onSale), 72);  // 80 less Kyme 10%
});
