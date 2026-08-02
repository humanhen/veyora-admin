/* Terminal state is server-owned.

   The admin panel holds the whole dataset in the browser and pushes debounced
   row diffs. A save can therefore carry a snapshot taken BEFORE the
   transactional conversion endpoint ran, and the generic upsert happily wrote
   `open` over `converted`, blanked converted_order_id and deleted the items of
   a backorder that had already become a real order.

   Also pinned here: customer authorisation and stock eligibility are different
   facts, and only staff/stock decides the latter. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileBackorderSync, isBackorderProcessable, isTerminalBackorderStatus,
  CUSTOMER_BACKORDER, PROCESSABLE_BACKORDER_STATUSES, TERMINAL_BACKORDER_STATUSES,
} from '../src/ordering.js';

const converted = { status: 'converted', eligible: true, converted_order_id: 'o_99' };
const cancelled = { status: 'cancelled', eligible: false, converted_order_id: null };
const open = { status: 'open', eligible: false, converted_order_id: null };

/* ---------------- stale sync after conversion ---------------- */

test('a stale OPEN payload cannot reopen a converted backorder', () => {
  const r = reconcileBackorderSync(converted,
    { status: 'open', eligible: false, convertedOrderId: null });
  assert.equal(r.status, 'converted', 'terminal state wins');
  assert.equal(r.convertedOrderId, 'o_99', 'the link to the real order survives');
  assert.ok(r.regressed.some(x => /status converted -> open/.test(x)));
});

test('a stale payload cannot ERASE converted_order_id', () => {
  const r = reconcileBackorderSync(converted, { status: 'converted', convertedOrderId: null });
  assert.equal(r.convertedOrderId, 'o_99');
  assert.ok(r.regressed.some(x => /erase/.test(x)));
});

test('a stale payload cannot REPOINT converted_order_id at another order', () => {
  const r = reconcileBackorderSync(converted,
    { status: 'converted', convertedOrderId: 'o_someone_else' });
  assert.equal(r.convertedOrderId, 'o_99');
  assert.ok(r.regressed.some(x => /overwrite/.test(x)));
});

test('a stale ELIGIBLE toggle after conversion is ignored', () => {
  const r = reconcileBackorderSync(converted, { status: 'converted', eligible: false });
  assert.equal(r.eligible, true, 'eligibility is meaningless once converted');
  assert.ok(r.regressed.some(x => /eligible toggle/.test(x)));
});

test('the items of a converted backorder are not writable by a sync', () => {
  assert.equal(reconcileBackorderSync(converted, { status: 'converted' }).itemsWritable, false,
    'they are the record of what became an order and what was reserved');
  assert.equal(reconcileBackorderSync(open, { status: 'open' }).itemsWritable, true);
});

test('a cancelled backorder cannot be regressed to open or approved', () => {
  for (const status of ['open', 'approved']) {
    const r = reconcileBackorderSync(cancelled, { status });
    assert.equal(r.status, 'cancelled');
    assert.ok(r.regressed.length > 0);
  }
});

/* ---------------- legitimate edits still work ---------------- */

test('a normal edit on a live backorder passes through untouched', () => {
  const r = reconcileBackorderSync(open, { status: 'open', eligible: true, convertedOrderId: null });
  assert.equal(r.status, 'open');
  assert.equal(r.eligible, true, 'staff may still clear stock on a live record');
  assert.deepEqual(r.regressed, [], 'nothing was suppressed');
  assert.equal(r.itemsWritable, true);
});

test('cancelling a live backorder is allowed', () => {
  const r = reconcileBackorderSync(open, { status: 'cancelled' });
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(r.regressed, []);
});

test('a brand-new row is inserted as sent', () => {
  const r = reconcileBackorderSync(null, { status: 'open', eligible: true, convertedOrderId: null });
  assert.equal(r.status, 'open');
  assert.equal(r.eligible, true);
  assert.equal(r.itemsWritable, true);
});

test('an omitted eligible key leaves the stored value alone', () => {
  const r = reconcileBackorderSync({ ...open, eligible: true }, { status: 'open' });
  assert.equal(r.eligible, true, 'an older admin build must not blank it');
});

/* ---------------- double conversion ---------------- */

test('a second conversion cannot change a converted record', () => {
  // The route short-circuits on status==='converted' and returns the existing
  // order; even if a payload arrived, reconcile keeps everything as it stands.
  const r = reconcileBackorderSync(converted,
    { status: 'converted', convertedOrderId: 'o_99', eligible: true });
  assert.deepEqual(
    { s: r.status, o: r.convertedOrderId, e: r.eligible },
    { s: 'converted', o: 'o_99', e: true });
  assert.deepEqual(r.regressed, [], 'an identical payload is not a regression');
});

/* ---------------- status vocabulary ---------------- */

test('terminal and processable statuses are disjoint and complete', () => {
  for (const s of TERMINAL_BACKORDER_STATUSES) {
    assert.equal(isTerminalBackorderStatus(s), true);
    assert.ok(!PROCESSABLE_BACKORDER_STATUSES.includes(s));
  }
  for (const s of PROCESSABLE_BACKORDER_STATUSES) {
    assert.equal(isTerminalBackorderStatus(s), false);
  }
});

/* ---------------- authorisation vs eligibility ---------------- */

test('a customer-authorised backorder is processable, but not stock-cleared', () => {
  const bo = { status: 'open', customer_authorised: true, order_id: null, eligible: false };
  assert.equal(isBackorderProcessable(bo), true, 'staff may act on it');
  assert.equal(bo.eligible, false, 'but stock has not been cleared by anyone');
});

test('a backorder from a real order is already commercially authorised', () => {
  assert.equal(isBackorderProcessable(
    { status: 'open', order_id: 'o_1', customer_authorised: false }), true);
});

test('a legacy approved row stays recoverable rather than stranded', () => {
  assert.equal(isBackorderProcessable(
    { status: 'approved', order_id: null, customer_authorised: false }), true);
});

test('an unauthorised open record is not processable', () => {
  assert.equal(isBackorderProcessable(
    { status: 'open', order_id: null, customer_authorised: false }), false);
});

test('terminal records are never processable', () => {
  for (const status of ['converted', 'cancelled']) {
    assert.equal(isBackorderProcessable(
      { status, order_id: 'o_1', customer_authorised: true }), false);
  }
  assert.equal(isBackorderProcessable(null), false);
});

test('a customer action records authorisation and never stock eligibility', () => {
  // The compatibility endpoint writes customer_authorised, not eligible.
  assert.equal(CUSTOMER_BACKORDER.customerAuthorised, true);
  assert.equal(CUSTOMER_BACKORDER.eligible, false,
    'a customer confirming their own request cannot assert that stock exists');
});
