/* Assisted ordering must be coherent end to end: the shelf, the cart, the
   checkout profile and the currency all have to describe the SAME customer.
   pricingIdentity is the single decision point every priced route calls, so
   pinning it here pins the whole path. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pricingIdentity, requestedCustomerId } from '../src/ordering.js';
import { priceForCustomer } from '../src/pricing.js';

const AGENT = { id: 'u_sam', role: 'agent', currency: 'USD',
                pricing: { mode: 'brand', brands: { Kyme: 40 } }, hide_prices: false };
const CUSTOMER = { id: 'u_dana', role: 'customer', business: 'Dana Optical',
                   customer_number: '1042', agent_id: 'u_sam', status: 'active',
                   currency: 'CAD', hide_prices: true,
                   pricing: { mode: 'brand', brands: { Kyme: 10 } } };
const OTHER = { id: 'u_rey', role: 'customer', business: 'Rey Eyewear',
                agent_id: 'u_other', status: 'active', currency: 'USD',
                pricing: { mode: 'none' } };
const ROWS = { u_dana: CUSTOMER, u_rey: OTHER };

function fakeQuery(calls = []) {
  return async (sql, params) => {
    calls.push({ sql, params });
    const row = ROWS[params[0]];
    if (!row) return { rows: [] };
    if (sql.includes('agent_id=$2') && row.agent_id !== params[1]) return { rows: [] };
    return { rows: [row] };
  };
}
const req = (user, opts = {}) => ({ user, query: opts.query || {}, body: opts.body || {} });

const product = { brand: 'Kyme', price: 100, sale_price: null };
const variation = { sku: '2057.81', price: 100, sale_price: null };

/* ---------------- the id is read from wherever it arrives ---------------- */

test('the requested customer id is read from query or body', () => {
  assert.equal(requestedCustomerId({ query: { forCustomer: 'u_dana' } }), 'u_dana');
  assert.equal(requestedCustomerId({ body: { forCustomer: 'u_dana' } }), 'u_dana');
  assert.equal(requestedCustomerId({ body: { customerId: 'u_dana' } }), 'u_dana');
  assert.equal(requestedCustomerId({ query: {}, body: {} }), null);
  assert.equal(requestedCustomerId({}), null);
});

/* ---------------- catalogue is priced for the TARGET ---------------- */

test('assisted catalogue prices for the customer, not the salesperson', async () => {
  const { identity, onBehalf } =
    await pricingIdentity(req(AGENT, { body: { customerId: 'u_dana' } }), fakeQuery());
  assert.equal(onBehalf, true);
  assert.equal(identity.id, 'u_dana');
  // The bug this guards: browsing on the agent's own 40% profile while the
  // banner claims the customer's prices are shown.
  assert.equal(priceForCustomer(identity, product, variation), 90);
  assert.notEqual(priceForCustomer(identity, product, variation),
                  priceForCustomer(AGENT, product, variation));
});

test('a hide-prices customer does not blind the salesperson', async () => {
  const { identity } =
    await pricingIdentity(req(AGENT, { query: { forCustomer: 'u_dana' } }), fakeQuery());
  assert.equal(CUSTOMER.hide_prices, true, 'fixture really does hide prices');
  assert.equal(identity.hide_prices, false,
    'the rep must be able to read the prices they are quoting');
});

test('the source customer row is never mutated by forcing hide_prices off', async () => {
  await pricingIdentity(req(AGENT, { query: { forCustomer: 'u_dana' } }), fakeQuery());
  assert.equal(CUSTOMER.hide_prices, true, 'pricingIdentity copies, it does not mutate');
});

test('catalogue and cart resolve to the SAME identity from the same inputs', async () => {
  const fromCatalogue =
    await pricingIdentity(req(AGENT, { body: { customerId: 'u_dana' } }), fakeQuery());
  const fromCart =
    await pricingIdentity(req(AGENT, { query: { forCustomer: 'u_dana' } }), fakeQuery());
  assert.equal(fromCatalogue.identity.id, fromCart.identity.id);
  assert.equal(fromCatalogue.identity.currency, fromCart.identity.currency);
  assert.deepEqual(fromCatalogue.identity.pricing, fromCart.identity.pricing);
  assert.equal(priceForCustomer(fromCatalogue.identity, product, variation),
               priceForCustomer(fromCart.identity, product, variation),
               'the shelf and the cart must quote the same price');
});

test('the assisted identity carries the customer currency, not the actor\'s', async () => {
  const { identity } =
    await pricingIdentity(req(AGENT, { query: { forCustomer: 'u_dana' } }), fakeQuery());
  assert.equal(AGENT.currency, 'USD');
  assert.equal(identity.currency, 'CAD', 'a USD rep ordering for a CAD customer');
});

/* ---------------- no context = unchanged behaviour ---------------- */

test('without a target the actor is priced as themselves', async () => {
  const calls = [];
  const { identity, onBehalf } = await pricingIdentity(req(AGENT), fakeQuery(calls));
  assert.equal(onBehalf, false);
  assert.equal(identity, AGENT, 'used as-is, no copy, no lookup');
  assert.equal(calls.length, 0);
});

/* ---------------- authorisation is enforced on every priced route -------- */

test('an ordinary customer cannot request another customer\'s pricing context', async () => {
  const calls = [];
  const customerReq = req({ id: 'u_dana', role: 'customer' },
    { query: { forCustomer: 'u_rey' } });
  await assert.rejects(() => pricingIdentity(customerReq, fakeQuery(calls)), e => {
    assert.equal(e.status, 403);
    assert.equal(e.expose, true);
    return true;
  });
  assert.equal(calls.length, 0, 'refused on role alone, before any lookup');
});

test('a guest browsing cannot request a pricing context', async () => {
  const guest = { id: null, role: 'guest', hide_prices: true, pricing: { mode: 'none' } };
  await assert.rejects(
    () => pricingIdentity(req(guest, { body: { customerId: 'u_dana' } }), fakeQuery()),
    e => e.status === 403);
});

test('an agent cannot price the catalogue for someone else\'s customer', async () => {
  await assert.rejects(
    () => pricingIdentity(req(AGENT, { body: { customerId: 'u_rey' } }), fakeQuery()),
    e => e.status === 403 && /Not your customer/.test(e.message));
});

test('admin and super-agent may price for any active customer', async () => {
  for (const role of ['admin', 'super-agent']) {
    const { identity, onBehalf } = await pricingIdentity(
      req({ id: 'u_x', role }, { body: { customerId: 'u_rey' } }), fakeQuery());
    assert.equal(onBehalf, true);
    assert.equal(identity.id, 'u_rey');
  }
});

test('an inactive customer cannot be priced for', async () => {
  const dormant = { ...CUSTOMER, id: 'u_stale', status: 'pending' };
  const query = async () => ({ rows: [dormant] });
  await assert.rejects(
    () => pricingIdentity(req(AGENT, { body: { customerId: 'u_stale' } }), query),
    e => e.status === 400 && /not active/.test(e.message));
});
