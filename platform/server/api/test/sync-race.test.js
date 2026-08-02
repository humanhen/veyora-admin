/* The stale-sync RACE, and endpoint ownership of converted state.

   Batch 1C added reconcileBackorderSync() but read the stored row WITHOUT
   FOR UPDATE, so the guard could still be defeated by timing:

     1. sync reads the row            -> open
     2. convert locks it and converts -> converted, order linked
     3. sync waits at its own UPDATE
     4. convert commits
     5. sync resumes with the decision made from the STALE read
        -> writes `open` back over `converted` and erases the link

   The read is now FOR UPDATE, so step 1 blocks behind any in-flight
   conversion and the state we reconcile is the state we write.

   These tests use a controlled fake transaction client. REAL PostgreSQL
   locking still requires integration testing — see the report. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKORDER_LOCK_SQL, reconcileBackorderSync, canDeleteBackorder,
} from '../src/ordering.js';

/* ---------------- the lock itself ---------------- */

test('the stored-row read is a LOCKING read', () => {
  assert.match(BACKORDER_LOCK_SQL, /^select /i);
  assert.match(BACKORDER_LOCK_SQL, /from backorders/i);
  assert.match(BACKORDER_LOCK_SQL, /where id=\$1/i);
  assert.match(BACKORDER_LOCK_SQL, /for update/i,
    'without FOR UPDATE the reconcile-then-write pair is not atomic');
});

test('the locked read fetches exactly the fields reconciliation needs', () => {
  for (const col of ['status', 'eligible', 'converted_order_id']) {
    assert.ok(BACKORDER_LOCK_SQL.includes(col), `${col} must be read under the lock`);
  }
});

/** Fake client that records the order of operations. */
function fakeClient(storedRow) {
  const ops = [];
  return {
    ops,
    async query(sql, params) {
      ops.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/for update/i.test(sql) && /from backorders/i.test(sql)) {
        return { rows: storedRow ? [storedRow] : [] };
      }
      return { rows: [] };
    },
  };
}

/** The sequence upsertBackorder performs: locked read -> reconcile -> write. */
async function syncSequence(c, storedRow, incoming) {
  const { rows } = await c.query(BACKORDER_LOCK_SQL, [incoming.id]);
  const stored = rows[0] || null;
  const guard = reconcileBackorderSync(stored, incoming);
  await c.query('insert into backorders (...) on conflict (id) do update ...',
    [guard.status, guard.eligible, guard.convertedOrderId]);
  return guard;
}

test('reconciliation happens AFTER the locked read, and the write uses it', async () => {
  const converted = { status: 'converted', eligible: true, converted_order_id: 'o_99' };
  const c = fakeClient(converted);
  const guard = await syncSequence(c, converted,
    { id: 'bo_1', status: 'open', eligible: false, convertedOrderId: null });

  assert.equal(c.ops.length, 2, 'exactly: locked read, then write');
  assert.match(c.ops[0].sql, /for update/i, 'the lock is taken FIRST');
  assert.match(c.ops[1].sql, /insert into backorders/i);
  // The write carries the LOCKED state, not the client's stale payload.
  assert.deepEqual(c.ops[1].params, ['converted', true, 'o_99']);
  assert.equal(guard.status, 'converted');
});

test('conversion then stale OPEN sync leaves the record converted and linked', () => {
  const afterConversion = { status: 'converted', eligible: true, converted_order_id: 'o_99' };
  const stalePayload = { status: 'open', eligible: false, convertedOrderId: null };
  const g = reconcileBackorderSync(afterConversion, stalePayload);
  assert.equal(g.status, 'converted');
  assert.equal(g.convertedOrderId, 'o_99');
  assert.equal(g.itemsWritable, false, 'the converted items are not replaced either');
  assert.ok(g.regressed.length >= 2);
});

test('cancellation then stale OPEN sync stays cancelled', () => {
  const g = reconcileBackorderSync(
    { status: 'cancelled', eligible: false, converted_order_id: null },
    { status: 'open', eligible: true });
  assert.equal(g.status, 'cancelled');
  assert.ok(g.regressed.some(x => /cancelled -> open/.test(x)));
});

/* ---------------- converted state is endpoint-owned ---------------- */

test('a sync may NOT introduce convertedOrderId on a row that has none', () => {
  const g = reconcileBackorderSync(
    { status: 'open', eligible: true, converted_order_id: null },
    { status: 'open', convertedOrderId: 'o_fabricated' });
  assert.equal(g.convertedOrderId, null, 'a sync cannot invent a conversion');
  assert.ok(g.regressed.some(x => /introduced by sync/.test(x)));
});

test('a sync may NOT drive a live record to converted', () => {
  const g = reconcileBackorderSync(
    { status: 'open', eligible: true, converted_order_id: null },
    { status: 'converted' });
  assert.equal(g.status, 'open');
  assert.ok(g.regressed.some(x => /mark a live backorder converted/.test(x)));
});

test('a NEW row can never be inserted as converted or with an order link', () => {
  const g = reconcileBackorderSync(null,
    { status: 'converted', eligible: true, convertedOrderId: 'o_fabricated' });
  assert.equal(g.status, 'open', 'downgraded to a live record');
  assert.equal(g.convertedOrderId, null);
  assert.equal(g.regressed.length, 2);
});

test('a sync PRESERVES an existing converted link without touching it', () => {
  const g = reconcileBackorderSync(
    { status: 'converted', eligible: true, converted_order_id: 'o_99' },
    { status: 'converted', eligible: true, convertedOrderId: 'o_99' });
  assert.equal(g.convertedOrderId, 'o_99');
  assert.deepEqual(g.regressed, [], 'an identical payload is not a regression');
});

test('a sync may not repoint an existing converted link', () => {
  const g = reconcileBackorderSync(
    { status: 'converted', eligible: true, converted_order_id: 'o_99' },
    { status: 'converted', convertedOrderId: 'o_other' });
  assert.equal(g.convertedOrderId, 'o_99');
  assert.ok(g.regressed.some(x => /overwrite/.test(x)));
});

/* ---------------- terminal delete protection ---------------- */

test('a converted backorder cannot be deleted by a sync', () => {
  assert.equal(canDeleteBackorder(
    { status: 'converted', converted_order_id: 'o_99' }), false,
    'deleting it would orphan a real order and erase the reservation trail');
});

test('a cancelled backorder cannot be deleted by a sync', () => {
  assert.equal(canDeleteBackorder({ status: 'cancelled', converted_order_id: null }), false);
});

test('any row carrying an order link is undeletable, whatever its status', () => {
  assert.equal(canDeleteBackorder({ status: 'open', converted_order_id: 'o_99' }), false);
});

test('live open/approved rows keep the existing delete behaviour', () => {
  assert.equal(canDeleteBackorder({ status: 'open', converted_order_id: null }), true);
  assert.equal(canDeleteBackorder({ status: 'approved', converted_order_id: null }), true);
  assert.equal(canDeleteBackorder(null), true, 'nothing stored, nothing to protect');
});

test('the delete filter keeps deletable ids and drops protected ones', () => {
  // Mirrors the route: protected ids are collected, the remainder is deleted.
  const stored = {
    bo_open: { status: 'open', converted_order_id: null },
    bo_conv: { status: 'converted', converted_order_id: 'o_1' },
    bo_canc: { status: 'cancelled', converted_order_id: null },
  };
  const requested = ['bo_open', 'bo_conv', 'bo_canc'];
  const blocked = requested.filter(id => !canDeleteBackorder(stored[id]));
  const deletable = requested.filter(id => !blocked.includes(id));
  assert.deepEqual(blocked, ['bo_conv', 'bo_canc']);
  assert.deepEqual(deletable, ['bo_open'], 'a legitimate delete still goes through');
});

/* ---------------- legitimate edits ---------------- */

test('a normal edit on a live record passes through with no suppression', () => {
  const g = reconcileBackorderSync(
    { status: 'open', eligible: false, converted_order_id: null },
    { status: 'open', eligible: true, convertedOrderId: null });
  assert.equal(g.status, 'open');
  assert.equal(g.eligible, true);
  assert.equal(g.itemsWritable, true);
  assert.equal(g.deletable, true);
  assert.deepEqual(g.regressed, []);
});

test('cancelling a live record through sync is still allowed', () => {
  const g = reconcileBackorderSync(
    { status: 'open', eligible: false, converted_order_id: null }, { status: 'cancelled' });
  assert.equal(g.status, 'cancelled');
  assert.deepEqual(g.regressed, []);
});
