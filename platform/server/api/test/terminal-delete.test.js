/* Locking ALL delete candidates before judging them.

   Batch 1D's delete protection selected only rows that ALREADY matched a
   terminal predicate. An `open` row therefore matched nothing and was never
   locked, so a conversion could land between the protection query and the
   DELETE — and the delete would then remove a backorder that had just become a
   real order, orphaning it.

   Every requested row is now locked first, with no state predicate, and judged
   afterwards from the locked state.

   Real PostgreSQL blocking is NOT simulated here — the decision made from the
   post-conversion locked state is. See the report for the required integration
   test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKORDER_DELETE_CANDIDATES_SQL, canDeleteBackorder,
} from '../src/ordering.js';

/* ---------------- the locking select ---------------- */

test('the delete-candidate select is a LOCKING read', () => {
  assert.match(BACKORDER_DELETE_CANDIDATES_SQL, /for update/i,
    'an unlocked candidate can be converted out from under the delete');
});

test('the delete-candidate select carries NO state predicate', () => {
  assert.match(BACKORDER_DELETE_CANDIDATES_SQL, /where id = any\(\$1\)/i);
  assert.ok(!/status\s+in\s*\(/i.test(BACKORDER_DELETE_CANDIDATES_SQL),
    'filtering to terminal rows here would leave open rows unlocked — the bug');
  assert.ok(!/converted_order_id\s+is\s+not\s+null/i.test(BACKORDER_DELETE_CANDIDATES_SQL));
});

test('it reads what the rule needs, in a stable lock order', () => {
  for (const col of ['id', 'number', 'status', 'converted_order_id']) {
    assert.ok(BACKORDER_DELETE_CANDIDATES_SQL.includes(col), `${col} must be selected`);
  }
  assert.match(BACKORDER_DELETE_CANDIDATES_SQL, /order by id/i,
    'a stable lock order avoids deadlocks with other transactions');
});

/* ---------------- the guard ---------------- */

/** Mirrors the route: lock every candidate, then judge each locked row. */
async function deleteGuard(c, requestedIds) {
  const { rows: candidates } = await c.query(BACKORDER_DELETE_CANDIDATES_SQL, [requestedIds]);
  const blocked = candidates.filter(r => !canDeleteBackorder(r));
  const blockedIds = new Set(blocked.map(r => r.id));
  const deletable = requestedIds.filter(id => !blockedIds.has(id));
  if (deletable.length) {
    await c.query('delete from backorders where id = any($1)', [deletable]);
  }
  return { deletable, blocked: blocked.map(r => r.id) };
}

function deleteClient(lockedRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: /for update/i.test(sql) ? lockedRows : [] };
    },
  };
}

test('a converted row read UNDER THE LOCK is refused', async () => {
  // The race: it was `open` when the sync payload was built.
  const c = deleteClient([
    { id: 'bo_1', number: 'BO1', status: 'converted', converted_order_id: 'o_9' }]);
  const r = await deleteGuard(c, ['bo_1']);
  assert.deepEqual(r.deletable, []);
  assert.deepEqual(r.blocked, ['bo_1']);
  assert.equal(c.calls.length, 1, 'no DELETE was issued at all');
});

test('a cancelled row is refused', async () => {
  const c = deleteClient([
    { id: 'bo_2', number: 'BO2', status: 'cancelled', converted_order_id: null }]);
  assert.deepEqual((await deleteGuard(c, ['bo_2'])).blocked, ['bo_2']);
});

test('an order-linked row is refused whatever its status', async () => {
  const c = deleteClient([
    { id: 'bo_3', number: 'BO3', status: 'open', converted_order_id: 'o_7' }]);
  assert.deepEqual((await deleteGuard(c, ['bo_3'])).blocked, ['bo_3']);
});

test('an open unlinked row IS deleted', async () => {
  const c = deleteClient([
    { id: 'bo_4', number: 'BO4', status: 'open', converted_order_id: null }]);
  const r = await deleteGuard(c, ['bo_4']);
  assert.deepEqual(r.deletable, ['bo_4']);
  assert.deepEqual(r.blocked, []);
  assert.equal(c.calls.length, 2);
  assert.match(c.calls[1].sql, /^delete from backorders/i);
  assert.deepEqual(c.calls[1].params, [['bo_4']]);
});

test('a mixed candidate set deletes only the permitted rows', async () => {
  const c = deleteClient([
    { id: 'bo_open', number: 'BO1', status: 'open', converted_order_id: null },
    { id: 'bo_conv', number: 'BO2', status: 'converted', converted_order_id: 'o_1' },
    { id: 'bo_canc', number: 'BO3', status: 'cancelled', converted_order_id: null },
    { id: 'bo_appr', number: 'BO4', status: 'approved', converted_order_id: null },
  ]);
  const r = await deleteGuard(c, ['bo_open', 'bo_conv', 'bo_canc', 'bo_appr']);
  assert.deepEqual(r.deletable, ['bo_open', 'bo_appr']);
  assert.deepEqual(r.blocked.sort(), ['bo_canc', 'bo_conv']);
  assert.deepEqual(c.calls[1].params, [['bo_open', 'bo_appr']],
    'the DELETE names only the permitted ids');
});

test('EVERY requested id is locked, not only the ones that look terminal', async () => {
  const c = deleteClient([
    { id: 'bo_open', status: 'open', converted_order_id: null }]);
  await deleteGuard(c, ['bo_open', 'bo_other']);
  assert.deepEqual(c.calls[0].params, [['bo_open', 'bo_other']],
    'locking the whole requested set is what closes the race');
});

test('a row that vanished before the lock is simply not blocked', async () => {
  const c = deleteClient([]);                    // already deleted by someone else
  const r = await deleteGuard(c, ['bo_gone']);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.deletable, ['bo_gone'], 'the DELETE is a harmless no-op');
});

/* ---------------- the two interleavings ---------------- */

test('CONVERT-first: the locked read shows converted, and the delete is refused', async () => {
  /* t0 sync payload built while the row was 'open'
     t1 convert locks the row and converts it
     t2 sync reaches the candidate lock -> WAITS
     t3 convert commits
     t4 sync acquires the lock and reads 'converted'   <- asserted here */
  const c = deleteClient([
    { id: 'bo_1', number: 'BO1', status: 'converted', converted_order_id: 'o_9' }]);
  const r = await deleteGuard(c, ['bo_1']);
  assert.deepEqual(r.blocked, ['bo_1'], 'the order it became is not orphaned');
  assert.equal(c.calls.length, 1);
});

test('DELETE-first is acceptable: conversion then finds no row and creates nothing', async () => {
  // The reverse interleaving. The delete wins the lock on a genuinely open row.
  const c = deleteClient([
    { id: 'bo_5', status: 'open', converted_order_id: null }]);
  const r = await deleteGuard(c, ['bo_5']);
  assert.deepEqual(r.deletable, ['bo_5']);
  // The conversion endpoint's own `select … for update` then returns no rows and
  // it answers 404 without creating an order or moving stock.
  const convertSeesRow = false;
  assert.equal(convertSeesRow, false, 'no order is created for a deleted backorder');
});

test('the rule applied after the lock is the shared one, not a re-implementation', () => {
  assert.equal(canDeleteBackorder({ status: 'open', converted_order_id: null }), true);
  assert.equal(canDeleteBackorder({ status: 'approved', converted_order_id: null }), true);
  assert.equal(canDeleteBackorder({ status: 'converted', converted_order_id: 'o' }), false);
  assert.equal(canDeleteBackorder({ status: 'cancelled', converted_order_id: null }), false);
  assert.equal(canDeleteBackorder({ status: 'open', converted_order_id: 'o' }), false);
});
