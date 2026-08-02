/* Assisted context must FAIL CLOSED on a transient failure.

   Batch 1C cleared Store.actingFor on EVERY error from the checkout-context
   fetch — including a timeout or a 500 — and then carried on rendering. That
   silently switched the salesperson back to their OWN prices mid-order, under
   a banner that had just named the customer: exactly the mistake the assisted
   flow exists to prevent.

   A 400/403 is a DECISION (may no longer act for them) and does clear.
   Anything else says nothing about authorisation, so the customer stays
   selected and the render fails instead.

   ensureOrderingContext() is a browser function; its decision logic is
   reproduced here against the same responses. */
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
const money = (n, s) => effectiveFx(s).symbol + (Number(n) * effectiveFx(s).rate).toFixed(2);

function setActingFor(store, customer) {
  store.actingFor = customer || null;
  store.orderingFx = null;                       // a switch never keeps the old rate
}

/** Mirrors app.js ensureOrderingContext() after the Batch 1D correction. */
async function ensureOrderingContext(store, server, toasts = []) {
  const target = store.actingFor;
  if (!target) { store.orderingFx = null; return null; }
  if (store.orderingFx) return store.orderingFx;
  try {
    const ctx = await server(target.id);
    if (ctx?.fx) store.orderingFx = ctx.fx;
    if (ctx?.orderingFor) store.actingFor = { ...target, ...ctx.orderingFor };
    return store.orderingFx;
  } catch (e) {
    if (e.status === 403 || e.status === 400) {
      setActingFor(store, null);
      toasts.push('You can no longer order for that customer — back to your own account');
      return null;
    }
    throw Object.assign(
      new Error(`Couldn't load prices for ${target.business || 'this customer'}. `
        + 'Nothing was changed — please retry.'),
      { orderingContextUnavailable: true, cause: e });
  }
}

/** Mirrors route(): a thrown context error becomes a failure state, not a render. */
async function renderRoute(store, server) {
  const toasts = [];
  let contextError = null;
  try { await ensureOrderingContext(store, server, toasts); }
  catch (e) { contextError = e; }
  if (contextError) return { rendered: false, failureState: contextError.message, toasts };
  return { rendered: true, priceShown: money(100, store), toasts };
}

const usdActor = () => ({ fx: { currency: 'USD', rate: 1, symbol: '$' },
                          actingFor: null, orderingFx: null });
const CAD_CTX = { fx: { currency: 'CAD', rate: 1.37, symbol: 'CA$' },
                  orderingFor: { id: 'u_dana', business: 'Dana Optical', customerNumber: '1042' } };
const fail = status => async () => { throw Object.assign(new Error('nope'), { status }); };

/* ---------------- decisions: clear the context ---------------- */

test('403 clears assisted mode and returns to the actor\'s account', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });
  const r = await renderRoute(store, fail(403));
  assert.equal(store.actingFor, null, 'context dropped');
  assert.equal(r.rendered, true, 'the page renders — as the salesperson');
  assert.equal(r.priceShown, '$100.00');
  assert.match(r.toasts[0], /no longer order for that customer/);
});

test('400 (inactive customer) clears assisted mode the same way', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_stale', business: 'Dormant Optics' });
  const r = await renderRoute(store, fail(400));
  assert.equal(store.actingFor, null);
  assert.equal(r.rendered, true);
  assert.equal(r.toasts.length, 1);
});

/* ---------------- transient: keep the context, fail the render ------------- */

test('500 KEEPS the customer selected and does NOT render', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });
  const r = await renderRoute(store, fail(500));
  assert.equal(store.actingFor.id, 'u_dana', 'the selection survives a server fault');
  assert.equal(store.orderingFx, null, 'and no rate was invented');
  assert.equal(r.rendered, false, 'the page must not render the actor\'s prices');
  assert.match(r.failureState, /Couldn't load prices for Dana Optical/);
  assert.match(r.failureState, /Nothing was changed/);
  assert.deepEqual(r.toasts, [], 'no "back to your own account" message — we did not go back');
});

test('502/503/504 behave the same as 500', async () => {
  for (const status of [502, 503, 504]) {
    const store = usdActor();
    setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });
    const r = await renderRoute(store, fail(status));
    assert.equal(store.actingFor?.id, 'u_dana', `${status} must not clear the context`);
    assert.equal(r.rendered, false);
  }
});

test('a NETWORK rejection (no status) keeps the context and blocks the render', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });
  const r = await renderRoute(store, async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(store.actingFor?.id, 'u_dana');
  assert.equal(r.rendered, false);
  assert.match(r.failureState, /please retry/i);
});

test('the thrown error carries the original cause for diagnosis', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });
  const original = Object.assign(new Error('gateway timeout'), { status: 504 });
  await assert.rejects(
    () => ensureOrderingContext(store, async () => { throw original; }),
    e => {
      assert.equal(e.orderingContextUnavailable, true);
      assert.equal(e.cause, original);
      return true;
    });
});

test('401 is NOT handled here — the session layer owns it', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });
  // It falls into the transient branch and propagates; API.call performs the
  // login redirect, so the context is not silently discarded either.
  await assert.rejects(() => ensureOrderingContext(store, fail(401)));
  assert.equal(store.actingFor?.id, 'u_dana');
});

/* ---------------- retry ---------------- */

test('a successful RETRY hydrates the same customer correctly', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });

  let firstCall = true;
  const flaky = async id => {
    if (firstCall) { firstCall = false; throw Object.assign(new Error('boom'), { status: 500 }); }
    return CAD_CTX;
  };

  const first = await renderRoute(store, flaky);
  assert.equal(first.rendered, false);
  assert.equal(store.actingFor.id, 'u_dana', 'still selected, ready to retry');

  const second = await renderRoute(store, flaky);
  assert.equal(second.rendered, true);
  assert.equal(second.priceShown, 'CA$137.00', 'the customer\'s currency, not the actor\'s');
  assert.equal(store.actingFor.business, 'Dana Optical');
});

/* ---------------- switching still clears the previous rate ---------------- */

test('switching customers clears the previous FX before hydration, even after a failure', async () => {
  const store = usdActor();
  setActingFor(store, { id: 'u_dana', business: 'Dana Optical' });
  await renderRoute(store, async () => CAD_CTX);
  assert.equal(money(100, store), 'CA$137.00');

  // A 500 while switching must not leave the CAD rate applied to the new target.
  setActingFor(store, { id: 'u_paris', business: 'Paris Optique' });
  assert.equal(store.orderingFx, null, 'the previous customer\'s rate is dropped at once');
  const r = await renderRoute(store, fail(500));
  assert.equal(r.rendered, false);
  assert.equal(store.orderingFx, null, 'and no stale rate is left behind');
  assert.equal(store.actingFor.id, 'u_paris');
});

test('with no assisted context a transient failure cannot occur at all', async () => {
  const store = usdActor();
  let called = 0;
  const r = await renderRoute(store, async () => { called++; throw new Error('x'); });
  assert.equal(called, 0, 'nothing is fetched when nobody is selected');
  assert.equal(r.rendered, true);
  assert.equal(r.priceShown, '$100.00');
});
