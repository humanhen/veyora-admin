/* Commercial credit control.

   A credit limit is the ceiling on what a customer may owe Veyora at once. It
   has to mean something at the moment an order is placed, or it means nothing.

   THE RULE THAT SHAPES EVERYTHING: `credit_limit IS NULL` means NOBODY HAS SET
   ONE. Never unlimited, never zero. Every account in the database reads NULL
   until Veyora decides otherwise, so a build that conflated the two would
   grant infinite credit to the entire customer base in one deploy.

   The database double answers the queries the module issues and filters rows
   itself — so, as the returns suite learned the hard way, the SQL is separately
   asserted to carry its own customer predicate. A double cannot fake query
   text. */
/* MUST be the first import: admin-credit.js imports authmw.js, which throws at
   module load without JWT_SECRET — deliberate fail-closed behaviour that is not
   weakened here. ESM evaluates imports in source order. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  creditPosition, evaluateOrderCredit, creditReviewSnapshot, validateCreditLimit,
  creditMinor, creditMajor, CreditError, CREDIT_DECISIONS, CREDIT_LIMIT_CAPABILITY,
} from '../src/credit.js';
import { setCreditLimit } from '../src/routes/admin-credit.js';
import { PERMISSION_KEYS } from '../src/permission-registry.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ---------- the world ---------- */

function world(over = {}) {
  return {
    users: [
      { id: 'c1', business: 'Optika Ltd', email: 'a@example.test', role: 'customer',
        balance: '4000.00', credit_limit: null, currency: 'USD' },
      { id: 'c2', business: 'Other Ltd', email: 'b@example.test', role: 'customer',
        balance: '1000.00', credit_limit: '10000.00', currency: 'USD' },
    ],
    orders: [],
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

      if (s.startsWith('select id, balance, credit_limit, currency from users')) {
        return { rows: w.users.filter((u) => u.id === params[0]) };
      }
      if (s.startsWith('select coalesce(sum(total), 0)')) {
        const [customerId, nonCommitting, base, excludeId] = params;
        const mine = w.orders.filter((o) => o.customer_id === customerId
          && !o.invoice_id
          && !nonCommitting.includes(o.status)
          && (!excludeId || o.id !== excludeId));
        const currencies = new Set(mine.map((o) => (o.currency || base).toUpperCase()));
        return {
          rows: [{
            total: mine.reduce((sum, o) => sum + Number(o.total || 0), 0).toFixed(2),
            orders: mine.length,
            currencies: currencies.size,
            sample_currency: [...currencies].sort()[0] ?? base,
          }],
        };
      }
      if (s.startsWith('select id, business, email, credit_limit, role from users')) {
        return { rows: w.users.filter((u) => u.id === params[0]) };
      }
      if (s.startsWith('update users set credit_limit')) {
        const u = w.users.find((x) => x.id === params[0]);
        if (u) u.credit_limit = params[1];
        return { rows: [] };
      }
      if (s.startsWith('insert into audit_log')) {
        w.audit.push(params);
        return { rows: [] };
      }
      throw new Error(`the double was asked something unexpected: ${s.slice(0, 90)}`);
    },
    async tx(fn) { return fn(db); },
  };
  return db;
}

const rejects = (promise, re) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof CreditError, `expected a CreditError, got ${e.name}: ${e.message}`);
  assert.match(e.body?.error ?? e.message, re);
  return true;
});

const ACTOR = { id: 'admin-1', business: 'Veyora Finance', role: 'admin' };

/* ============ 1–3 — NULL, zero, and never unlimited ============ */

test('1 — an unset credit limit is reported as not configured', async () => {
  const p = await creditPosition(makeDb(world()), 'c1');
  assert.equal(p.creditLimitConfigured, false);
  assert.equal(p.creditLimit, null);
  assert.equal(p.availableCredit, null, 'no headroom is computed from a limit that does not exist');
  assert.equal(p.overLimit, false, 'and a limit that does not exist cannot be exceeded');
});

test('2 — NULL is never treated as unlimited', async () => {
  /* The exposure is enormous; with no limit there is still no verdict, and
     crucially no claim that the customer is within one. */
  const w = world();
  w.users[0].balance = '99999999.00';
  const p = await creditPosition(makeDb(w), 'c1');
  assert.equal(p.creditLimitConfigured, false);
  assert.equal(p.overLimit, false);
  assert.equal(p.availableCredit, null);

  const e = await evaluateOrderCredit(makeDb(w), 'c1', '5000.00');
  assert.equal(e.decision, CREDIT_DECISIONS.notConfigured);
  assert.equal(e.reviewRequired, false, 'no limit means no credit decision, not a failed one');
});

test('3 — zero is a real limit and is distinct from NULL', async () => {
  const w = world();
  w.users[0].credit_limit = '0.00';
  const p = await creditPosition(makeDb(w), 'c1');
  assert.equal(p.creditLimitConfigured, true, 'zero is a deliberate pro-forma-only decision');
  assert.equal(p.creditLimit, '0.00');
  assert.equal(p.availableCredit, '0.00');
  assert.equal(p.overLimit, true, 'any exposure at all exceeds a zero limit');

  /* And as the NUMBER zero, not only the string — pg returns numeric as a
     string today, so a truthiness check passes on '0.00' by accident. */
  w.users[0].credit_limit = 0;
  const n = await creditPosition(makeDb(w), 'c1');
  assert.equal(n.creditLimitConfigured, true);
});

/* ============ 4 — validation ============ */

test('4 — a negative credit limit is rejected', () => {
  for (const bad of ['-1', '-0.01', '-5000.00', -250]) {
    assert.throws(() => validateCreditLimit(bad), (e) => {
      assert.ok(e instanceof CreditError);
      assert.equal(e.status, 400);
      return true;
    }, `${bad} must be refused`);
  }
});

test('4b — malformed and oversized values are rejected, valid ones normalised', () => {
  for (const bad of ['abc', '1.234', '1e5', '5,000', ' 12 34 ', Infinity, NaN, {}]) {
    assert.throws(() => validateCreditLimit(bad), CreditError, `${String(bad)} must be refused`);
  }
  assert.deepEqual(validateCreditLimit('10000'), { limit: '10000.00' });
  assert.deepEqual(validateCreditLimit('10000.5'), { limit: '10000.50' });
  assert.deepEqual(validateCreditLimit('0'), { limit: '0.00' });
  /* Empty and null both mean CLEAR IT — a limit set in error must be
     removable to "not configured", not merely to zero. */
  assert.deepEqual(validateCreditLimit(''), { limit: null });
  assert.deepEqual(validateCreditLimit(null), { limit: null });
  assert.deepEqual(validateCreditLimit(undefined), { limit: null });
  assert.deepEqual(validateCreditLimit('   '), { limit: null },
    'a blank field means clear it, like an empty one');
});

test('4c — money never goes through a float', () => {
  assert.equal(creditMinor('29.97'), 2997);
  assert.equal(creditMinor('0.1') + creditMinor('0.2'), creditMinor('0.3'));
  assert.equal(creditMajor(creditMinor('123456.78')), '123456.78');
  assert.ok(!/parseFloat/.test(strip(read('credit.js'))));
});

/* ============ 5–9 — who may change it ============ */

test('5 — the customer has no route to their own credit limit', () => {
  /* The whole customer surface, not just the balance module. */
  const routes = fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.js'));
  const customerFacing = ['account.js', 'orders.js', 'cart.js', 'catalog.js', 'agent.js'];
  for (const file of customerFacing) {
    if (!routes.includes(file)) continue;
    const code = strip(read('routes', file));
    assert.ok(!/credit_limit\s*=/.test(code), `${file} must not write credit_limit`);
    assert.ok(!/set credit_limit/i.test(code), `${file} must not update credit_limit`);
  }
});

test('6 — changing a credit limit is capability-gated, and by its own capability', () => {
  const code = strip(read('routes', 'admin-credit.js'));
  assert.match(code, /requirePermission\(CREDIT_LIMIT_CAPABILITY\)/);
  assert.equal(CREDIT_LIMIT_CAPABILITY, 'finance.credit_limit');
  assert.ok(PERMISSION_KEYS.includes(CREDIT_LIMIT_CAPABILITY), 'and it is a registered key');
  /* EVERY route in the module is gated, and each carries the RIGHT gate.
     Asserting only "is gated" would pass if a review route were protected by
     the credit-limit capability, which would silently make approving one order
     imply authority to raise the ceiling. */
  const routes = [...code.matchAll(/r\.(get|put|post|patch|delete)\('([^']+)',\s*([^,]+),/g)];
  assert.ok(routes.length >= 4, `expected the full route set, saw ${routes.length}`);
  for (const [, verb, route, guard] of routes) {
    const expected = route.startsWith('/reviews') ? /canReview\(\)/ : /canSetLimit\(\)/;
    assert.match(guard, expected,
      `${verb.toUpperCase()} ${route} must carry its own capability gate`);
  }
});

test('7 — no capability is granted by any migration', () => {
  const dir = path.resolve(SRC, '..', '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\s*--[^\n]*$/gm, ' ');
    assert.ok(!/insert\s+into\s+account_permissions/i.test(sql),
      `${f} must not grant a capability`);
  }
});

test('8 — the generic admin sync cannot write a credit limit', () => {
  const shape = read('shape.js');
  const users = shape.slice(shape.indexOf('users: {'), shape.indexOf('promotions: {'));
  assert.ok(!/credit_limit|creditLimit/.test(users),
    'credit_limit is deliberately absent from the users sync collection');
  assert.match(users, /balance: 'balance'/, 'while the collection is otherwise intact');
});

test('9 — an authorised change sets the value and records what it replaced', async () => {
  const w = world();
  const db = makeDb(w);
  const result = await setCreditLimit(db, 'c1',
    { creditLimit: '25000', reason: 'Approved by finance, board minute 41' }, ACTOR);

  assert.equal(result.creditLimit, '25000.00');
  assert.equal(result.previousLimit, null, 'it was not configured before');
  assert.equal(result.creditLimitConfigured, true);
  assert.equal(w.users[0].credit_limit, '25000.00', 'and it was actually written');

  assert.equal(w.audit.length, 1, 'exactly one audit row');
  const [actorId, , , action, target, , changes, payload] = w.audit[0];
  assert.equal(actorId, 'admin-1');
  assert.equal(action, 'credit limit changed');
  assert.equal(target, 'Optika Ltd');
  assert.match(changes, /not configured → 25000\.00/);
  const body = JSON.parse(payload);
  assert.equal(body.previousLimit, null);
  assert.equal(body.newLimit, '25000.00');
  assert.equal(body.reason, 'Approved by finance, board minute 41');
  assert.equal(body.capability, 'finance.credit_limit');
});

test('9b — a limit can be cleared back to NULL, and that is not zero', async () => {
  const w = world();
  const db = makeDb(w);
  await setCreditLimit(db, 'c2', { creditLimit: '', reason: 'Set in error' }, ACTOR);
  assert.equal(w.users[1].credit_limit, null);
  const body = JSON.parse(w.audit[0][7]);
  assert.equal(body.previousLimit, '10000.00');
  assert.equal(body.newLimit, null, 'cleared, not zeroed');
});

test('9c — a reason is required, as it is for any discretionary financial act', async () => {
  const w = world();
  await rejects(setCreditLimit(makeDb(w), 'c1', { creditLimit: '5000' }, ACTOR),
    /reason is required/i);
  await rejects(setCreditLimit(makeDb(w), 'c1', { creditLimit: '5000', reason: '   ' }, ACTOR),
    /reason is required/i);
  assert.equal(w.users[0].credit_limit, null, 'and nothing was written');
});

test('9d — a no-op write is refused rather than logged', async () => {
  /* An audit trail full of "changed from 10000 to 10000" is one nobody reads. */
  const w = world();
  await rejects(
    setCreditLimit(makeDb(w), 'c2', { creditLimit: '10000.00', reason: 'no change' }, ACTOR),
    /already/);
  assert.equal(w.audit.length, 0);
});

test('9e — a stale write is refused, and "expected unset" is expressible', async () => {
  const w = world();
  await rejects(
    setCreditLimit(makeDb(w), 'c2',
      { creditLimit: '20000', reason: 'raise', expectedCurrentLimit: '5000' }, ACTOR),
    /changed while you were editing/);
  assert.equal(w.users[1].credit_limit, '10000.00', 'unchanged');

  /* Expecting NULL against a configured value is also a conflict — the two
     are different statements, so they must not compare equal. */
  await rejects(
    setCreditLimit(makeDb(w), 'c2',
      { creditLimit: '20000', reason: 'raise', expectedCurrentLimit: null }, ACTOR),
    /changed while you were editing/);

  const ok = await setCreditLimit(makeDb(w), 'c2',
    { creditLimit: '20000', reason: 'raise', expectedCurrentLimit: '10000.00' }, ACTOR);
  assert.equal(ok.creditLimit, '20000.00');
});

test('9f — an unknown customer is refused', async () => {
  await rejects(setCreditLimit(makeDb(world()), 'nobody',
    { creditLimit: '1000', reason: 'x' }, ACTOR), /could not be found/);
});

test('9g — a negative limit never reaches the database', async () => {
  const w = world();
  await rejects(setCreditLimit(makeDb(w), 'c1',
    { creditLimit: '-5000', reason: 'x' }, ACTOR), /negative|positive amount/i);
  assert.equal(w.users[0].credit_limit, null);
  assert.equal(w.audit.length, 0);
});

/* ============ 10–13 — what exposure counts ============ */

test('10–13 — exposure is the net ledger plus committed, uninvoiced orders', async () => {
  /* The ledger is already net: an invoice raises it, a payment and a credit
     note lower it. So a fully paid invoice contributes zero, a partly paid one
     contributes the remainder, and an unpaid one contributes in full — by
     construction rather than by special case. */
  const w = world();
  w.users[0].balance = '4000.00';          // whatever remains owed after payments
  w.orders = [
    { id: 'o1', customer_id: 'c1', total: '1500.00', status: 'pending', invoice_id: null },
    { id: 'o2', customer_id: 'c1', total: '900.00', status: 'shipped', invoice_id: null },
    /* Already invoiced: the ledger is counting it, so counting it here too
       would double it. */
    { id: 'o3', customer_id: 'c1', total: '5000.00', status: 'completed', invoice_id: 'in_1' },
    /* Cancelled: never becomes a debt. */
    { id: 'o4', customer_id: 'c1', total: '7000.00', status: 'cancelled', invoice_id: null },
  ];
  const p = await creditPosition(makeDb(w), 'c1');
  assert.equal(p.ledger, '4000.00');
  assert.equal(p.uninvoiced, '2400.00', 'only the committed, uninvoiced orders');
  assert.equal(p.uninvoicedOrders, 2);
  assert.equal(p.exposure, '6400.00');
});

test('13b — an invoiced order is excluded because the ledger already has it', async () => {
  const w = world();
  w.users[0].balance = '5000.00';
  w.orders = [{ id: 'o1', customer_id: 'c1', total: '5000.00', status: 'completed', invoice_id: 'in_1' }];
  const p = await creditPosition(makeDb(w), 'c1');
  assert.equal(p.exposure, '5000.00', 'counted once, not twice');
});

test('13c — a credit note reduces exposure, because it reduces the ledger', async () => {
  const w = world();
  w.users[0].balance = '1000.00';   // after a 3,000 credit note against a 4,000 invoice
  const p = await creditPosition(makeDb(w), 'c1');
  assert.equal(p.exposure, '1000.00');
});

/* ============ 14 — cross-customer isolation ============ */

test('14 — exposure never leaks across customers', async () => {
  const w = world();
  w.users[0].balance = '4000.00';
  w.users[1].balance = '999999.00';
  w.orders = [
    { id: 'o1', customer_id: 'c1', total: '100.00', status: 'pending', invoice_id: null },
    { id: 'o2', customer_id: 'c2', total: '888888.00', status: 'pending', invoice_id: null },
  ];
  const p = await creditPosition(makeDb(w), 'c1');
  assert.equal(p.exposure, '4100.00', "another customer's debt is not this customer's");
});

test('14b — the customer predicate is in the SQL, not only in the double', async () => {
  /* The double filters rows itself, so test 14 would still pass if the SQL
     stopped scoping. The returns suite was found doing exactly that. */
  const w = world();
  const db = makeDb(w);
  await creditPosition(db, 'c1');
  const reads = db.calls.filter((c) => /\bfrom (users|orders)\b/.test(c.sql));
  assert.ok(reads.length >= 2, `expected the scoped reads, saw ${reads.length}`);
  for (const call of reads) {
    assert.match(call.sql, /where (id|customer_id) = \$1/,
      `a read must scope to the caller: ${call.sql.slice(0, 100)}`);
    assert.equal(call.params[0], 'c1');
  }
});

test('14d — the exposure query itself excludes invoiced and cancelled orders', async () => {
  /* The double applies those filters too, so test 13b would still pass if the
     SQL stopped applying them — it was caught doing exactly that. The query
     text is the part a double cannot fake. */
  const db = makeDb(world());
  await creditPosition(db, 'c1');
  const exposure = db.calls.find((c) => /coalesce\(sum\(total\), 0\)/.test(c.sql));
  assert.ok(exposure, 'the exposure query ran');
  assert.match(exposure.sql, /invoice_id is null/,
    'an invoiced order is already in the ledger; counting it here doubles it');
  assert.match(exposure.sql, /not \(status = any\(\$2\)\)/,
    'and a cancelled order never becomes a debt');
  assert.deepEqual(exposure.params[1], ['cancelled']);
});

test('14c — a missing customer is refused, not silently treated as zero exposure', async () => {
  await rejects(creditPosition(makeDb(world()), 'ghost'), /could not be found/);
  await rejects(creditPosition(makeDb(world()), null), /customer is required/i);
});

/* ============ 15 — the browser is not consulted ============ */

test('15 — no credit figure is ever read from a request body', () => {
  const credit = strip(read('credit.js'));
  for (const forbidden of [/req\./, /request\./, /\bbody\b\s*\./]) {
    assert.ok(!forbidden.test(credit), `credit.js must not read ${forbidden}`);
  }

  /* And the order route hands it only server-derived values. */
  const orders = strip(read('routes', 'orders.js'));
  assert.match(orders, /evaluateOrderCredit\(c, customer\.id, total\)/,
    'the customer comes from the resolved context and the total from server pricing');
  const at = orders.indexOf('evaluateOrderCredit(');
  const line = orders.slice(at, orders.indexOf('\n', at));
  assert.ok(!/req\.body/.test(line), 'no request value reaches the evaluation');
});

test('15b — a browser-supplied verdict, limit or balance is ignored', async () => {
  /* Sending every field a hopeful client might invent must change nothing. */
  const w = world();
  w.users[1].credit_limit = '1000.00';
  w.users[1].balance = '900.00';
  const honest = await evaluateOrderCredit(makeDb(w), 'c2', '500.00');
  assert.equal(honest.decision, CREDIT_DECISIONS.reviewRequired);

  const position = await creditPosition(makeDb(w), 'c2', {
    creditLimit: '9999999.00', availableCredit: '9999999.00', balance: '0.00',
    credit_ok: true, approval_required: false, overLimit: false,
  });
  assert.equal(position.creditLimit, '1000.00', 'the stored limit, not the supplied one');
  assert.equal(position.overLimit, false, 'exposure 900 is within 1000 before the order');
});

/* ============ 16 — available credit ============ */

test('16 — available credit is max(limit - exposure, 0)', async () => {
  const w = world();
  w.users[1].credit_limit = '10000.00';
  w.users[1].balance = '3000.00';
  w.orders = [{ id: 'o1', customer_id: 'c2', total: '1500.00', status: 'pending', invoice_id: null }];
  const p = await creditPosition(makeDb(w), 'c2');
  assert.equal(p.exposure, '4500.00');
  assert.equal(p.availableCredit, '5500.00');
  assert.equal(p.overLimit, false);
});

test('16b — over the limit, headroom clamps at zero and the shortfall is reported', async () => {
  /* "How much more may I order" has no negative answer, and the clamp must
     not lose the shortfall. */
  const w = world();
  w.users[1].credit_limit = '1000.00';
  w.users[1].balance = '3500.00';
  const p = await creditPosition(makeDb(w), 'c2');
  assert.equal(p.availableCredit, '0.00');
  assert.equal(p.overLimit, true);
  assert.equal(p.overLimitBy, '2500.00');
});

/* ============ 17–20 — the order-time decision ============ */

test('17 — an order within the limit follows the ordinary flow', async () => {
  const w = world();
  w.users[1].credit_limit = '10000.00';
  w.users[1].balance = '1000.00';
  const e = await evaluateOrderCredit(makeDb(w), 'c2', '2000.00');
  assert.equal(e.decision, CREDIT_DECISIONS.withinLimit);
  assert.equal(e.reviewRequired, false);
  assert.equal(creditReviewSnapshot(e), null, 'an ordinary order carries no snapshot');
});

test('18 — a projected over-limit order is detected server-side', async () => {
  /* Within the limit BEFORE the order; over it once the order is included.
     Evaluating only the current balance would wave this through. */
  const w = world();
  w.users[1].credit_limit = '5000.00';
  w.users[1].balance = '4000.00';
  const e = await evaluateOrderCredit(makeDb(w), 'c2', '2000.00');
  assert.equal(e.decision, CREDIT_DECISIONS.reviewRequired);
  assert.equal(e.reviewRequired, true);
  assert.equal(e.projectedExposure, '6000.00', 'the order is included in the projection');
  assert.equal(e.overLimitByMinor, 100000);
});

test('18b — uninvoiced orders count, so the limit cannot be outrun by ordering', async () => {
  /* Otherwise a customer stays "within limit" indefinitely simply by ordering
     faster than Veyora invoices — the exact situation a limit exists to stop. */
  const w = world();
  w.users[1].credit_limit = '5000.00';
  w.users[1].balance = '0.00';
  w.orders = [
    { id: 'o1', customer_id: 'c2', total: '2500.00', status: 'pending', invoice_id: null },
    { id: 'o2', customer_id: 'c2', total: '2500.00', status: 'pending', invoice_id: null },
  ];
  const e = await evaluateOrderCredit(makeDb(w), 'c2', '1000.00');
  assert.equal(e.projectedExposure, '6000.00');
  assert.equal(e.reviewRequired, true);
});

test('19 — the order is NOT rejected, it is flagged for a human decision', async () => {
  /* Veyora's model is credit CHECKING with an approval stage. A legitimate
     order above the limit is a conversation, not an error. */
  const w = world();
  w.users[1].credit_limit = '1000.00';
  w.users[1].balance = '5000.00';
  const e = await evaluateOrderCredit(makeDb(w), 'c2', '500.00');
  const snapshot = creditReviewSnapshot(e);
  assert.ok(snapshot, 'a snapshot is stamped');
  assert.equal(snapshot.decision, CREDIT_DECISIONS.reviewRequired);
  assert.equal(snapshot.resolvedBy, null, 'nobody has decided yet');
  assert.equal(snapshot.resolution, null);
  assert.equal(snapshot.projectedExposureMinor, 550000);
  assert.equal(snapshot.creditLimitMinor, 100000);

  const orders = read('routes', 'orders.js');
  assert.ok(!/throw[^\n]*credit/i.test(strip(orders)),
    'no credit condition throws the order away');
});

test('19b — the order route stamps the snapshot and records the decision', () => {
  const orders = strip(read('routes', 'orders.js'));
  assert.match(orders, /credit_review\)/, 'the column is written on insert');
  assert.match(orders, /creditReview \? JSON\.stringify\(creditReview\) : null/,
    'and is NULL for an ordinary order');
  assert.match(orders, /auditIn\(c,/, 'the record is written on the transaction client');
  assert.match(orders, /'order credit review required'/);
  /* Inside the transaction: if the order rolls back so does the claim that it
     was reviewed, and vice versa. */
  const at = orders.indexOf('const creditEvaluation');
  const txAt = orders.indexOf('await tx(async (c) =>');
  assert.ok(txAt >= 0 && txAt < at, 'the evaluation runs inside the order transaction');
});

test('19c — the snapshot is DERIVED from the evaluation, not from a constant', () => {
  /* Asserting only that the words appear would survive `const creditReview =
     null`, which silently disables the whole control while leaving every other
     assertion in this file green. It was caught doing exactly that. */
  const orders = strip(read('routes', 'orders.js'));
  assert.match(orders, /const creditEvaluation = await evaluateOrderCredit\(c, customer\.id, total\);/);
  assert.match(orders, /const creditReview = creditReviewSnapshot\(creditEvaluation\);/,
    'the stamp must come from the evaluation');

  /* And the recording branch must be reachable — `if (false)` around it would
     otherwise leave an over-limit order with no record at all. */
  assert.match(orders, /if \(creditReview\) \{\s*await auditIn\(c,/,
    'the audit is guarded by the snapshot itself, not by a constant');
});

test('19d — nothing downstream may treat an unreviewed order as approved', () => {
  /* The whole design rests on `credit_review` being NULL only when no decision
     was needed. A default, a coalesce or a backfill would destroy that. */
  const orders = strip(read('routes', 'orders.js'));
  assert.ok(!/credit_review[^)]*coalesce/i.test(orders), 'no coalesce on the column');
  const migration = fs.readFileSync(
    path.resolve(SRC, '..', '..', 'db', 'migrations', '0018_commercial_credit_control.sql'), 'utf8')
    .replace(/^\s*--[^\n]*$/gm, ' ');
  assert.match(migration, /add column if not exists credit_review jsonb/);
  assert.ok(!/credit_review[^;]*default/i.test(migration), 'no default value');
  assert.ok(!/update orders set credit_review/i.test(migration), 'no backfill');
});

test('20 — an unsupported exposure is treated as needing review, not as approval', async () => {
  /* "We could not tell" is not "yes". */
  const w = world();
  w.users[1].credit_limit = '10000.00';
  w.orders = [
    { id: 'o1', customer_id: 'c2', total: '100.00', status: 'pending', invoice_id: null, currency: 'USD' },
    { id: 'o2', customer_id: 'c2', total: '100.00', status: 'pending', invoice_id: null, currency: 'EUR' },
  ];
  const e = await evaluateOrderCredit(makeDb(w), 'c2', '100.00');
  assert.equal(e.decision, CREDIT_DECISIONS.unsupported);
  assert.equal(e.reviewRequired, true);
});

test('20b — the credit-review flag is what downstream code branches on', () => {
  /* Both non-ordinary outcomes set it, so a reader that checks one enum value
     cannot miss the other. */
  const decisions = Object.values(CREDIT_DECISIONS);
  assert.deepEqual(decisions.sort(),
    ['credit_review_required', 'exposure_unsupported', 'not_configured', 'within_limit']);
});

/* ============ 21 — currency ============ */

test('21 — incompatible currencies are never silently combined', async () => {
  const w = world();
  w.users[1].credit_limit = '10000.00';
  w.orders = [
    { id: 'o1', customer_id: 'c2', total: '100.00', status: 'pending', invoice_id: null, currency: 'USD' },
    { id: 'o2', customer_id: 'c2', total: '100.00', status: 'pending', invoice_id: null, currency: 'CAD' },
  ];
  const p = await creditPosition(makeDb(w), 'c2');
  assert.equal(p.exposureUnsupported, true);
  assert.equal(p.availableCredit, null, 'no figure is produced');
  assert.equal(p.overLimit, false, 'and no verdict is claimed');
  assert.match(p.unsupportedReason, /more than one currency/);
});

test('21b — a single non-base currency is also refused rather than assumed', async () => {
  const w = world();
  w.users[1].credit_limit = '10000.00';
  w.orders = [
    { id: 'o1', customer_id: 'c2', total: '100.00', status: 'pending', invoice_id: null, currency: 'EUR' },
  ];
  const p = await creditPosition(makeDb(w), 'c2');
  assert.equal(p.exposureUnsupported, true,
    'the ledger is in the base currency; adding EUR to it would be meaningless');
});

test('21c — ordinary base-currency accounts are unaffected', async () => {
  const w = world();
  w.orders = [{ id: 'o1', customer_id: 'c1', total: '100.00', status: 'pending', invoice_id: null, currency: 'USD' }];
  const p = await creditPosition(makeDb(w), 'c1');
  assert.equal(p.exposureUnsupported, false);
  assert.equal(p.currency, 'USD');
});

/* ============ the customer's own screen ============ */

test('the balance screen and the order decision share one calculation', () => {
  /* Two implementations would let the screen promise headroom that an order is
     then held for exceeding. */
  const balance = read('account-balance.js');
  assert.match(balance, /import \{ creditPosition \} from '\.\/credit\.js'/);
  assert.match(balance, /await creditPosition\(db, customerId\)/);
  assert.ok(!/credit_limit -|limitCents - balanceCents/.test(strip(balance)),
    'headroom is not recomputed here');
});
