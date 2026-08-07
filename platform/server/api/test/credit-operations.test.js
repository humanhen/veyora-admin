/* Credit OPERATIONS: the two workflows that make the credit control usable.

     - staff maintaining a customer's credit limit;
     - staff resolving an order the server held for being over that limit.

   THE DISTINCTION THIS SUITE EXISTS TO PROTECT: approving one over-limit order
   is not the same act as raising the ceiling, and must never imply it. They
   have different capabilities, different routes, and different consequences —
   an approval changes exactly one order and leaves `users.credit_limit`
   untouched.

   The database double filters rows itself, so — as the returns suite learned —
   anything the SQL is responsible for is asserted against the query text too. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDIT_REVIEW_CAPABILITY, CREDIT_REVIEW_STATES, CREDIT_LIMIT_CAPABILITY,
  CreditError, applyCreditReviewDecision, creditReviewAllowsProgress,
  creditReviewSnapshot, evaluateOrderCredit,
} from '../src/credit.js';
import {
  decideCreditReview, listCreditReviews, setCreditLimit,
} from '../src/routes/admin-credit.js';
import { PERMISSION_KEYS } from '../src/permission-registry.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const ROOT = path.resolve(SRC, '..', '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const ACTOR = { id: 'staff-1', business: 'Veyora Credit Control', role: 'admin' };
const OTHER = { id: 'staff-2', business: 'Someone Else', role: 'admin' };

/** A pending review as the order route would have stamped it. */
const pendingReview = (over = {}) => ({
  ...creditReviewSnapshot({
    reviewRequired: true,
    decision: 'credit_review_required',
    projectedExposureMinor: 600000,
    creditLimitMinor: 500000,
    overLimitByMinor: 100000,
    orderTotalMinor: 200000,
    currency: 'USD',
    evaluatedAt: '2026-08-07T09:00:00.000Z',
  }),
  ...over,
});

function world(over = {}) {
  return {
    users: [
      { id: 'c1', business: 'Optika Ltd', email: 'a@example.test', role: 'customer',
        balance: '4000.00', credit_limit: '5000.00', currency: 'USD', payment_terms: 30 },
      { id: 'c2', business: 'Other Ltd', email: 'b@example.test', role: 'customer',
        balance: '0.00', credit_limit: null, currency: 'USD', payment_terms: 60 },
    ],
    orders: [
      { id: 'o1', number: 'SO-100', customer_id: 'c1', total: '2000.00', status: 'pending',
        created_at: '2026-08-07T09:00:00.000Z', invoice_id: null, credit_review: pendingReview() },
      { id: 'o2', number: 'SO-200', customer_id: 'c2', total: '100.00', status: 'pending',
        created_at: '2026-08-06T09:00:00.000Z', invoice_id: null, credit_review: null },
    ],
    audit: [],
    ...over,
  };
}

function makeDb(w) {
  const db = {
    calls: [],
    async query(sql, params = []) {
      db.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('select o.id, o.number, o.total, o.status, o.created_at')) {
        let rows = w.orders.filter((o) => o.credit_review);
        if (params.length) rows = rows.filter((o) => o.credit_review.state === params[0]);
        return {
          rows: rows.map((o) => {
            const u = w.users.find((x) => x.id === o.customer_id) || {};
            return { ...o, business: u.business, payment_terms: u.payment_terms };
          }),
        };
      }
      if (s.startsWith('select o.id, o.number, o.customer_id, o.credit_review')) {
        const rows = w.orders.filter((o) => o.id === params[0] || o.number === params[0]);
        return {
          rows: rows.map((o) => {
            const u = w.users.find((x) => x.id === o.customer_id) || {};
            return { ...o, business: u.business };
          }),
        };
      }
      if (s.startsWith('update orders set credit_review')) {
        const o = w.orders.find((x) => x.id === params[0]);
        if (o) o.credit_review = JSON.parse(params[1]);
        return { rows: [] };
      }
      if (s.startsWith('select id, business, email, credit_limit, role from users')) {
        return { rows: w.users.filter((u) => u.id === params[0]) };
      }
      if (s.startsWith('select id, balance, credit_limit, currency from users')) {
        return { rows: w.users.filter((u) => u.id === params[0]) };
      }
      if (s.startsWith('select coalesce(sum(total), 0)')) {
        const mine = w.orders.filter((o) => o.customer_id === params[0]
          && !o.invoice_id && o.status !== 'cancelled');
        return {
          rows: [{
            total: mine.reduce((t, o) => t + Number(o.total || 0), 0).toFixed(2),
            orders: mine.length, currencies: 1, sample_currency: 'USD',
          }],
        };
      }
      if (s.startsWith('update users set credit_limit')) {
        const u = w.users.find((x) => x.id === params[0]);
        if (u) u.credit_limit = params[1];
        return { rows: [] };
      }
      if (s.startsWith('insert into audit_log')) { w.audit.push(params); return { rows: [] }; }
      throw new Error(`the double was asked something unexpected: ${s.slice(0, 90)}`);
    },
    async tx(fn) { return fn(db); },
  };
  return db;
}

const rejects = (p, re) => assert.rejects(p, (e) => {
  assert.ok(e instanceof CreditError, `expected a CreditError, got ${e.name}: ${e.message}`);
  assert.match(e.body?.error ?? e.message, re);
  return true;
});

/* ============ 1–10 — admin credit limit ============ */

test('1 — an authorised reader sees the authoritative position, gated by capability', () => {
  const code = strip(read('routes', 'admin-credit.js'));
  assert.match(code, /r\.get\('\/customers\/:customerId\/credit', canSetLimit\(\)/);
  assert.match(code, /creditPosition\(liveDb, req\.params\.customerId\)/,
    'the figures come from the server calculation, not from a request');
});

test('2–4 — a fixture limit can be set, zeroed and cleared', async () => {
  const w = world();
  await setCreditLimit(makeDb(w), 'c2', { creditLimit: '25000', reason: 'board minute 41' }, ACTOR);
  assert.equal(w.users[1].credit_limit, '25000.00');

  await setCreditLimit(makeDb(w), 'c2', { creditLimit: '0', reason: 'pro forma only' }, ACTOR);
  assert.equal(w.users[1].credit_limit, '0.00', 'zero is a real, deliberate limit');

  await setCreditLimit(makeDb(w), 'c2', { creditLimit: '', reason: 'set in error' }, ACTOR);
  assert.equal(w.users[1].credit_limit, null, 'cleared to NOT CONFIGURED, which is not zero');
});

test('5 — a reason is required', async () => {
  const w = world();
  await rejects(setCreditLimit(makeDb(w), 'c1', { creditLimit: '9000' }, ACTOR), /reason is required/i);
  assert.equal(w.users[0].credit_limit, '5000.00', 'and nothing was written');
});

test('6 — a stale update is rejected', async () => {
  const w = world();
  await rejects(setCreditLimit(makeDb(w), 'c1',
    { creditLimit: '9000', reason: 'raise', expectedCurrentLimit: '1000' }, ACTOR),
  /changed while you were editing/);
  assert.equal(w.users[0].credit_limit, '5000.00');
});

test('7–8 — the capability gates the route, and no customer route exists', () => {
  const code = strip(read('routes', 'admin-credit.js'));
  assert.match(code, /requirePermission\(CREDIT_LIMIT_CAPABILITY\)/);
  /* Nothing customer-facing writes the column, anywhere. */
  for (const f of ['account.js', 'orders.js', 'cart.js', 'catalog.js', 'agent.js']) {
    const c = strip(read('routes', f));
    assert.ok(!/credit_limit\s*=/.test(c) && !/set credit_limit/i.test(c),
      `${f} must not write credit_limit`);
  }
});

test('9 — the generic sync cannot mutate credit_limit', () => {
  const shape = read('shape.js');
  const users = shape.slice(shape.indexOf('users: {'), shape.indexOf('promotions: {'));
  assert.ok(!/credit_limit|creditLimit/.test(users));
});

test('10 — the audit evidence is correct and complete', async () => {
  const w = world();
  await setCreditLimit(makeDb(w), 'c1',
    { creditLimit: '12000', reason: 'annual review' }, ACTOR);
  assert.equal(w.audit.length, 1);
  const [actorId, actorName, , action, target, , changes, payload] = w.audit[0];
  assert.equal(actorId, 'staff-1');
  assert.equal(actorName, 'Veyora Credit Control');
  assert.equal(action, 'credit limit changed');
  assert.equal(target, 'Optika Ltd');
  assert.match(changes, /5000\.00 → 12000\.00/);
  const body = JSON.parse(payload);
  assert.equal(body.previousLimit, '5000.00');
  assert.equal(body.newLimit, '12000.00');
  assert.equal(body.reason, 'annual review');
  assert.equal(body.capability, CREDIT_LIMIT_CAPABILITY);
});

/* ============ 11–14 — the review queue ============ */

test('11 — an over-limit order appears in the queue', async () => {
  const reviews = await listCreditReviews(makeDb(world()), 'pending');
  assert.deepEqual(reviews.map((r) => r.orderNumber), ['SO-100']);
  const [r] = reviews;
  assert.equal(r.state, 'pending');
  assert.equal(r.customerBusiness, 'Optika Ltd');
  assert.equal(r.paymentTerms, '30');
  assert.equal(r.overLimitByMinor, 100000, 'and it says why review was triggered');
  assert.equal(r.creditLimitMinor, 500000);
  assert.equal(r.projectedExposureMinor, 600000);
});

test('12 — a within-limit order does not', async () => {
  const reviews = await listCreditReviews(makeDb(world()), 'all');
  assert.ok(!reviews.some((r) => r.orderNumber === 'SO-200'),
    'an order that needed no decision carries no review');
});

test('13 — an account with no configured limit produces no review', async () => {
  const w = world();
  w.users[1].credit_limit = null;
  w.users[1].balance = '999999.00';
  const e = await evaluateOrderCredit(makeDb(w), 'c2', '5000.00');
  assert.equal(e.reviewRequired, false, 'no limit means no credit decision, not a failed one');
  assert.equal(creditReviewSnapshot(e), null);
});

test('14 — an unsupported exposure requires review and says so', () => {
  const snap = creditReviewSnapshot({
    reviewRequired: true, decision: 'exposure_unsupported',
    projectedExposureMinor: 0, creditLimitMinor: 500000, overLimitByMinor: 0,
    orderTotalMinor: 100, currency: 'USD', evaluatedAt: '2026-08-07T00:00:00.000Z',
  });
  assert.equal(snap.state, CREDIT_REVIEW_STATES.pending);
  assert.equal(snap.decision, 'exposure_unsupported',
    'the reason is preserved — it is a different problem from being over the limit');
});

/* ============ 15–21 — resolving a review ============ */

test('15–16 — only the review capability may resolve, and it is not the limit one', () => {
  const code = strip(read('routes', 'admin-credit.js'));
  assert.match(code, /const canReview = \(\) => requirePermission\(CREDIT_REVIEW_CAPABILITY\)/);
  assert.match(code, /r\.post\('\/reviews\/:orderId\/decision', canReview\(\)/);
  assert.notEqual(CREDIT_REVIEW_CAPABILITY, CREDIT_LIMIT_CAPABILITY);
  assert.ok(PERMISSION_KEYS.includes(CREDIT_REVIEW_CAPABILITY));

  /* No customer-facing surface can reach it. */
  for (const f of ['account.js', 'orders.js', 'cart.js', 'agent.js']) {
    const c = strip(read('routes', f));
    assert.ok(!/credit_review\s*=/.test(c), `${f} must not write credit_review`);
    assert.ok(!/decideCreditReview/.test(c), `${f} must not resolve a review`);
  }
});

test('17–19 — an authorised approval succeeds and records actor, time and reason', async () => {
  const w = world();
  const before = w.orders[0].credit_review;
  const res = await decideCreditReview(makeDb(w), 'SO-100',
    { resolution: 'approved', reason: 'Long-standing account, goods already allocated' }, ACTOR);

  assert.equal(res.state, 'approved');
  assert.equal(res.resolution, 'approved');
  assert.equal(res.creditLimitChanged, false);

  const after = w.orders[0].credit_review;
  assert.equal(after.state, 'approved');
  assert.equal(after.resolvedBy, 'staff-1');
  assert.equal(after.resolvedByName, 'Veyora Credit Control');
  assert.match(after.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(after.resolutionReason, 'Long-standing account, goods already allocated');

  /* 20 — the ORIGINAL calculation is untouched. */
  assert.equal(after.projectedExposureMinor, before.projectedExposureMinor);
  assert.equal(after.creditLimitMinor, before.creditLimitMinor);
  assert.equal(after.overLimitByMinor, before.overLimitByMinor);
  assert.equal(after.orderTotalMinor, before.orderTotalMinor);
  assert.equal(after.evaluatedAt, before.evaluatedAt);
  assert.equal(after.decision, before.decision);
});

test('18b — a reason is required for either decision', async () => {
  for (const resolution of ['approved', 'declined']) {
    const w = world();
    await rejects(decideCreditReview(makeDb(w), 'SO-100', { resolution }, ACTOR),
      /reason is required/i);
    assert.equal(w.orders[0].credit_review.state, 'pending', 'nothing was written');
  }
});

test('18c — only approve or decline is accepted', async () => {
  for (const resolution of ['maybe', '', 'pending', 'APPROVED_LATER', null]) {
    const w = world();
    await rejects(
      decideCreditReview(makeDb(w), 'SO-100', { resolution, reason: 'x' }, ACTOR),
      /approved or declined/);
  }
});

test('20b — the original snapshot is preserved even against a hostile body', async () => {
  /* A caller restating the limit or the exposure must not be able to make an
     approval look justified after the fact. */
  const w = world();
  await decideCreditReview(makeDb(w), 'SO-100', {
    resolution: 'approved', reason: 'ok',
    projectedExposureMinor: 1, creditLimitMinor: 99999999, overLimitByMinor: 0,
    orderTotalMinor: 1, evaluatedAt: '1999-01-01T00:00:00.000Z', decision: 'within_limit',
    state: 'approved', resolvedByName: 'Somebody Else',
  }, ACTOR);
  const r = w.orders[0].credit_review;
  assert.equal(r.projectedExposureMinor, 600000);
  assert.equal(r.creditLimitMinor, 500000);
  assert.equal(r.evaluatedAt, '2026-08-07T09:00:00.000Z');
  assert.equal(r.decision, 'credit_review_required');
  assert.equal(r.resolvedByName, 'Veyora Credit Control', 'the actor comes from the session');
});

test('21 — a duplicate or stale decision is refused deterministically', async () => {
  const w = world();
  const db = makeDb(w);
  await decideCreditReview(db, 'SO-100', { resolution: 'approved', reason: 'first' }, ACTOR);

  /* A second click, and a different person arriving late, both get the same
     answer — and the first decision stands. */
  for (const actor of [ACTOR, OTHER]) {
    await rejects(
      decideCreditReview(makeDb(w), 'SO-100', { resolution: 'declined', reason: 'second' }, actor),
      /already approved by Veyora Credit Control/);
  }
  assert.equal(w.orders[0].credit_review.state, 'approved');
  assert.equal(w.orders[0].credit_review.resolutionReason, 'first');
});

test('21b — the decision row is locked before it is read', async () => {
  const w = world();
  const db = makeDb(w);
  await decideCreditReview(db, 'SO-100', { resolution: 'declined', reason: 'x' }, ACTOR);
  const lock = db.calls.find((c) => /for update/.test(c.sql));
  assert.ok(lock, 'the order row is locked');
  assert.match(lock.sql, /for update of o/,
    'and only the order — the join to users must not be locked with it');
});

test('21c — an order with no review cannot be "resolved"', async () => {
  const w = world();
  await rejects(decideCreditReview(makeDb(w), 'SO-200',
    { resolution: 'approved', reason: 'x' }, ACTOR), /not awaiting a credit decision/);
});

test('21d — an unknown order is refused', async () => {
  await rejects(decideCreditReview(makeDb(world()), 'SO-NOPE',
    { resolution: 'approved', reason: 'x' }, ACTOR), /could not be found/);
});

/* ============ 22–24 — what the decision does to the order ============ */

test('22 — an approved order may enter the existing downstream flow', () => {
  assert.equal(creditReviewAllowsProgress({ state: 'approved' }), true);
  /* And an order that never needed a decision is unaffected. */
  assert.equal(creditReviewAllowsProgress(null), true);
  assert.equal(creditReviewAllowsProgress(undefined), true);
});

test('23 — a pending or declined order cannot silently progress', () => {
  assert.equal(creditReviewAllowsProgress({ state: 'pending' }), false);
  assert.equal(creditReviewAllowsProgress({ state: 'declined' }), false);
  /* A state this build does not understand is refused, not allowed: a review
     whose shape we cannot read is not one we may act on. */
  assert.equal(creditReviewAllowsProgress({ state: 'something_new' }), false);
  assert.equal(creditReviewAllowsProgress({}), false);
});

test('23b — the block is enforced on the order route, on the locked row', () => {
  const admin = strip(read('routes', 'admin.js'));
  assert.match(admin, /!creditReviewAllowsProgress\(order\.credit_review\)/);
  assert.match(admin, /CREDIT_REVIEW_REQUIRED/);
  /* After the row is locked, so the check and the write see the same row. */
  const at = admin.indexOf('creditReviewAllowsProgress(order.credit_review)');
  const lockAt = admin.indexOf('from orders where id=$1 or number=$1 for update');
  assert.ok(lockAt >= 0 && lockAt < at, 'the row is locked before the check');
  /* And it is a STATUS guard: administering a held order must stay possible. */
  assert.match(admin, /patch\.fields\.status\s*\r?\n?\s*&& patch\.fields\.status !== order\.status/);
  assert.match(admin, /!PENDING_ORDER_STATUSES\.includes\(patch\.fields\.status\)/);
});

test('23c — invoicing is blocked too, since it books the exposure anyway', () => {
  const finance = strip(read('routes', 'admin-finance.js'));
  assert.match(finance, /!creditReviewAllowsProgress\(order\.credit_review\)/);
  assert.match(finance, /credit_review\s*\r?\n?\s*from orders where id = \$1/,
    'the column is selected, or the guard would read undefined and pass');
});

test('24 — approving an exception never changes the credit limit', async () => {
  const w = world();
  const limitBefore = w.users[0].credit_limit;
  const db = makeDb(w);
  await decideCreditReview(db, 'SO-100', { resolution: 'approved', reason: 'exception' }, ACTOR);
  assert.equal(w.users[0].credit_limit, limitBefore, 'the ceiling is exactly what it was');

  /* Not merely unchanged by accident: the route never issues the statement. */
  const writes = db.calls.filter((c) => /update users/.test(c.sql));
  assert.deepEqual(writes, [], 'the decision path never writes to users');

  const decision = strip(read('routes', 'admin-credit.js'));
  const fn = decision.slice(decision.indexOf('export async function decideCreditReview'));
  const body = fn.slice(0, fn.indexOf('\nexport async function setCreditLimit'));
  assert.ok(!/credit_limit/.test(body), 'and never names the column');
});

/* ============ 25 — isolation ============ */

test('25 — a review never exposes another customer\'s financial detail', async () => {
  const reviews = await listCreditReviews(makeDb(world()), 'all');
  for (const r of reviews) {
    /* Only the figures for THIS order's own account, and only the allowlisted
       fields — no balance, no other customer, nothing spread from the row. */
    assert.deepEqual(Object.keys(r).sort(), [
      'creditLimitMinor', 'currency', 'customerBusiness', 'customerId', 'decision',
      'evaluatedAt', 'orderId', 'orderNumber', 'orderStatus', 'orderTotal',
      'orderTotalMinor', 'overLimitByMinor', 'paymentTerms', 'projectedExposureMinor',
      'resolution', 'resolutionReason', 'resolvedAt', 'resolvedByName', 'state',
      'submittedAt',
    ]);
    assert.ok(!('balance' in r) && !('email' in r));
  }
  const c1 = reviews.filter((r) => r.customerId === 'c1');
  assert.ok(c1.every((r) => r.customerBusiness === 'Optika Ltd'));
});

test('25b — EVERY queue query is bounded and ordered, as issued', async () => {
  /* Asserting the string appears somewhere in the file would pass while one of
     the two branches was unbounded — it was caught doing exactly that. These
     are the queries actually issued. */
  for (const state of ['pending', 'approved', 'declined', 'all']) {
    const db = makeDb(world());
    await listCreditReviews(db, state);
    const [call] = db.calls;
    assert.match(call.sql, /limit 200/,
      `the ${state} queue is unbounded — a denial of service on the admin panel`);
    assert.match(call.sql, /order by o\.created_at desc/, `the ${state} queue is unordered`);
  }
});

test('25d — the decision scopes to the order it names, in SQL', async () => {
  /* The double resolves the id itself, so test 21d would still pass if the
     predicate were dropped and every caller silently decided the first row. */
  const db = makeDb(world());
  await decideCreditReview(db, 'SO-100', { resolution: 'approved', reason: 'x' }, ACTOR);
  const lookup = db.calls.find((c) => /for update of o/.test(c.sql));
  assert.match(lookup.sql, /where \(o\.id = \$1 or o\.number = \$1\)/);
  assert.deepEqual(lookup.params, ['SO-100']);
});

test('25e — the stored review is the ONLY review the decision reads', () => {
  /* Passing anything from the request body here would let a caller supply the
     snapshot their decision is merged into. */
  const code = strip(read('routes', 'admin-credit.js'));
  assert.match(code, /applyCreditReviewDecision\(order\.credit_review, \{/);
  const at = code.indexOf('applyCreditReviewDecision(');
  const call = code.slice(at, code.indexOf('});', at));
  assert.ok(!/body\?\.(?!reason)/.test(call.replace('reason: body?.reason', '')),
    'only the resolution and the reason come from the request');
});

test('25c — an unknown queue state is refused rather than returning everything', async () => {
  await rejects(listCreditReviews(makeDb(world()), 'approvedish'), /Unknown credit review state/);
});

/* ============ the audit of a decision ============ */

test('a decision writes immutable evidence in the same transaction', async () => {
  const w = world();
  await decideCreditReview(makeDb(w), 'SO-100',
    { resolution: 'declined', reason: 'Account already past due' }, ACTOR);
  assert.equal(w.audit.length, 1);
  const [actorId, , , action, target, , , payload] = w.audit[0];
  assert.equal(actorId, 'staff-1');
  assert.equal(action, 'order credit review declined');
  assert.equal(target, 'SO-100');
  const body = JSON.parse(payload);
  assert.equal(body.resolution, 'declined');
  assert.equal(body.reason, 'Account already past due');
  assert.equal(body.capability, CREDIT_REVIEW_CAPABILITY);
  /* The original calculation is repeated into the audit payload, so the
     evidence survives even if the order row is later archived. */
  assert.equal(body.snapshotAtSubmission.projectedExposureMinor, 600000);
  assert.equal(body.snapshotAtSubmission.creditLimitMinor, 500000);
  assert.equal(body.snapshotAtSubmission.evaluatedAt, '2026-08-07T09:00:00.000Z');

  const code = strip(read('routes', 'admin-credit.js'));
  assert.match(code, /await auditIn\(c,/, 'written on the transaction client');
});

test('applyCreditReviewDecision refuses to act on an absent review', () => {
  for (const absent of [null, undefined, 'nope', 42]) {
    assert.throws(() => applyCreditReviewDecision(absent,
      { resolution: 'approved', reason: 'x', actor: ACTOR }), CreditError);
  }
});

/* ============ the admin surface ============ */

test('the admin panel reads every figure from the server', () => {
  /* A second money formula in the browser would let this screen and the
     order-time decision disagree about the same customer. */
  const page = fs.readFileSync(path.join(ROOT, 'js', 'pages_finance.js'), 'utf8');
  const at = page.indexOf('/* ============ Credit operations (Finance) ============');
  assert.ok(at > 0, 'the credit operations section exists');
  /* From the section HEADER, not from the route registration: the money
     helpers sit above it, and a slice that skipped them missed a parseFloat
     planted in creditMoney(). */
  const section = strip(page.slice(at));
  for (const forbidden of [/creditLimit\s*-\s*/, /exposure\s*-\s*/, /parseFloat/]) {
    assert.ok(!forbidden.test(section), `the panel must not compute ${forbidden}`);
  }
  assert.match(section, /DB\.creditReviews\(/);
  assert.match(section, /DB\.decideCreditReview\(/);
});

test('the admin panel never renders an unset limit as unlimited', () => {
  const page = fs.readFileSync(path.join(ROOT, 'js', 'pages_finance.js'), 'utf8');
  const section = page.slice(page.indexOf("App.register('credit-reviews'"));
  assert.match(section, /Credit limit not configured/);
  assert.match(section, /not configured/);
  assert.ok(!/unlimited/i.test(strip(section)));
});

test('the panel requires a reason before either decision', () => {
  const page = fs.readFileSync(path.join(ROOT, 'js', 'pages_finance.js'), 'utf8');
  const section = page.slice(page.indexOf('function decide('));
  const body = section.slice(0, section.indexOf('\n}'));
  assert.match(body, /if\(!reason\)\{toast\('A reason is required',true\);return;\}/,
    'and the server requires one regardless');
  assert.match(body, /data-go/, 'the decision is behind an explicit confirmation');
});

test('the panel states that an approval does not raise the limit', () => {
  const page = fs.readFileSync(path.join(ROOT, 'js', 'pages_finance.js'), 'utf8');
  const section = page.slice(page.indexOf("App.register('credit-reviews'"));
  assert.match(section, /does not raise the customer&rsquo;s credit limit/);
});

test('the DB helpers use fixed paths and shape every response', () => {
  const data = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  assert.match(data, /'\/admin\/credit\/reviews\/'\+encodeURIComponent\(orderId\)\+'\/decision'/);
  assert.match(data, /'\/admin\/credit\/customers\/'\+encodeURIComponent\(customerId\)\+'\/credit-limit'/);
  assert.match(data, /function shapeCreditPosition\(/);
  assert.match(data, /function shapeCreditReview\(/);
  /* And they are CALLED. A helper renamed out of use still defines a function,
     so asserting the definition alone proves nothing — it was caught passing
     against `shapeCreditReviewUnused`. */
  assert.match(data, /\.map\(shapeCreditReview\)/);
  assert.match(data, /shapeCreditPosition\(res && res\.position\)/);
  /* No response is spread into the UI. */
  const section = data.slice(data.indexOf('function shapeCreditPosition'));
  assert.ok(!/\.\.\.res|\.\.\.o\b/.test(section.slice(0, 3000)));
});
