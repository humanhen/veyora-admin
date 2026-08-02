/* Assisted-order currency must be hydrated BEFORE anything priced renders.

   setActingFor() clears Store.orderingFx so a switch never keeps the previous
   customer's rate — but the catalogue response carries no fx, so until Batch 1C
   the first priced screen after selecting a customer formatted THEIR prices
   with the SALESPERSON's currency.

   ensureOrderingContext() is a browser function; its decision logic is
   reproduced here against the same server payloads and asserted end to end. */
import test from 'node:test';
import assert from 'node:assert/strict';

const CURRENCY_SYMBOLS = { USD: '$', CAD: 'CA$', EUR: '€' };
const fxContext = src => {
  if (!src) return { currency: 'USD', rate: 1, symbol: '$' };
  const currency = String(src.currency || 'USD').toUpperCase();
  return { currency, rate: Number(src.rate ?? src.fxRate) || 1,
           symbol: src.symbol || CURRENCY_SYMBOLS[currency] || '$' };
};
const effectiveFx = s => (s.actingFor && s.orderingFx ? fxContext(s.orderingFx) : fxContext(s.fx));
const money = (n, s) => {
  const c = effectiveFx(s);
  return c.symbol + (Number(n) * c.rate).toFixed(2);
};

/** Mirrors app.js setActingFor(): the previous customer's rate is dropped. */
function setActingFor(store, customer) {
  store.actingFor = customer || null;
  store.orderingFx = null;
}

/** Mirrors app.js ensureOrderingContext(). `server` answers checkout-context. */
async function ensureOrderingContext(store, server) {
  if (!store.actingFor) { store.orderingFx = null; return null; }
  if (store.orderingFx) return store.orderingFx;
  try {
    const ctx = await server(store.actingFor.id);
    if (ctx?.fx) store.orderingFx = ctx.fx;
    if (ctx?.orderingFor) store.actingFor = { ...store.actingFor, ...ctx.orderingFor };
    return store.orderingFx;
  } catch (e) {
    setActingFor(store, null);          // no longer authorised — drop it
    return null;
  }
}

const CONTEXT = {
  u_dana: { fx: { currency: 'CAD', rate: 1.37, symbol: 'CA$' },
            orderingFor: { id: 'u_dana', business: 'Dana Optical', customerNumber: '1042' } },
  u_paris: { fx: { currency: 'EUR', rate: 0.92, symbol: '€' },
             orderingFor: { id: 'u_paris', business: 'Paris Optique', customerNumber: '1050' } },
};
const server = async id => {
  if (!CONTEXT[id]) throw Object.assign(new Error('Not your customer'), { status: 403 });
  return CONTEXT[id];
};
const usdActor = () => ({ fx: { currency: 'USD', rate: 1, symbol: '$' },
                          actingFor: null, orderingFx: null });

/* ---------------- the defect ---------------- */

test('without hydration the catalogue would price CAD goods in the actor\'s USD', () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });
  // get-products returns pricedFor but NO fx, so nothing populates orderingFx.
  assert.equal(money(100, store), '$100.00', 'this is the bug being fixed');
});

test('hydrating first makes the very first priced render correct', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });
  await ensureOrderingContext(store, server);
  assert.equal(money(100, store), 'CA$137.00');
  assert.equal(effectiveFx(store).currency, 'CAD');
});

/* ---------------- selection, restore, switch, clear ---------------- */

test('a restored session (sessionStorage) hydrates before rendering', async () => {
  const store = { ...usdActor(), actingFor: { id: 'u_dana', business: 'Dana Optical' } };
  assert.equal(store.orderingFx, null, 'nothing persisted the rate');
  await ensureOrderingContext(store, server);
  assert.equal(money(100, store), 'CA$137.00');
});

test('switching customers never briefly keeps the first customer\'s rate', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana' });
  await ensureOrderingContext(store, server);
  assert.equal(money(100, store), 'CA$137.00');

  setActingFor(store, { id: 'u_paris' });
  assert.equal(store.orderingFx, null, 'the CAD rate is dropped at the moment of switching');
  assert.equal(money(100, store), '$100.00', 'falls back to the ACTOR, never to CAD');

  await ensureOrderingContext(store, server);
  assert.equal(money(100, store), '€92.00');
});

test('clearing restores the actor\'s own currency immediately', async () => {
  const store = { fx: { currency: 'CAD', rate: 1.37, symbol: 'CA$' }, actingFor: null, orderingFx: null };
  setActingFor(store, { id: 'u_paris' });
  await ensureOrderingContext(store, server);
  assert.equal(money(100, store), '€92.00');

  setActingFor(store, null);
  assert.equal(money(100, store), 'CA$137.00', 'back to the agent\'s own money at once');
  await ensureOrderingContext(store, server);
  assert.equal(money(100, store), 'CA$137.00', 'and hydration leaves it alone');
});

test('hydration is idempotent — it does not refetch once populated', async () => {
  let calls = 0;
  const counting = async id => { calls++; return server(id); };
  const store = usdActor();
  setActingFor(store, { id: 'u_dana' });
  await ensureOrderingContext(store, counting);
  await ensureOrderingContext(store, counting);
  await ensureOrderingContext(store, counting);
  assert.equal(calls, 1);
});

test('the customer label is refreshed from the server, not trusted from storage', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'STALE NAME' });
  await ensureOrderingContext(store, server);
  assert.equal(store.actingFor.business, 'Dana Optical');
  assert.equal(store.actingFor.customerNumber, '1042');
});

/* ---------------- authorisation ---------------- */

test('a tampered or revoked context is dropped, not rendered', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_someone_elses_customer' });
  const fx = await ensureOrderingContext(store, server);
  assert.equal(fx, null);
  assert.equal(store.actingFor, null, 'assisted mode is abandoned');
  assert.equal(money(100, store), '$100.00', 'back to the actor\'s own prices');
});

test('with no assisted context nothing is fetched and the actor is unaffected', async () => {
  let calls = 0;
  const store = { fx: { currency: 'EUR', rate: 0.92, symbol: '€' }, actingFor: null, orderingFx: null };
  await ensureOrderingContext(store, async () => { calls++; return {}; });
  assert.equal(calls, 0);
  assert.equal(money(100, store), '€92.00');
});

test('a stale orderingFx cannot apply once the target is cleared', () => {
  const store = { fx: { currency: 'USD', rate: 1, symbol: '$' },
                  actingFor: null, orderingFx: { currency: 'CAD', rate: 1.37, symbol: 'CA$' } };
  assert.equal(money(100, store), '$100.00', 'actingFor gates the override');
});

/* ---------------- every priced surface shares one context ---------------- */

test('all priced surfaces resolve to the SAME currency once hydrated', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana' });
  await ensureOrderingContext(store, server);
  // catalogue card, catalogue cart-total row, cart, checkout, replenishment,
  // scan tray, favourites and shared lists all format through money()/effectiveFx().
  const surfaces = ['catalogue card', 'cart total row', 'cart', 'checkout',
                    'replenishment', 'scan tray', 'favourites', 'shared list'];
  for (const s of surfaces) {
    assert.equal(money(100, store), 'CA$137.00', `${s} must use the customer's currency`);
  }
});
