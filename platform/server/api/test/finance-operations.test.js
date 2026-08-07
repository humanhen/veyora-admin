/* Auditable finance operations (Final Handover, Phase 4).

   Real handlers against a controlled database double with real transaction
   semantics and real unique-index behaviour. No live database and no real
   money: every amount is invented and every id is a fixture.

   The double enforces the things the DATABASE enforces — the unique
   idempotency indexes and the append-only trigger on `finance_events` — so a
   handler that forgot one fails here rather than passing on a kind double. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALL_PAYMENT_METHODS, FINANCE_CONTRACT, FINANCE_EVENT_TYPES, OFFLINE_PAYMENT_METHODS,
  describeFinanceEvent, financeIdempotencyKey, isOfflineMethod,
  serializeCreditNote, serializeFinanceEvent, serializePayment,
  validateCreditNote, validateOfflinePayment, validateResolution, validateVoid,
} from '../src/finance-operations.js';
import financeRouter, {
  FINANCE_CAPABILITIES, FinanceError,
  customerLedger, getFinanceCapabilities, issueCreditNote, issueInvoice,
  recordOfflinePayment, recentEvents, resolveException, voidPayment,
} from '../src/routes/admin-finance.js';
import {
  FINANCE_COLLECTIONS, FINANCE_FIELDS, SERVER_MANAGED_COLLECTIONS, checkSyncPayload,
} from '../src/admin-data.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const MIGRATIONS = path.join(path.dirname(ROOT), 'db', 'migrations');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const migration = fs.readFileSync(path.join(MIGRATIONS, '0014_finance_operations.sql'), 'utf8')
  .replace(/--[^\n]*/g, ' ');
const migrateJs = read('migrate.js');
const financeSrc = code('routes', 'admin-finance.js');
const adminSrc = code('routes', 'admin.js');
const shapeSrc = code('shape.js');

const ACTOR = { id: 'u_ops', email: 'ops@example.test', business: 'Ops', role: 'admin' };
const CUSTOMER_ID = 'u_cust1';

/* ---------------------------------------------------------------------------
   The double
   --------------------------------------------------------------------------- */

function makeDb({ balance = '1000.00', orders = [], invoices = [], events = [] } = {}) {
  let users = [{ id: CUSTOMER_ID, balance }];
  let orderTable = orders.map((o) => ({ ...o }));
  let invoiceTable = invoices.map((i) => ({ ...i }));
  let paymentTable = [];
  let creditTable = [];
  let financeTable = [];
  let paymentEvents = events.map((e) => ({ ...e }));
  let auditTable = [];
  let seq = 0;

  /* The append-only trigger. A handler that tried to edit history fails here
     exactly as it would in PostgreSQL. */
  function guardFinanceEvents(sql) {
    if (/^\s*(update|delete)\s+(from\s+)?finance_events/is.test(sql)) {
      throw Object.assign(new Error('finance_events is append-only'), { code: 'P0001' });
    }
  }

  async function query(sql, params = []) {
    guardFinanceEvents(sql);

    // ---- users / balance ----
    if (/^\s*select id, balance from users where id = \$1/is.test(sql)) {
      const u = users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u }] : [] };
    }
    if (/^\s*update users set balance/is.test(sql)) {
      const u = users.find((x) => x.id === params[0]);
      if (!u) return { rows: [] };
      u.balance = (Math.round((Number(u.balance) + Number(params[1])) * 100) / 100).toFixed(2);
      return { rows: [{ balance: u.balance }] };
    }

    // ---- orders ----
    if (/from orders where id = \$1 or number = \$1/is.test(sql)) {
      const o = orderTable.find((x) => x.id === params[0] || x.number === params[0]);
      return { rows: o ? [{ ...o }] : [] };
    }
    if (/^\s*update orders set invoice_id/is.test(sql)) {
      const o = orderTable.find((x) => x.id === params[0]);
      if (o) o.invoice_id = params[1];
      return { rows: [] };
    }

    // ---- invoices ----
    if (/nextval\('invoice_number_seq'\)/is.test(sql)) {
      return { rows: [{ n: `IN${1000 + (++seq)}` }] };
    }
    if (/^\s*insert into invoices/is.test(sql)) {
      const row = { id: `in_${++seq}`, number: params[0], order_id: params[1],
        order_number: params[2], customer_id: params[3], amount: params[4],
        settlement_currency: params[5], settlement_state: 'on_terms', issued_on: '2026-08-07' };
      invoiceTable.push(row);
      return { rows: [{ ...row }] };
    }
    if (/from invoices where id = \$1 or number = \$1/is.test(sql)) {
      const i = invoiceTable.find((x) => x.id === params[0] || x.number === params[0]);
      return { rows: i ? [{ ...i }] : [] };
    }
    if (/from invoices where id = \$1/is.test(sql)) {
      const i = invoiceTable.find((x) => x.id === params[0]);
      return { rows: i ? [{ ...i }] : [] };
    }

    // ---- payments ----
    if (/^\s*insert into payments/is.test(sql)) {
      const key = params[10];
      if (key && paymentTable.some((p) => p.idempotency_key === key)) return { rows: [] };
      const row = { id: `pay_${++seq}`, customer_id: params[0], invoice_id: params[1],
        amount: params[2], amount_minor: params[3], currency: params[4], method: params[5],
        reference: params[6], paid_on: params[7] || '2026-08-07', notes: params[8],
        recorded_by: params[9], idempotency_key: key, stripe_payment_intent: null,
        voided_at: null, voided_by: null, void_reason: '', created_at: new Date('2026-08-07') };
      paymentTable.push(row);
      return { rows: [{ ...row }] };
    }
    if (/from payments where id = \$1/is.test(sql)) {
      const p = paymentTable.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
    }
    if (/^\s*update payments set voided_at/is.test(sql)) {
      const p = paymentTable.find((x) => x.id === params[0] && x.voided_at == null);
      if (!p) return { rows: [] };
      Object.assign(p, { voided_at: new Date('2026-08-08'), voided_by: params[1], void_reason: params[2] });
      return { rows: [{ ...p }] };
    }

    // ---- credit notes ----
    if (/^\s*insert into credit_notes/is.test(sql)) {
      const key = params[9];
      if (key && creditTable.some((n) => n.idempotency_key === key)) return { rows: [] };
      const row = { id: `cn_${++seq}`, customer_id: params[0], invoice_id: params[1],
        amount: params[2], amount_minor: params[3], currency: params[4], reason: params[5],
        reference: params[6], issued_on: params[7] || '2026-08-07', issued_by: params[8],
        idempotency_key: key, created_at: new Date('2026-08-07') };
      creditTable.push(row);
      return { rows: [{ ...row }] };
    }

    // ---- finance events ----
    if (/^\s*insert into finance_events/is.test(sql)) {
      const key = params[16];
      if (financeTable.some((e) => e.idempotency_key === key)) return { rows: [] };
      const row = { id: `fev_${++seq}`, event_type: params[0], customer_id: params[1],
        invoice_id: params[2], payment_id: params[3], credit_note_id: params[4],
        amount_minor: params[5], currency: params[6], balance_before: params[7],
        balance_after: params[8], reference: params[9], provider_reference: params[10],
        reason: params[11], actor_id: params[12], actor_name: params[13],
        actor_role: params[14], capability: params[15], idempotency_key: key,
        created_at: new Date('2026-08-07') };
      financeTable.push(row);
      return { rows: [{ ...row }] };
    }
    if (/from finance_events\s+where customer_id = \$1/is.test(sql)) {
      return { rows: financeTable.filter((e) => e.customer_id === params[0]).reverse().map((e) => ({ ...e })) };
    }
    if (/from finance_events\s+order by/is.test(sql)) {
      return { rows: [...financeTable].reverse().map((e) => ({ ...e })) };
    }

    // ---- payment events ----
    if (/from payment_events where id = \$1/is.test(sql)) {
      const e = paymentEvents.find((x) => x.id === params[0]);
      return { rows: e ? [{ ...e }] : [] };
    }
    if (/^\s*update payment_events\s+set status = 'resolved'/is.test(sql)) {
      const e = paymentEvents.find((x) => x.id === params[0] && ['failed', 'received'].includes(x.status));
      if (!e) return { rows: [] };
      Object.assign(e, { status: 'resolved', resolved_by: params[1], resolution_note: params[2] });
      return { rows: [{ ...e }] };
    }

    if (/insert into audit_log/is.test(sql)) { auditTable.push(params); return { rows: [] }; }
    return { rows: [] };
  }

  return {
    query,
    get users() { return users; },
    get payments() { return paymentTable; },
    get creditNotes() { return creditTable; },
    get financeEvents() { return financeTable; },
    get invoices() { return invoiceTable; },
    get paymentEvents() { return paymentEvents; },
    get orders() { return orderTable; },
    async tx(fn) {
      const snap = {
        u: users.map((x) => ({ ...x })), o: orderTable.map((x) => ({ ...x })),
        i: invoiceTable.map((x) => ({ ...x })), p: paymentTable.map((x) => ({ ...x })),
        c: creditTable.map((x) => ({ ...x })), f: financeTable.map((x) => ({ ...x })),
        e: paymentEvents.map((x) => ({ ...x })),
      };
      try {
        return await fn({ query });
      } catch (err) {
        users = snap.u; orderTable = snap.o; invoiceTable = snap.i;
        paymentTable = snap.p; creditTable = snap.c; financeTable = snap.f;
        paymentEvents = snap.e;
        throw err;
      }
    },
  };
}

const order = (over = {}) => ({ id: 'o_1', number: 'SO1', customer_id: CUSTOMER_ID,
  total: '250.00', currency: 'USD', invoice_id: null, ...over });

const goodPayment = (over = {}) => ({
  customerId: CUSTOMER_ID, method: 'transfer', amount: '250.00', currency: 'USD',
  reference: 'BACS-99213', ...over,
});

const goodCredit = (over = {}) => ({
  customerId: CUSTOMER_ID, amount: '50.00', currency: 'USD',
  reason: 'goods damaged in transit', ...over,
});

// ===========================================================================
// 1-12 — money no longer moves through the generic sync
// ===========================================================================

test('1 — invoices, payments and credit notes are blocked from the generic sync', () => {
  assert.deepEqual([...FINANCE_COLLECTIONS], ['invoices', 'payments', 'creditNotes']);
  for (const collection of FINANCE_COLLECTIONS) {
    const result = checkSyncPayload([{ collection, upserts: [{ id: 'x' }] }]);
    assert.equal(result.ok, false, collection);
    assert.equal(result.status, 409);
    assert.deepEqual(result.collections, [collection]);
  }
});

test('2 — a DELETE of a payment through sync is refused too', () => {
  /* The dangerous half: a `deletes` list is "every id this tab has not seen",
     so a stale browser would remove every payment recorded since it loaded. */
  const result = checkSyncPayload([{ collection: 'payments', deletes: ['pay_1', 'pay_2'] }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.collections, ['payments']);
});

test('3 — a customer balance cannot be set through the generic sync', () => {
  assert.deepEqual(FINANCE_FIELDS.users, ['balance']);
  const result = checkSyncPayload([{ collection: 'users', upserts: [{ id: 'u1', balance: '9999.00' }] }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.fields, ['users.balance']);
  assert.match(result.error, /derived from invoices, payments and credit notes/);
});

test('4 — balance: 0 is as much a balance write as balance: 5000', () => {
  /* hasOwnProperty, not truthiness — zeroing a balance is the most damaging
     version of this. */
  const result = checkSyncPayload([{ collection: 'users', upserts: [{ id: 'u1', balance: 0 }] }]);
  assert.equal(result.ok, false);
});

test('5 — an ordinary user edit still syncs', () => {
  assert.deepEqual(checkSyncPayload([{ collection: 'users',
    upserts: [{ id: 'u1', firstName: 'A', paymentTerms: 45 }] }]), { ok: true });
});

test('6 — non-financial collections are untouched by this guard', () => {
  for (const collection of ['products', 'warehouses', 'promotions', 'collectionFlags']) {
    assert.deepEqual(checkSyncPayload([{ collection, upserts: [{ id: 'x' }] }]), { ok: true }, collection);
  }
});

test('7 — orders and backorders remain server-managed, and take precedence', () => {
  assert.deepEqual([...SERVER_MANAGED_COLLECTIONS], ['orders', 'backorders']);
  const both = checkSyncPayload([
    { collection: 'orders', upserts: [{ id: 'o1' }] },
    { collection: 'payments', upserts: [{ id: 'p1' }] },
  ]);
  assert.equal(both.ok, false);
  assert.deepEqual(both.collections, ['orders']);
});

test('8 — the WHOLE request is refused, so a partial write cannot happen', () => {
  /* The caller must never be told its payment changes failed while its product
     changes silently landed. */
  const result = checkSyncPayload([
    { collection: 'products', upserts: [{ id: 'p1' }] },
    { collection: 'payments', upserts: [{ id: 'pay1' }] },
  ]);
  assert.equal(result.ok, false);
});

test('9 — an empty finance change list is not an error', () => {
  /* A client that sends the collection with nothing in it has written nothing. */
  assert.deepEqual(checkSyncPayload([{ collection: 'payments', upserts: [], deletes: [] }]), { ok: true });
});

test('10 — the financial collections are still READABLE through the snapshot', () => {
  /* Blocking writes must not blind the finance screens. */
  for (const key of ['invoices', 'payments', 'creditNotes']) {
    assert.ok(shapeSrc.includes(`${key}: {`), `${key} must remain in the shape map`);
  }
});

// ===========================================================================
// 11-24 — validation
// ===========================================================================

test('11 — a client can NEVER record a Stripe payment', () => {
  /* The single most important refusal in this phase: a Stripe settlement is
     the exclusive result of a verified webhook. */
  assert.deepEqual([...OFFLINE_PAYMENT_METHODS], ['transfer', 'check', 'credit_card', 'cash']);
  assert.equal(isOfflineMethod('stripe'), false);
  const v = validateOfflinePayment(goodPayment({ method: 'stripe' }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'UNKNOWN_METHOD'));
  /* And the table still accepts 'stripe' — written only by the webhook. */
  assert.ok(ALL_PAYMENT_METHODS.includes('stripe'));
});

test('12 — the legitimate offline methods are all preserved', () => {
  for (const method of ['transfer', 'check', 'credit_card', 'cash']) {
    assert.equal(validateOfflinePayment(goodPayment({ method })).ok, true, method);
  }
});

test('13 — a payment requires a reference so it can be matched to a statement', () => {
  for (const reference of ['', ' ', 'x']) {
    const v = validateOfflinePayment(goodPayment({ reference }));
    assert.equal(v.ok, false, JSON.stringify(reference));
    assert.ok(v.errors.some((e) => e.code === 'REQUIRED'));
  }
});

test('14 — a payment amount is validated as money, never coerced', () => {
  for (const amount of ['', 'abc', '12.5.3', '-10.00', '0.00', '1e3', null]) {
    assert.equal(validateOfflinePayment(goodPayment({ amount })).ok, false, JSON.stringify(amount));
  }
  assert.equal(validateOfflinePayment(goodPayment({ amount: '250.00' })).ok, true);
});

test('15 — an over-precise amount is refused rather than rounded', () => {
  const v = validateOfflinePayment(goodPayment({ amount: '250.005' }));
  assert.equal(v.ok, false);
});

test('16 — a credit note ALWAYS needs a stated reason', () => {
  /* A credit note and a payment look identical on a balance and are completely
     different events. */
  for (const reason of ['', '   ', 'oops']) {
    const v = validateCreditNote(goodCredit({ reason }));
    assert.equal(v.ok, false, JSON.stringify(reason));
    assert.ok(v.errors.some((e) => e.field === 'reason'));
  }
  assert.equal(validateCreditNote(goodCredit()).ok, true);
});

test('17 — voiding needs a reason AND an explicit confirmation', () => {
  assert.equal(validateVoid({ confirm: true }).ok, false);
  assert.equal(validateVoid({ reason: 'keyed twice by mistake' }).ok, false);
  assert.equal(validateVoid({ reason: 'keyed twice by mistake', confirm: true }).ok, true);
});

test('18 — resolving an exception needs a note saying what was concluded', () => {
  assert.equal(validateResolution({}).ok, false);
  assert.equal(validateResolution({ note: 'ok' }).ok, false);
  assert.equal(validateResolution({ note: 'customer paid by transfer instead' }).ok, true);
});

test('19 — control characters are stripped from every free-text field', () => {
  const v = validateOfflinePayment(goodPayment({ reference: 'BACS\r\n-99213', notes: 'onetwo' }));
  assert.equal(v.ok, true);
  assert.equal(v.value.reference, 'BACS-99213');
  assert.ok(!v.value.notes.includes(''));
});

test('20 — an unsupported currency is refused on both operations', () => {
  assert.equal(validateOfflinePayment(goodPayment({ currency: 'XYZ' })).ok, false);
  assert.equal(validateCreditNote(goodCredit({ currency: 'XYZ' })).ok, false);
});

test('21 — a malformed date is refused rather than silently becoming today', () => {
  assert.equal(validateOfflinePayment(goodPayment({ paidOn: '07/08/2026' })).ok, false);
  assert.equal(validateOfflinePayment(goodPayment({ paidOn: '2026-08-07' })).ok, true);
  assert.equal(validateOfflinePayment(goodPayment({ paidOn: '' })).ok, true, 'empty means today');
});

test('22 — the idempotency key is derived from the operation facts, order-independently', () => {
  const a = financeIdempotencyKey('pay', { customer: 'u1', amount: 25000, reference: 'x' });
  const b = financeIdempotencyKey('pay', { reference: 'x', amount: 25000, customer: 'u1' });
  assert.equal(a, b, 'key order must not change the key');
  assert.notEqual(a, financeIdempotencyKey('pay', { customer: 'u1', amount: 25001, reference: 'x' }));
  assert.notEqual(a, financeIdempotencyKey('cn', { customer: 'u1', amount: 25000, reference: 'x' }));
});

test('23 — the audit line carries the movement but no customer identity', () => {
  const line = describeFinanceEvent({
    eventType: 'payment.recorded', amountMinor: -25000, currency: 'USD',
    reference: 'BACS-99213', balanceBefore: '1000.00', balanceAfter: '750.00',
  });
  assert.match(line, /250\.00 USD/);
  assert.match(line, /BACS-99213/);
  assert.match(line, /1000\.00 → 750\.00/);
  assert.ok(!line.includes('u_cust1'));
});

test('24 — the contract a screen renders from is frozen', () => {
  assert.deepEqual([...FINANCE_CONTRACT.offlineMethods], [...OFFLINE_PAYMENT_METHODS]);
  assert.ok(!FINANCE_CONTRACT.offlineMethods.includes('stripe'));
  assert.throws(() => { FINANCE_CONTRACT.offlineMethods = []; });
});

// ===========================================================================
// 25-42 — the governed operations
// ===========================================================================

test('25 — recording a payment moves the balance and writes one ledger event', async () => {
  const db = makeDb();
  const payment = await recordOfflinePayment(db, goodPayment(), ACTOR);
  assert.equal(payment.amount, '250.00');
  assert.equal(db.users[0].balance, '750.00', 'a payment reduces what is owed');
  assert.equal(db.financeEvents.length, 1);
  const event = db.financeEvents[0];
  assert.equal(event.event_type, 'payment.recorded');
  assert.equal(event.amount_minor, -25000, 'a payment is a negative movement');
  assert.equal(event.balance_before, '1000.00');
  assert.equal(event.balance_after, '750.00');
  assert.equal(event.reference, 'BACS-99213');
  assert.equal(event.capability, 'finance.record');
});

test('26 — every required field is on the ledger event', async () => {
  /* The brief's list, asserted as a set rather than one at a time. */
  const db = makeDb();
  await recordOfflinePayment(db, goodPayment({ notes: 'paid early' }), ACTOR);
  const event = db.financeEvents[0];
  for (const field of ['event_type', 'customer_id', 'amount_minor', 'currency',
    'balance_before', 'balance_after', 'reference', 'reason',
    'actor_id', 'actor_name', 'actor_role', 'capability', 'idempotency_key', 'created_at']) {
    assert.ok(event[field] !== undefined && event[field] !== null, `missing ${field}`);
  }
  assert.equal(event.actor_id, 'u_ops');
  assert.equal(event.actor_role, 'admin');
});

test('27 — the actor comes from the session and can never come from the body', async () => {
  const db = makeDb();
  await recordOfflinePayment(db,
    goodPayment({ actorId: 'u_someone_else', recordedBy: 'u_someone_else' }), ACTOR);
  assert.equal(db.financeEvents[0].actor_id, 'u_ops');
  assert.equal(db.payments[0].recorded_by, 'u_ops');
  assert.ok(!/req\.body\??\.(actor|actorId|recordedBy|issuedBy)/.test(financeSrc));
});

test('28 — an identical payment twice records the money once', async () => {
  const db = makeDb();
  await recordOfflinePayment(db, goodPayment(), ACTOR);
  await assert.rejects(() => recordOfflinePayment(db, goodPayment(), ACTOR),
    (err) => err instanceof FinanceError && err.status === 409 && err.body.code === 'ALREADY_RECORDED');
  assert.equal(db.payments.length, 1);
  assert.equal(db.users[0].balance, '750.00', 'the balance may move once');
  assert.equal(db.financeEvents.length, 1);
});

test('29 — a genuinely separate payment is accepted when the reference differs', async () => {
  const db = makeDb();
  await recordOfflinePayment(db, goodPayment(), ACTOR);
  await recordOfflinePayment(db, goodPayment({ reference: 'BACS-99214' }), ACTOR);
  assert.equal(db.payments.length, 2);
  assert.equal(db.users[0].balance, '500.00');
});

test('30 — a refused payment writes NOTHING, including the balance', async () => {
  const db = makeDb();
  await assert.rejects(() => recordOfflinePayment(db, goodPayment({ reference: '' }), ACTOR),
    (err) => err.status === 400);
  assert.equal(db.payments.length, 0);
  assert.equal(db.financeEvents.length, 0);
  assert.equal(db.users[0].balance, '1000.00');
});

test('31 — a payment against another customer’s invoice is refused', async () => {
  const db = makeDb({ invoices: [{ id: 'in_9', number: 'IN9', customer_id: 'u_other', amount: '99.00' }] });
  await assert.rejects(
    () => recordOfflinePayment(db, goodPayment({ invoiceId: 'in_9' }), ACTOR),
    (err) => err.status === 422 && err.body.code === 'INVOICE_NOT_FOR_CUSTOMER');
  assert.equal(db.users[0].balance, '1000.00');
});

test('32 — a credit note reduces the balance and is recorded as its own event type', async () => {
  const db = makeDb();
  const note = await issueCreditNote(db, goodCredit(), ACTOR);
  assert.equal(note.amount, '50.00');
  assert.equal(db.users[0].balance, '950.00');
  const event = db.financeEvents[0];
  assert.equal(event.event_type, 'credit_note.issued');
  assert.equal(event.capability, 'finance.credit');
  assert.equal(event.reason, 'goods damaged in transit');
  assert.equal(event.amount_minor, -5000);
});

test('33 — a credit note and a payment are DIFFERENT events even at the same amount', async () => {
  /* They look identical on a balance. The ledger must still tell them apart. */
  const db = makeDb();
  await recordOfflinePayment(db, goodPayment({ amount: '50.00', reference: 'BACS-0001' }), ACTOR);
  await issueCreditNote(db, goodCredit(), ACTOR);
  const types = db.financeEvents.map((e) => e.event_type);
  assert.deepEqual(types, ['payment.recorded', 'credit_note.issued']);
  assert.equal(db.users[0].balance, '900.00');
});

test('34 — issuing an invoice increases the balance and is idempotent', async () => {
  const db = makeDb({ orders: [order()] });
  const first = await issueInvoice(db, 'o_1', ACTOR);
  assert.equal(first.alreadyInvoiced, false);
  assert.equal(db.users[0].balance, '1250.00');
  assert.equal(db.financeEvents[0].event_type, 'invoice.issued');
  assert.equal(db.financeEvents[0].amount_minor, 25000, 'an invoice is a positive movement');

  const second = await issueInvoice(db, 'o_1', ACTOR);
  assert.equal(second.alreadyInvoiced, true);
  assert.equal(second.invoice.number, first.invoice.number, 'no second number is issued');
  assert.equal(db.users[0].balance, '1250.00', 'the balance may move once');
  assert.equal(db.financeEvents.length, 1);
});

test('35 — voiding a payment puts the debt back and keeps the row', async () => {
  const db = makeDb();
  const payment = await recordOfflinePayment(db, goodPayment(), ACTOR);
  assert.equal(db.users[0].balance, '750.00');

  const voided = await voidPayment(db, payment.id, { reason: 'keyed twice by mistake', confirm: true }, ACTOR);
  assert.ok(voided.voidedAt, 'the payment is stamped, not deleted');
  assert.equal(db.payments.length, 1, 'the row must survive');
  assert.equal(db.users[0].balance, '1000.00');
  assert.equal(db.financeEvents[1].event_type, 'payment.voided');
  assert.equal(db.financeEvents[1].reason, 'keyed twice by mistake');
});

test('36 — a Stripe payment cannot be voided; it must be refunded', async () => {
  /* Money genuinely left the customer's card. Reversing it is a refund — a
     different capability, a different provider call, a different record. */
  const db = makeDb();
  db.payments.push({ id: 'pay_stripe', customer_id: CUSTOMER_ID, amount: '250.00',
    currency: 'USD', method: 'stripe', reference: 'pi_1', voided_at: null });
  await assert.rejects(
    () => voidPayment(db, 'pay_stripe', { reason: 'not ours', confirm: true }, ACTOR),
    (err) => err.status === 422 && err.body.code === 'USE_REFUND');
  assert.equal(db.users[0].balance, '1000.00');
});

test('37 — voiding twice is refused and moves the balance once', async () => {
  const db = makeDb();
  const payment = await recordOfflinePayment(db, goodPayment(), ACTOR);
  await voidPayment(db, payment.id, { reason: 'keyed twice by mistake', confirm: true }, ACTOR);
  await assert.rejects(
    () => voidPayment(db, payment.id, { reason: 'keyed twice by mistake', confirm: true }, ACTOR),
    (err) => err.status === 409);
  assert.equal(db.users[0].balance, '1000.00');
});

test('38 — resolving an exception records who and why, and settles nothing', async () => {
  /* Letting "resolve" also settle would make the reconciliation queue a way to
     mark invoices paid by hand. */
  const db = makeDb({ events: [{ id: 'pev_1', provider_event_id: 'evt_1',
    event_type: 'checkout.session.completed', status: 'failed', invoice_id: null,
    amount_minor: 100, currency: 'USD' }] });
  const out = await resolveException(db, 'pev_1', { note: 'customer paid by transfer instead' }, ACTOR);
  assert.equal(out.status, 'resolved');
  assert.equal(db.users[0].balance, '1000.00', 'no money may move');
  const event = db.financeEvents[0];
  assert.equal(event.event_type, 'reconciliation.resolved');
  assert.equal(event.amount_minor, 0);
  assert.equal(event.capability, 'finance.reconcile');
  assert.equal(event.reason, 'customer paid by transfer instead');
  assert.ok(!financeSrc.includes("settlement_state = 'paid'"), 'no finance route may settle an invoice');
});

test('39 — an already-resolved exception is refused', async () => {
  const db = makeDb({ events: [{ id: 'pev_1', provider_event_id: 'evt_1',
    event_type: 'x', status: 'resolved', currency: 'USD' }] });
  await assert.rejects(() => resolveException(db, 'pev_1', { note: 'again and again' }, ACTOR),
    (err) => err.status === 409);
});

test('40 — a processed event is not an outstanding exception', async () => {
  const db = makeDb({ events: [{ id: 'pev_1', provider_event_id: 'evt_1',
    event_type: 'x', status: 'processed', currency: 'USD' }] });
  await assert.rejects(() => resolveException(db, 'pev_1', { note: 'nothing to do here' }, ACTOR),
    (err) => err.status === 422 && err.body.code === 'NOT_AN_EXCEPTION');
});

test('41 — the ledger reconstructs the balance independently of users.balance', async () => {
  const db = makeDb();
  await recordOfflinePayment(db, goodPayment({ amount: '100.00', reference: 'BACS-A1' }), ACTOR);
  await issueCreditNote(db, goodCredit({ amount: '25.00' }), ACTOR);
  const ledger = await customerLedger(db, CUSTOMER_ID);
  const total = ledger.reduce((sum, e) => sum + e.amountMinor, 0);
  assert.equal(total, -12500);
  assert.equal(db.users[0].balance, '875.00');
  /* 1000.00 - 125.00 — the ledger and the column agree, and the point is that
     a disagreement would now be discoverable. */
  assert.equal(Number(ledger[ledger.length - 1].balanceBefore) + total / 100, Number(db.users[0].balance));
});

test('42 — the ledger is newest first and carries the actor name as recorded', async () => {
  const db = makeDb();
  await recordOfflinePayment(db, goodPayment({ reference: 'BACS-A1' }), ACTOR);
  await recordOfflinePayment(db, goodPayment({ reference: 'BACS-B1', amount: '10.00' }), ACTOR);
  const ledger = await recentEvents(db);
  assert.equal(ledger[0].reference, 'BACS-B1');
  assert.equal(ledger[0].actorName, 'Ops');
  /* Recorded, not looked up: the ledger must still read correctly after the
     account is renamed or removed. */
  assert.match(financeSrc, /actor\?\.business \|\| actor\?\.email/);
});

// ===========================================================================
// 43-56 — structure, capabilities and the schema
// ===========================================================================

test('43 — the four finance capabilities are separate and registered', async () => {
  const { PERMISSION_KEYS } = await import('../src/permission-registry.js');
  assert.deepEqual({ ...FINANCE_CAPABILITIES }, {
    invoice: 'finance.invoice', record: 'finance.record',
    credit: 'finance.credit', reconcile: 'finance.reconcile',
  });
  for (const key of Object.values(FINANCE_CAPABILITIES)) {
    assert.ok(PERMISSION_KEYS.includes(key), `registry missing ${key}`);
    assert.ok(migration.includes(`'${key}'`), `migration CHECK missing ${key}`);
    assert.ok(migrateJs.includes(`'${key}'`), `ensureSchema CHECK missing ${key}`);
  }
});

test('44 — holding finance.record does not confer finance.credit', async () => {
  const db = { query: async () => ({ rows: [{ permission_key: 'finance.record' }] }) };
  assert.deepEqual(await getFinanceCapabilities(db, 'u_ops'),
    { invoice: false, record: true, credit: false, reconcile: false });
});

test('45 — every write route is gated on the right capability, with no role fallback', () => {
  assert.match(financeSrc, /r\.post\('\/orders\/:orderId\/invoice',\s*canInvoice\(\)/);
  assert.match(financeSrc, /r\.post\('\/payments',\s*canRecord\(\)/);
  assert.match(financeSrc, /r\.post\('\/payments\/:paymentId\/void',\s*canRecord\(\)/);
  assert.match(financeSrc, /r\.post\('\/credit-notes',\s*canCredit\(\)/);
  assert.match(financeSrc, /r\.post\('\/reconciliation\/:eventId\/resolve',\s*canReconcile\(\)/);
  assert.ok(!/req\.user\.role\s*===/.test(financeSrc), 'a role check leaked into the finance router');
  const posts = financeSrc.match(/r\.post\('[^']+',\s*\w+\(\)/g) || [];
  assert.equal(posts.length, 5, 'exactly the five named write routes');
});

test('46 — there is no DELETE route and no DELETE statement anywhere', () => {
  assert.ok(!/r\.delete\(/.test(financeSrc));
  assert.ok(!/delete\s+from\s+(payments|credit_notes|finance_events|invoices)/i.test(financeSrc));
});

test('47 — no finance route can set a balance directly', () => {
  /* Every movement is the arithmetic consequence of an invoice, a payment or a
     credit note, applied by one function. */
  const assignments = financeSrc.match(/set balance = [^\n]*/g) || [];
  assert.equal(assignments.length, 1, 'exactly one balance write in the whole file');
  assert.match(assignments[0], /coalesce\(balance,0\) \+ \$2/, 'and it is a relative movement');
});

test('48 — every balance movement goes through the one audited function', () => {
  /* A future operation that forgets to log is a change to applyMovement rather
     than a silently missing ledger row. */
  const calls = financeSrc.match(/applyMovement\(/g) || [];
  assert.ok(calls.length >= 6, 'each operation must call it');
  const body = financeSrc.slice(financeSrc.indexOf('async function applyMovement'));
  assert.match(body.slice(0, 2000), /insert into finance_events/);
});

test('49 — a duplicate ledger event rolls the whole transaction back', async () => {
  /* The retry guard: a repeated request must not move the balance a second
     time against a ledger entry that already exists. */
  const db = makeDb();
  await recordOfflinePayment(db, goodPayment(), ACTOR);
  const balanceAfterFirst = db.users[0].balance;
  await assert.rejects(() => recordOfflinePayment(db, goodPayment(), ACTOR));
  assert.equal(db.users[0].balance, balanceAfterFirst);
});

test('50 — finance_events is append-only in both the migration and the mirror', () => {
  assert.match(migration, /create or replace function finance_events_immutable/);
  assert.match(migration, /t_finance_events_no_update/);
  assert.match(migration, /t_finance_events_no_delete/);
  assert.match(migrateJs, /finance_events_immutable/);
  assert.match(migrateJs, /t_finance_events_no_delete/);
});

test('51 — no code path attempts to update or delete a finance event', async () => {
  /* The double raises the same exception PostgreSQL would. If any operation
     tried, these would fail. */
  const db = makeDb({ orders: [order()] });
  await issueInvoice(db, 'o_1', ACTOR);
  await recordOfflinePayment(db, goodPayment({ reference: 'BACS-X1' }), ACTOR);
  await issueCreditNote(db, goodCredit(), ACTOR);
  assert.equal(db.financeEvents.length, 3);
  assert.ok(!/update finance_events/i.test(financeSrc));
  assert.ok(!/delete from finance_events/i.test(financeSrc));
});

test('52 — the legacy order-invoice route delegates rather than duplicating', () => {
  /* Two implementations of "turn an order into a debt" is one too many, and
     the copy in admin.js had no structured financial record at all. */
  assert.match(adminSrc, /issueInvoice\(financeDb, req\.params\.id, req\.user/);
  const handler = adminSrc.slice(adminSrc.indexOf("r.post('/orders/:id/invoice'"),
    adminSrc.indexOf("r.post('/orders/:id/invoice'") + 1200);
  assert.ok(!/insert into invoices/i.test(handler), 'the legacy route must not insert its own invoice');
  assert.ok(!/update users set balance/i.test(handler), 'nor move the balance itself');
});

test('53 — the legacy route keeps its admin gate as a documented bootstrap', () => {
  /* No account holds finance.invoice until somebody grants it; silently making
     invoicing impossible for every administrator would be worse than the
     problem being fixed. */
  const handler = adminSrc.slice(adminSrc.indexOf("r.post('/orders/:id/invoice'"));
  assert.match(handler.slice(0, 400), /isFinancialActor\(req\.user\)/);
});

test('54 — the schema is additive and destroys nothing', () => {
  assert.doesNotMatch(migration, /drop table/i);
  assert.doesNotMatch(migration, /drop column/i);
  assert.doesNotMatch(migration, /alter column/i);
  assert.doesNotMatch(migration, /truncate/i);
  assert.doesNotMatch(migration, /delete from/i);
  assert.doesNotMatch(migration, /insert into account_permissions/i);
});

test('55 — the idempotency and attribution constraints exist in both definitions', () => {
  for (const fragment of ['payments_idempotency_idx', 'credit_notes_idempotency_idx',
    'payments_void_attributed', 'credit_notes_reasoned',
    'payment_events_resolution_explained', 'finance_events']) {
    assert.ok(migration.includes(fragment), `migration missing ${fragment}`);
    assert.ok(migrateJs.includes(fragment), `ensureSchema missing ${fragment}`);
  }
});

test('56 — existing credit notes are grandfathered rather than retroactively invalidated', () => {
  /* A constraint that a history you cannot explain would violate is a
     constraint that stops the migration. */
  assert.match(migration, /check \(issued_by is null or reason <> ''\)/);
});

test('57 — the serializers are allowlists and leak no internal column', () => {
  const payment = serializePayment({ id: 'p1', customer_id: 'u1', amount: '10.00',
    idempotency_key: 'pay_secret', recorded_by: 'u_ops', internal: 'nope' });
  assert.equal('idempotency_key' in payment, false);
  assert.equal('internal' in payment, false);

  const event = serializeFinanceEvent({ id: 'f1', event_type: 'payment.recorded',
    idempotency_key: 'fev_secret', actor_id: 'u_ops', internal: 'nope' });
  assert.equal('idempotency_key' in event, false);
  assert.equal('actorId' in event, false, 'the ledger returns the recorded NAME, not a live id lookup');
  assert.equal('internal' in event, false);

  const note = serializeCreditNote({ id: 'c1', amount: '5.00', idempotency_key: 'cn_secret' });
  assert.equal('idempotency_key' in note, false);
});

test('58 — the event type vocabulary is closed', () => {
  assert.deepEqual([...FINANCE_EVENT_TYPES], [
    'invoice.issued', 'payment.recorded', 'payment.voided', 'credit_note.issued',
    'refund.requested', 'refund.settled', 'settlement.applied', 'reconciliation.resolved',
  ]);
  for (const type of FINANCE_EVENT_TYPES) {
    assert.ok(migration.includes(`'${type}'`), `migration CHECK missing ${type}`);
  }
});
