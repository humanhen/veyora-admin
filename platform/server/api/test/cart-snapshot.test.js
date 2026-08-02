/* Submit exactly the cart that was priced.

   The cart is priced OUTSIDE the transaction. Batch 1D locked it and checked
   only that the priced SKUs still existed, which let a changed cart through:
     - a stale quantity could be submitted;
     - a newly added row was silently ignored and then deleted with the cart;
     - a changed note or label set was lost;
     - a removed row was quietly dropped from a part-submitted order.

   The whole priced snapshot is now compared with the whole locked snapshot and
   ANY difference fails the checkout closed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCartSnapshots, normalizeCartRow, orderLinesForLocking,
  CART_SUBMISSION_LOCK_SQL, lockCartForSubmission,
} from '../src/ordering.js';

const priced = [
  { id: 'ci_1', sku: 'A', qty: 2, note: 'pack flat', labels: ['rush'] },
  { id: 'ci_2', sku: 'B', qty: 1, note: '', labels: [] },
];
const clone = rows => rows.map(r => ({ ...r, labels: [...(r.labels || [])] }));

/* ---------------- the locked snapshot carries what matters ---------------- */

test('the lock reads every field a submission must match on', () => {
  for (const col of ['id', 'sku', 'qty', 'note', 'labels']) {
    assert.match(CART_SUBMISSION_LOCK_SQL, new RegExp(`\\b${col}\\b`),
      `${col} must be in the locked snapshot`);
  }
  assert.match(CART_SUBMISSION_LOCK_SQL, /for update/i);
  assert.match(CART_SUBMISSION_LOCK_SQL, /where user_id = \$1/i);
});

/* ---------------- identical ---------------- */

test('an identical snapshot passes', () => {
  const r = compareCartSnapshots(priced, clone(priced));
  assert.equal(r.match, true);
  assert.deepEqual(r.changes, []);
});

test('row ORDER differences alone do not fail', () => {
  const reversed = clone(priced).reverse();
  assert.equal(compareCartSnapshots(priced, reversed).match, true,
    'rows are keyed, not positional');
});

test('equivalent-but-differently-typed values still match', () => {
  // pg can hand back a numeric as a string; jsonb labels as a parsed array.
  const locked = [
    { id: 'ci_1', sku: 'A', qty: '2', note: 'pack flat', labels: ['rush'] },
    { id: 'ci_2', sku: 'B', qty: 1, note: null, labels: null },
  ];
  assert.equal(compareCartSnapshots(priced, locked).match, true);
});

/* ---------------- every kind of change fails ---------------- */

test('a QUANTITY change fails', () => {
  const locked = clone(priced); locked[0].qty = 3;
  const r = compareCartSnapshots(priced, locked);
  assert.equal(r.match, false);
  assert.deepEqual(r.changes, [{ type: 'changed', key: 'id:ci_1', sku: 'A',
    field: 'qty', from: 2, to: 3 }]);
});

test('an ADDED row fails — it must not be ignored and then deleted', () => {
  const locked = clone(priced);
  locked.push({ id: 'ci_3', sku: 'C', qty: 5, note: '', labels: [] });
  const r = compareCartSnapshots(priced, locked);
  assert.equal(r.match, false);
  assert.deepEqual(r.changes, [{ type: 'added', key: 'id:ci_3', sku: 'C' }]);
});

test('a REMOVED row fails — the order must not be part-submitted', () => {
  const locked = [clone(priced)[0]];
  const r = compareCartSnapshots(priced, locked);
  assert.equal(r.match, false);
  assert.deepEqual(r.changes, [{ type: 'removed', key: 'id:ci_2', sku: 'B' }]);
});

test('a SKU change on the same row fails', () => {
  const locked = clone(priced); locked[0].sku = 'Z';
  const r = compareCartSnapshots(priced, locked);
  assert.equal(r.match, false);
  assert.ok(r.changes.some(c => c.field === 'sku' && c.from === 'A' && c.to === 'Z'));
});

test('a NOTE change fails', () => {
  const locked = clone(priced); locked[0].note = 'ship separately';
  const r = compareCartSnapshots(priced, locked);
  assert.equal(r.match, false);
  assert.deepEqual(r.changes.map(c => c.field), ['note']);
});

test('a note appearing where there was none fails', () => {
  const locked = clone(priced); locked[1].note = 'new note';
  assert.equal(compareCartSnapshots(priced, locked).match, false);
});

test('a LABELS change fails', () => {
  const locked = clone(priced); locked[0].labels = ['rush', 'fragile'];
  const r = compareCartSnapshots(priced, locked);
  assert.equal(r.match, false);
  assert.deepEqual(r.changes.map(c => c.field), ['labels']);
});

test('removing a label fails', () => {
  const locked = clone(priced); locked[0].labels = [];
  assert.equal(compareCartSnapshots(priced, locked).match, false);
});

test('REORDERING labels fails — fail closed, it is not the row we priced', () => {
  const p = [{ id: 'ci_1', sku: 'A', qty: 1, note: '', labels: ['x', 'y'] }];
  const l = [{ id: 'ci_1', sku: 'A', qty: 1, note: '', labels: ['y', 'x'] }];
  assert.equal(compareCartSnapshots(p, l).match, false);
});

test('several simultaneous changes are all reported', () => {
  const locked = clone(priced);
  locked[0].qty = 9;
  locked.pop();                                     // removes ci_2
  locked.push({ id: 'ci_9', sku: 'N', qty: 1, note: '', labels: [] });
  const r = compareCartSnapshots(priced, locked);
  assert.equal(r.match, false);
  assert.deepEqual(r.changes.map(c => c.type).sort(), ['added', 'changed', 'removed']);
});

/* ---------------- shape and edges ---------------- */

test('normalizeCartRow coerces safely and never throws', () => {
  assert.deepEqual(normalizeCartRow({}),
    { id: null, sku: '', qty: 0, note: '', labels: [] });
  assert.deepEqual(normalizeCartRow({ id: 7, sku: 5, qty: '3.9', note: null, labels: '["a"]' }),
    { id: '7', sku: '5', qty: 3, note: '', labels: ['a'] });
  assert.deepEqual(normalizeCartRow({ labels: 'not json' }).labels, ['not json']);
  assert.deepEqual(normalizeCartRow({ labels: { a: 1 } }).labels, []);
});

test('two empty snapshots match (the empty case is handled by the lock, not here)', () => {
  assert.equal(compareCartSnapshots([], []).match, true);
  assert.equal(compareCartSnapshots(null, undefined).match, true);
});

test('rows without ids fall back to matching on sku', () => {
  const p = [{ sku: 'A', qty: 1 }];
  assert.equal(compareCartSnapshots(p, [{ sku: 'A', qty: 1 }]).match, true);
  assert.equal(compareCartSnapshots(p, [{ sku: 'A', qty: 2 }]).match, false);
});

/* ---------------- the guard runs before any order work ---------------- */

function fakeClient(lockedRows) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: lockedRows };
  } };
}

/** Mirrors the guard sequence at the top of the place-order transaction. */
async function submissionGuard(c, userId, pricedRows) {
  const locked = await lockCartForSubmission(c, userId);
  if (!locked.length) {
    throw Object.assign(new Error('This cart has already been submitted or is now empty.'),
      { status: 409, alreadySubmitted: true });
  }
  const diff = compareCartSnapshots(pricedRows, locked);
  if (!diff.match) {
    throw Object.assign(new Error('Your cart changed while checkout was being prepared. '
      + 'Review it and submit again.'),
      { status: 409, cartChanged: true, changes: diff.changes });
  }
  return locked;
}

test('a mismatch is refused BEFORE any stock or order SQL', async () => {
  const locked = clone(priced); locked[0].qty = 3;
  const c = fakeClient(locked);
  await assert.rejects(() => submissionGuard(c, 'u_sam', priced), e => {
    assert.equal(e.status, 409);
    assert.equal(e.cartChanged, true);
    assert.match(e.message, /cart changed while checkout was being prepared/);
    assert.equal(e.changes[0].field, 'qty');
    return true;
  });
  assert.equal(c.calls.length, 1, 'only the cart lock ran — no stock, no order insert');
  assert.match(c.calls[0].sql, /for update/i);
});

test('an emptied cart still reports alreadySubmitted, not cartChanged', async () => {
  const c = fakeClient([]);
  await assert.rejects(() => submissionGuard(c, 'u_sam', priced), e => {
    assert.equal(e.alreadySubmitted, true);
    assert.equal(e.cartChanged, undefined,
      'a repeated submission is a different condition from a modified cart');
    return true;
  });
});

test('an unchanged cart passes the guard and proceeds', async () => {
  const c = fakeClient(clone(priced));
  const locked = await submissionGuard(c, 'u_sam', priced);
  assert.equal(locked.length, 2);
});

test('the comparison uses the ACTOR\'s cart on an assisted order', async () => {
  const c = fakeClient(clone(priced));
  await submissionGuard(c, 'u_sam', priced);     // u_sam = the salesperson
  assert.deepEqual(c.calls[0].params, ['u_sam'],
    'the cart belongs to the actor; only the pricing belongs to the customer');
});

/* ---------------- deterministic stock-lock order ---------------- */

test('two carts with opposite input order lock stock in the SAME order', () => {
  const forward = [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }];
  const backward = [{ sku: 'C' }, { sku: 'B' }, { sku: 'A' }];
  assert.deepEqual(orderLinesForLocking(forward).map(l => l.sku), ['A', 'B', 'C']);
  assert.deepEqual(orderLinesForLocking(backward).map(l => l.sku), ['A', 'B', 'C']);
  assert.deepEqual(
    orderLinesForLocking(forward).map(l => l.sku),
    orderLinesForLocking(backward).map(l => l.sku),
    'no lock-order cycle between two concurrent checkouts');
});

test('ordering does not mutate the caller\'s array', () => {
  const input = [{ sku: 'C' }, { sku: 'A' }];
  const out = orderLinesForLocking(input);
  assert.deepEqual(input.map(l => l.sku), ['C', 'A'], 'client order is untouched');
  assert.deepEqual(out.map(l => l.sku), ['A', 'C']);
  assert.notEqual(out, input, 'a copy is returned');
});

test('ordering preserves each line object intact', () => {
  const line = { sku: 'A', qty: 3, price: 90, note: 'n', labels: ['x'] };
  const [out] = orderLinesForLocking([line]);
  assert.equal(out, line, 'the same objects travel on, with their qty/price/note/labels');
});

test('ordering is a plain code-point compare, not locale-dependent', () => {
  const skus = ['b', 'A', 'a', 'B', '2057.81', '2057.8'];
  const once = orderLinesForLocking(skus.map(sku => ({ sku }))).map(l => l.sku);
  const again = orderLinesForLocking([...skus].reverse().map(sku => ({ sku }))).map(l => l.sku);
  assert.deepEqual(once, again, 'stable regardless of input order');
  assert.deepEqual(once, ['2057.8', '2057.81', 'A', 'B', 'a', 'b']);
});

test('ordering copes with missing or empty skus', () => {
  assert.deepEqual(orderLinesForLocking([]), []);
  assert.deepEqual(orderLinesForLocking(null), []);
  assert.equal(orderLinesForLocking([{ sku: 'B' }, {}, { sku: 'A' }]).length, 3);
});
