/* The order transition contract.

   `sanitizeOrderPatch` checked that a status was one of the eight and nothing
   compared it to the status the order already had, so `PATCH /admin/orders`
   could move an order anywhere: a cancelled order revived into processing, a
   completed one sent back to pending from a list screen.

   (`shipped` was separately guarded and had been for some time, so the
   `pending → shipped → pending` example in the older handover notes was
   already unreachable. The class of defect was real; that instance was not.
   Test 4 pins it so the stale claim cannot quietly become true again.)

   THIS IS NOT A NEW LIFECYCLE. Every transition asserted below is one the
   shipped admin panel already performs, or one it already refuses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORDER_STATUSES, ORDER_TRANSITIONS, TERMINAL_ORDER_STATUSES,
  canTransitionOrder, transitionRefusal, sanitizeOrderPatch,
} from '../src/admin-data.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const ROOT = path.resolve(SRC, '..', '..', '..', '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ============ the workflows the panel actually performs ============ */

test('1 — the warehouse collection flow works end to end', () => {
  /* Exactly what js/pages_sales.js drives: Start scan, Finish collection,
     complete, then Save & Mark as Shipped. */
  const flow = ['pending', 'collecting', 'collected', 'completed', 'shipped'];
  for (let i = 0; i < flow.length - 1; i += 1) {
    assert.equal(canTransitionOrder(flow[i], flow[i + 1]), true,
      `${flow[i]} → ${flow[i + 1]} is part of the shipped workflow`);
  }
});

test('2 — the collection reset back to pending still works', () => {
  /* admin.js clears collected counts when an order returns to pending, and the
     panel relies on it. Removing this would break daily operations. */
  for (const from of ['collecting', 'collected', 'processing', 'approved']) {
    assert.equal(canTransitionOrder(from, 'pending'), true,
      `${from} → pending is the deliberate collection reset`);
  }
});

test('3 — the free status dropdown keeps working across the pre-finish states', () => {
  /* A status set in error must be correctable. Being stricter here would break
     the dropdown operations use daily, which is not a trade this run makes. */
  const working = ['pending', 'processing', 'approved', 'collecting', 'collected'];
  for (const from of working) {
    for (const to of working) {
      assert.equal(canTransitionOrder(from, to), true, `${from} → ${to}`);
    }
  }
});

test('3b — an order can be cancelled from any unfinished state', () => {
  for (const from of ['pending', 'processing', 'approved', 'collecting', 'collected', 'completed']) {
    assert.equal(canTransitionOrder(from, 'cancelled'), true, `${from} → cancelled`);
  }
});

test('3c — an order can be shipped from any unfinished state', () => {
  /* The panel's Save & Mark as Shipped is enabled whenever the order is not
     already shipped. */
  for (const from of ['pending', 'processing', 'approved', 'collecting', 'collected', 'completed']) {
    assert.equal(canTransitionOrder(from, 'shipped'), true, `${from} → shipped`);
  }
});

/* ============ what is now refused ============ */

test('4 — a shipped order cannot be un-shipped', () => {
  for (const to of ORDER_STATUSES.filter((s) => s !== 'shipped')) {
    assert.equal(canTransitionOrder('shipped', to), false, `shipped → ${to} must be refused`);
  }
  assert.match(transitionRefusal('shipped', 'pending'), /already shipped/);
});

test('4b — pending → shipped → pending is closed, both legs asserted', () => {
  /* The exact sequence the handover notes named. */
  assert.equal(canTransitionOrder('pending', 'shipped'), true);
  assert.equal(canTransitionOrder('shipped', 'pending'), false);
});

test('5 — a cancelled order cannot silently revive', () => {
  for (const to of ORDER_STATUSES.filter((s) => s !== 'cancelled')) {
    assert.equal(canTransitionOrder('cancelled', to), false, `cancelled → ${to} must be refused`);
  }
  assert.match(transitionRefusal('cancelled', 'processing'), /cannot be reopened/);
});

test('6 — a completed order cannot be returned to an earlier stage', () => {
  for (const to of ['pending', 'processing', 'approved', 'collecting', 'collected']) {
    assert.equal(canTransitionOrder('completed', to), false, `completed → ${to} must be refused`);
  }
  /* But it is not terminal: it can still be shipped or cancelled. */
  assert.equal(canTransitionOrder('completed', 'shipped'), true);
  assert.equal(canTransitionOrder('completed', 'cancelled'), true);
  assert.match(transitionRefusal('completed', 'pending'), /still be shipped or cancelled/);
});

/* ============ the contract is closed and well-formed ============ */

test('7 — every status has an explicit rule; none is missing by omission', () => {
  for (const status of ORDER_STATUSES) {
    assert.ok(Array.isArray(ORDER_TRANSITIONS[status]),
      `${status} has no transition rule, so it would be refused by accident rather than by decision`);
  }
  assert.deepEqual(Object.keys(ORDER_TRANSITIONS).sort(), [...ORDER_STATUSES].sort());
});

test('7b — every destination is a real status', () => {
  for (const [from, tos] of Object.entries(ORDER_TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(ORDER_STATUSES.includes(to), `${from} → ${to} names a status that does not exist`);
    }
  }
});

test('7c — staying put is always allowed, so a retry is not an error', () => {
  for (const status of ORDER_STATUSES) {
    assert.equal(canTransitionOrder(status, status), true, `${status} → ${status}`);
  }
});

test('7d — terminal states are exactly shipped and cancelled', () => {
  assert.deepEqual([...TERMINAL_ORDER_STATUSES].sort(), ['cancelled', 'shipped']);
  for (const status of TERMINAL_ORDER_STATUSES) {
    assert.deepEqual(ORDER_TRANSITIONS[status], [status],
      `${status} must have no exit through this route`);
  }
});

test('7e — an unknown current status is refused, not allowed', () => {
  /* A row in a state this build does not recognise is not one it should move. */
  for (const from of ['', null, undefined, 'archived', 'on_hold']) {
    assert.equal(canTransitionOrder(from, 'shipped'), false, `${from} → shipped`);
  }
});

test('7f — an unknown target is refused even from a valid state', () => {
  for (const to of ['archived', 'refunded', '', null, 'SHIPPED_FAST']) {
    assert.equal(canTransitionOrder('pending', to), false, `pending → ${to}`);
  }
});

test('7g — the comparison is case-insensitive, matching the patch validator', () => {
  /* sanitizeOrderPatch lowercases the incoming status, so the contract must
     agree or a capitalised value would be validated then refused. */
  assert.equal(sanitizeOrderPatch({ status: 'SHIPPED' }, { actorName: 'a' }).fields.status, 'shipped');
  assert.equal(canTransitionOrder('PENDING', 'SHIPPED'), true);
  assert.equal(canTransitionOrder('SHIPPED', 'PENDING'), false);
});

test('7h — no status was invented and none removed', () => {
  assert.deepEqual(ORDER_STATUSES, ['pending', 'processing', 'approved', 'collecting',
    'collected', 'completed', 'shipped', 'cancelled']);
});

/* ============ enforcement, in the route, on the locked row ============ */

test('8 — the route checks the contract against the LOCKED row', () => {
  const src = strip(fs.readFileSync(path.join(SRC, 'routes', 'admin.js'), 'utf8'));
  const lockAt = src.indexOf('from orders where id=$1 or number=$1 for update');
  const checkAt = src.indexOf('canTransitionOrder(order.status, patch.fields.status)');
  assert.ok(lockAt >= 0, 'the row is locked');
  assert.ok(checkAt > lockAt,
    'the check must run after the lock, or it validates a status that may already have moved');
  assert.match(src, /INVALID_ORDER_TRANSITION/);
  /* From the ORDER, never from the request — a client-supplied "from" would
     let a caller declare whatever origin made their move legal. */
  assert.ok(!/canTransitionOrder\(\s*(req|patch|body)/.test(src));
});

test('8b — the narrower shipped-only guard is gone, not merely supplemented', () => {
  /* Two guards for one property is how they drift apart. */
  const src = strip(fs.readFileSync(path.join(SRC, 'routes', 'admin.js'), 'utf8'));
  assert.ok(!/order\.status === 'shipped' && patch\.fields\.status/.test(src),
    'the old bespoke check should have been replaced by the contract');
});

test('9 — no other route writes an order status', () => {
  /* The contract is only closed if this is the single write path. */
  const routes = path.join(SRC, 'routes');
  const offenders = [];
  for (const f of fs.readdirSync(routes).filter((x) => x.endsWith('.js'))) {
    if (f === 'admin.js') continue;
    const code = strip(fs.readFileSync(path.join(routes, f), 'utf8'));
    for (const m of code.matchAll(/update orders set ([^`]*)/g)) {
      if (/\bstatus\s*=/.test(m[1])) offenders.push(`${f}: ${m[1].slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], 'an order status is written outside the contract');
});

test('9b — the generic sync cannot write an order at all', () => {
  const shape = fs.readFileSync(path.join(SRC, 'shape.js'), 'utf8');
  assert.ok(!/\borders:\s*\{/.test(shape),
    'orders are deliberately absent from the syncable collections');
});

test('10 — a credit-review hold is still respected alongside the contract', () => {
  /* Two independent gates on the same route. A transition that is legal by the
     contract must still be refused while the order awaits a credit decision. */
  const src = strip(fs.readFileSync(path.join(SRC, 'routes', 'admin.js'), 'utf8'));
  assert.match(src, /!creditReviewAllowsProgress\(order\.credit_review\)/);
  assert.match(src, /CREDIT_REVIEW_REQUIRED/);
  const creditAt = src.indexOf('creditReviewAllowsProgress(order.credit_review)');
  const lockAt = src.indexOf('from orders where id=$1 or number=$1 for update');
  assert.ok(creditAt > lockAt, 'and it too runs on the locked row');
});

test('11 — the audit trail still records what changed', () => {
  const src = strip(fs.readFileSync(path.join(SRC, 'routes', 'admin.js'), 'utf8'));
  assert.match(src, /'order updated', outcome\._number, describeOrderPatch\(patch\)/);
});

/* ============ the panel offers nothing the server refuses ============ */

test('12 — every status the panel can select is reachable from somewhere', () => {
  /* A dropdown entry the server always refuses is a button that never works. */
  const page = fs.readFileSync(path.join(ROOT, 'js', 'pages_sales.js'), 'utf8');
  const dropdown = /\['pending','processing','approved','collecting','collected','completed','cancelled'\]/;
  assert.match(page, dropdown, 'the panel dropdown is unchanged');

  const offered = ['pending', 'processing', 'approved', 'collecting', 'collected',
    'completed', 'cancelled'];
  for (const to of offered) {
    const reachable = ORDER_STATUSES.some((from) => from !== to && canTransitionOrder(from, to));
    assert.ok(reachable, `the panel offers ${to} but no transition reaches it`);
  }
});
