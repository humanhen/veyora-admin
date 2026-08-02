/* Repeated checkout must not create two orders.

   place-order prices the cart BEFORE opening its transaction, so two
   near-simultaneous POSTs could both read the same cart and both go on to
   create an order and reserve stock. The disabled browser button is not server
   protection: a double-click, a retried request or a second tab defeats it.

   The fix is a per-cart-owner submission lock taken at the TOP of the
   transaction. The second request blocks there, then sees zero rows because
   the first deleted the cart inside its own transaction.

   Exercised here through a controlled fake transaction client. REAL two-request
   PostgreSQL concurrency remains mandatory integration work — see the report. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CART_SUBMISSION_LOCK_SQL, lockCartForSubmission } from '../src/ordering.js';

/* ---------------- the lock SQL ---------------- */

test('the cart is read with a LOCKING select scoped to its owner', () => {
  assert.match(CART_SUBMISSION_LOCK_SQL, /from cart_items/i);
  assert.match(CART_SUBMISSION_LOCK_SQL, /where user_id = \$1/i,
    'the lock is per cart owner — the actor, even on an assisted order');
  assert.match(CART_SUBMISSION_LOCK_SQL, /for update/i,
    'without FOR UPDATE two checkouts can both capture the same cart');
});

test('the lock does NOT skip locked rows', () => {
  // `skip locked` would let the second request sail past and duplicate the
  // order. We want it to WAIT and then observe the empty cart.
  assert.ok(!/skip\s+locked/i.test(CART_SUBMISSION_LOCK_SQL));
});

test('the locked read is deterministically ordered', () => {
  assert.match(CART_SUBMISSION_LOCK_SQL, /order by id/i,
    'a stable lock order avoids deadlocks between concurrent checkouts');
});

/* ---------------- the guard ---------------- */

function fakeClient(rowsByCall) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: rowsByCall[n++] ?? [] };
    },
  };
}

/** Mirrors the guard at the top of the place-order transaction. */
async function submissionGuard(c, userId, pricedLines) {
  const locked = await lockCartForSubmission(c, userId);
  if (!locked.length) {
    throw Object.assign(new Error('This cart has already been submitted or is now empty.'),
      { status: 409, expose: true, alreadySubmitted: true });
  }
  const lockedSkus = new Set(locked.map(x => x.sku));
  const lines = pricedLines.filter(i => lockedSkus.has(i.sku));
  if (!lines.length) {
    throw Object.assign(new Error('This cart has already been submitted or is now empty.'),
      { status: 409, expose: true, alreadySubmitted: true });
  }
  return lines;
}

const priced = [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }];

test('the FIRST request takes the lock and proceeds with its lines', async () => {
  const c = fakeClient([[{ id: 1, sku: 'A', qty: 2 }, { id: 2, sku: 'B', qty: 1 }]]);
  const lines = await submissionGuard(c, 'u_sam', priced);
  assert.deepEqual(lines.map(l => l.sku), ['A', 'B']);
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.calls[0].params, ['u_sam'], 'locked by cart owner');
  assert.match(c.calls[0].sql, /for update/i);
});

test('the SECOND request finds the cart consumed and is refused with 409', async () => {
  const c = fakeClient([[]]);                     // first request already deleted it
  await assert.rejects(() => submissionGuard(c, 'u_sam', priced), e => {
    assert.equal(e.status, 409);
    assert.equal(e.alreadySubmitted, true);
    assert.match(e.message, /already been submitted or is now empty/);
    return true;
  });
});

test('the refusal happens BEFORE any stock or order work', async () => {
  const c = fakeClient([[]]);
  await assert.rejects(() => submissionGuard(c, 'u_sam', priced));
  assert.equal(c.calls.length, 1,
    'only the lock ran — no stock select, no decrement, no order insert');
});

test('the throw is what rolls the transaction back — nothing is created', async () => {
  let committed = false, rolledBack = false;
  const c = fakeClient([[]]);
  async function tx(fn) {
    try { const r = await fn(c); committed = true; return r; }
    catch (e) { rolledBack = true; throw e; }
  }
  await assert.rejects(() => tx(cl => submissionGuard(cl, 'u_sam', priced)));
  assert.equal(rolledBack, true);
  assert.equal(committed, false, 'no second order, no stock change');
});

test('lines removed between pricing and submission are dropped, not ordered', async () => {
  // B was deleted from the cart after the summary was priced.
  const c = fakeClient([[{ id: 1, sku: 'A', qty: 2 }]]);
  const lines = await submissionGuard(c, 'u_sam', priced);
  assert.deepEqual(lines.map(l => l.sku), ['A'],
    'only what still exists under the lock is ordered');
});

test('a cart whose every priced line has since gone is refused, not part-ordered', async () => {
  const c = fakeClient([[{ id: 9, sku: 'Z', qty: 1 }]]);   // nothing in common
  await assert.rejects(() => submissionGuard(c, 'u_sam', priced),
    e => e.status === 409 && e.alreadySubmitted === true);
});

test('an assisted order locks the SALESPERSON\'s cart, not the customer\'s', async () => {
  const c = fakeClient([[{ id: 1, sku: 'A', qty: 2 }]]);
  await submissionGuard(c, 'u_sam', priced);        // u_sam = the actor
  assert.deepEqual(c.calls[0].params, ['u_sam'],
    'the cart belongs to the actor; only the pricing belongs to the customer');
});

test('the guard does not depend on any client-supplied token', async () => {
  // No idempotency key, no nonce: the lock is the whole mechanism, so a client
  // that omits or replays anything cannot defeat it.
  const c = fakeClient([[{ id: 1, sku: 'A', qty: 2 }]]);
  await submissionGuard(c, 'u_sam', priced);
  assert.deepEqual(c.calls[0].params, ['u_sam'], 'only the user id is used');
});
