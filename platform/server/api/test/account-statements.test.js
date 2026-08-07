/* Account statements (Final Handover, Phase 6).

   Real aggregation, real PDFs, real outbox delivery against a controlled
   double. Every customer, amount and address here is invented.

   The property under test throughout: the button that used to toast
   "Statement emailed" without generating, attaching or sending anything now
   cannot report a send that did not happen. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  LINE_KINDS, RECIPIENT_LABELS, RECIPIENT_REASONS,
  ageingBuckets, buildStatement, chooseRecipient, currenciesFor, parsePeriod,
  periodLabel, readableDate, serializeStatement, statementFilename,
  statementIdempotencyKey,
} from '../src/documents/statement.js';
import { renderStatementPdf } from '../src/documents/statement-pdf.js';
import statementRouter, {
  STATEMENT_CAPABILITIES, StatementError,
  buildStatementFor, getStatementCapabilities, loadMovements, openingBalanceMinor,
  proposedRecipient, sendStatement, statementCurrencies, statementHistory,
} from '../src/routes/admin-statements.js';
import {
  markStatementSentOnDelivery, statementAttachmentResolver,
} from '../src/notifications/statement-delivery.js';
import { runOnce } from '../src/notifications/worker.js';
import { resolveBrand } from '../src/documents/brand-config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const MIGRATIONS = path.join(path.dirname(ROOT), 'db', 'migrations');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const migration = fs.readFileSync(path.join(MIGRATIONS, '0015_account_statements.sql'), 'utf8')
  .replace(/--[^\n]*/g, ' ');
const migrateJs = read('migrate.js');
const routeSrc = code('routes', 'admin-statements.js');
const financePageSrc = fs.readFileSync(path.join(path.dirname(path.dirname(path.dirname(ROOT))), 'js', 'pages_finance.js'), 'utf8');

const T0 = new Date('2026-08-07T09:00:00.000Z');
const ACTOR = { id: 'u_ops', email: 'ops@example.test', business: 'Ops', role: 'admin' };
const CUSTOMER_ID = 'u_cust1';

const BRAND = resolveBrand({
  VEYORA_LEGAL_NAME: 'Veyora Example Ltd',
  VEYORA_ADDRESS_LINE1: '1 Example Way',
  VEYORA_ADDRESS_CITY: 'Exampleton',
  VEYORA_ADDRESS_POSTCODE: 'EX1 1EX',
  VEYORA_ADDRESS_COUNTRY: 'Exampleland',
  VEYORA_CONTACT_EMAIL: 'billing@example.test',
  VEYORA_TAX_NUMBER: 'VATEX000000',
  VEYORA_COMPANY_NUMBER: 'EX-000000',
  VEYORA_BANK_NAME: 'Example Bank',
  VEYORA_BANK_IBAN: 'EX00 0000',
});

const CUSTOMER = {
  id: CUSTOMER_ID, business: 'Example Optics', customer_number: '1001',
  email: 'sam@example.test', first_name: 'Sam', last_name: 'Example',
  address: '2 Example Street', city: 'Exampleburg', state: 'EX', zip: 'EX2 2EX',
  country: 'Exampleland',
};

const mv = (kind, date, amountMinor, over = {}) => ({
  kind, date, amountMinor, currency: 'USD',
  reference: `${kind}-${date}`, description: kind, ...over,
});

/* --------------------------------------------------------------------------
   The PDF text extractor, as in the invoice tests
   -------------------------------------------------------------------------- */
function textOf(bytes) {
  const raw = bytes.toString('latin1');
  const out = [];
  const streamRe = /stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let content;
    try { content = zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'); }
    catch { continue; }
    for (const t of content.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)) {
      const hex = t[1].replace(/\s+/g, '');
      let s = '';
      for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      out.push(s);
    }
  }
  return out;
}
const allText = (bytes) => textOf(bytes).join('\n');
const pageCount = (bytes) => (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

/* --------------------------------------------------------------------------
   The database double
   -------------------------------------------------------------------------- */

function makeDb({
  invoices = [], payments = [], creditNotes = [], refunds = [],
  contacts = [], statements = [], outbox = [], customer = CUSTOMER,
} = {}) {
  let statementTable = statements.map((s) => ({ ...s }));
  let outboxTable = outbox.map((o) => ({ ...o }));
  let seq = 0;

  async function query(sql, params = []) {
    if (/from invoices where customer_id/is.test(sql)) return { rows: invoices.map((r) => ({ ...r })) };
    if (/from payments where customer_id/is.test(sql)) {
      return { rows: payments.filter((p) => !p.voided_at).map((r) => ({ ...r })) };
    }
    if (/from credit_notes where customer_id/is.test(sql)) return { rows: creditNotes.map((r) => ({ ...r })) };
    if (/from payment_refunds/is.test(sql)) return { rows: refunds.map((r) => ({ ...r })) };
    if (/from users where id = \$1/is.test(sql)) {
      return { rows: customer && customer.id === params[0] ? [{ ...customer }] : [] };
    }
    if (/from customer_contacts where customer_id/is.test(sql)) {
      return { rows: contacts.filter((c) => c.is_active !== false).map((r) => ({ ...r })) };
    }

    if (/^\s*insert into account_statements/is.test(sql)) {
      const key = params[11];
      if (statementTable.some((s) => s.idempotency_key === key)) return { rows: [] };
      const row = {
        id: `stm_${++seq}`, customer_id: params[0], period_from: params[1], period_to: params[2],
        currency: params[3], opening_minor: params[4], closing_minor: params[5],
        line_count: params[6], generated_by: params[7], status: 'queued',
        recipient_contact_id: params[8], recipient_address: params[9],
        recipient_reason: params[10], idempotency_key: key,
        generated_at: T0, sent_at: null, notification_id: null, last_error: '',
      };
      statementTable.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^\s*update account_statements set notification_id/is.test(sql)) {
      const s = statementTable.find((x) => x.id === params[0]);
      if (s) s.notification_id = params[1];
      return { rows: [] };
    }
    if (/^\s*update account_statements\s+set status = 'sent'/is.test(sql)) {
      const s = statementTable.find((x) => x.id === params[0] && x.status === 'queued');
      if (s) { s.status = 'sent'; s.sent_at = params[1]; s.last_error = ''; }
      return { rows: [] };
    }
    if (/from account_statements\s+where customer_id/is.test(sql)) {
      return { rows: [...statementTable].reverse().map((s) => ({ ...s })) };
    }
    if (/from account_statements where id = \$1/is.test(sql)) {
      const s = statementTable.find((x) => x.id === params[0]);
      return { rows: s ? [{ ...s }] : [] };
    }

    // ---- outbox ----
    if (/^\s*insert into notification_outbox/is.test(sql)) {
      const [type, sourceType, sourceId, address, name, key, version, data, idem] = params;
      if (outboxTable.some((r) => r.idempotency_key === idem)) return { rows: [] };
      const row = {
        id: `ntf_${++seq}`, notification_type: type, source_type: sourceType, source_id: sourceId,
        recipient_address: address, recipient_name: name, template_key: key,
        template_version: version, template_data: JSON.parse(data), status: 'pending',
        attempt_count: 0, next_attempt_at: T0, claimed_at: null, claim_expires_at: null,
        last_attempted_at: null, delivered_at: null, failed_at: null, last_error: '',
        provider_reference: '', idempotency_key: idem, created_at: T0, updated_at: T0,
      };
      outboxTable.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^\s*update notification_outbox\s+set status = 'processing'/is.test(sql)) {
      const [limit, now, expiry] = params;
      const due = outboxTable
        .filter((r) => ['pending', 'retry_scheduled'].includes(r.status) && r.next_attempt_at <= now)
        .slice(0, limit);
      for (const r of due) { r.status = 'processing'; r.claimed_at = now; r.claim_expires_at = expiry; }
      return { rows: due.map((r) => ({ ...r })) };
    }
    if (/set status = 'delivered'/is.test(sql)) {
      const r = outboxTable.find((x) => x.id === params[0]);
      if (!r) return { rows: [] };
      Object.assign(r, { status: 'delivered', delivered_at: params[1], provider_reference: params[2],
        attempt_count: r.attempt_count + 1, last_error: '' });
      return { rows: [{ ...r }] };
    }
    if (/select attempt_count from notification_outbox/is.test(sql)) {
      const r = outboxTable.find((x) => x.id === params[0]);
      return { rows: r ? [{ attempt_count: r.attempt_count }] : [] };
    }
    if (/set status = 'retry_scheduled'/is.test(sql)) {
      const r = outboxTable.find((x) => x.id === params[0]);
      if (!r) return { rows: [] };
      Object.assign(r, { status: 'retry_scheduled', next_attempt_at: params[1],
        attempt_count: params[3], last_error: params[4] });
      return { rows: [{ ...r }] };
    }
    if (/set status = 'failed'/is.test(sql)) {
      const r = outboxTable.find((x) => x.id === params[0]);
      if (!r) return { rows: [] };
      Object.assign(r, { status: 'failed', failed_at: params[1], attempt_count: params[2], last_error: params[3] });
      return { rows: [{ ...r }] };
    }
    if (/where source_type = \$1 and source_id = \$2/is.test(sql)) {
      return { rows: outboxTable.filter((r) => r.source_type === params[0] && r.source_id === params[1])
        .map((r) => ({ ...r })) };
    }
    if (/insert into audit_log/is.test(sql)) return { rows: [] };
    return { rows: [] };
  }

  return {
    query,
    get statements() { return statementTable; },
    get outbox() { return outboxTable; },
    async tx(fn) {
      const snap = { s: statementTable.map((x) => ({ ...x })), o: outboxTable.map((x) => ({ ...x })) };
      try { return await fn({ query }); }
      catch (e) { statementTable = snap.s; outboxTable = snap.o; throw e; }
    },
  };
}

const fullDb = (over = {}) => makeDb({
  invoices: [
    { id: 'in_1', number: 'IN1001', order_number: 'SO1', amount: '1000.00',
      settlement_currency: 'USD', issued_on: '2026-07-05' },
    { id: 'in_2', number: 'IN1002', order_number: 'SO2', amount: '500.00',
      settlement_currency: 'USD', issued_on: '2026-08-02' },
  ],
  payments: [
    { id: 'pay_1', amount: '400.00', currency: 'USD', method: 'transfer',
      reference: 'BACS-1', paid_on: '2026-08-03', voided_at: null },
  ],
  creditNotes: [
    { id: 'cn_1', amount: '50.00', currency: 'USD', reason: 'damaged in transit',
      reference: 'CN-1', issued_on: '2026-08-04' },
  ],
  ...over,
});

// ===========================================================================
// 1-12 — the arithmetic
// ===========================================================================

test('1 — the closing balance is COMPUTED, never read from a balance column', async () => {
  /* The screen this replaces took the CURRENT balance as the closing figure
     and subtracted activity to derive an opening one, so any statement for a
     PAST period silently reported today's balance as that period's closing
     balance. */
  const statement = buildStatement({
    customer: CUSTOMER, currency: 'USD', from: '2026-08-01', to: '2026-08-31',
    openingMinor: 100000,
    movements: [mv('invoice', '2026-08-02', 50000), mv('payment', '2026-08-03', 40000)],
    generatedAt: T0,
  });
  assert.equal(statement.closingMinor, 110000, '1000 + 500 - 400');
  /* And no balance column is consulted anywhere in the builder or the route. */
  assert.ok(!/users\.balance|u\.balance/.test(routeSrc));
});

test('2 — an invoice increases the balance; a payment and a credit note decrease it', () => {
  const s = buildStatement({
    customer: CUSTOMER, currency: 'USD', from: '2026-08-01', to: '2026-08-31',
    openingMinor: 0,
    movements: [
      mv('invoice', '2026-08-01', 10000),
      mv('payment', '2026-08-02', 3000),
      mv('credit_note', '2026-08-03', 2000),
      mv('refund', '2026-08-04', 1000),
    ],
    generatedAt: T0,
  });
  assert.deepEqual(s.lines.map((l) => l.balanceMinor), [10000, 7000, 5000, 6000]);
  assert.equal(s.closingMinor, 6000);
});

test('3 — the amount sign comes from the KIND, so a negative cannot invert a credit', () => {
  const s = buildStatement({
    customer: CUSTOMER, currency: 'USD', from: '2026-08-01', to: '2026-08-31',
    openingMinor: 0,
    movements: [mv('payment', '2026-08-02', -3000)],
    generatedAt: T0,
  });
  assert.equal(s.lines[0].creditMinor, 3000, 'still a credit');
  assert.equal(s.closingMinor, -3000);
});

test('4 — movements outside the period are excluded from the running balance', () => {
  const s = buildStatement({
    customer: CUSTOMER, currency: 'USD', from: '2026-08-01', to: '2026-08-31',
    openingMinor: 0,
    movements: [
      mv('invoice', '2026-07-31', 99900),
      mv('invoice', '2026-08-15', 10000),
      mv('invoice', '2026-09-01', 88800),
    ],
    generatedAt: T0,
  });
  assert.equal(s.lines.length, 1);
  assert.equal(s.closingMinor, 10000);
});

test('5 — a movement in another currency never reaches the running balance', () => {
  /* A running balance mixing USD and EUR is arithmetic nobody can defend. */
  const s = buildStatement({
    customer: CUSTOMER, currency: 'USD', from: '2026-08-01', to: '2026-08-31',
    openingMinor: 0,
    movements: [
      mv('invoice', '2026-08-02', 10000),
      mv('invoice', '2026-08-03', 77700, { currency: 'EUR' }),
    ],
    generatedAt: T0,
  });
  assert.equal(s.lines.length, 1);
  assert.equal(s.closingMinor, 10000);
});

test('6 — the currencies a customer has activity in are reported so a choice can be made', () => {
  const found = currenciesFor([
    mv('invoice', '2026-08-01', 100), mv('invoice', '2026-08-02', 100),
    mv('payment', '2026-08-03', 50, { currency: 'EUR' }),
  ]);
  assert.deepEqual(found, [{ currency: 'USD', movements: 2 }, { currency: 'EUR', movements: 1 }]);
});

test('7 — line ordering is total, so the running balance is reproducible', () => {
  const movements = [
    mv('payment', '2026-08-02', 100, { reference: 'B' }),
    mv('invoice', '2026-08-02', 200, { reference: 'A' }),
    mv('invoice', '2026-08-02', 300, { reference: 'C' }),
  ];
  const a = buildStatement({ customer: CUSTOMER, currency: 'USD', from: '2026-08-01',
    to: '2026-08-31', openingMinor: 0, movements, generatedAt: T0 });
  const b = buildStatement({ customer: CUSTOMER, currency: 'USD', from: '2026-08-01',
    to: '2026-08-31', openingMinor: 0, movements: [...movements].reverse(), generatedAt: T0 });
  assert.deepEqual(a.lines.map((l) => l.reference), b.lines.map((l) => l.reference));
  assert.deepEqual(a.lines.map((l) => l.reference), ['A', 'C', 'B'], 'invoices before payments on a day');
});

test('8 — the opening balance sums everything BEFORE the period', async () => {
  const db = fullDb();
  const movements = await loadMovements(db, CUSTOMER_ID);
  const opening = openingBalanceMinor(movements, { before: '2026-08-01', currency: 'USD' });
  assert.equal(opening, 100000, 'only the July invoice');
});

test('9 — a voided payment is excluded, because the money did not arrive', async () => {
  const db = makeDb({
    payments: [
      { id: 'p1', amount: '100.00', currency: 'USD', method: 'transfer', reference: 'A',
        paid_on: '2026-08-02', voided_at: null },
      { id: 'p2', amount: '999.00', currency: 'USD', method: 'transfer', reference: 'B',
        paid_on: '2026-08-03', voided_at: new Date() },
    ],
  });
  const movements = await loadMovements(db, CUSTOMER_ID);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].reference, 'A');
  /* Showing the payment AND its void would be internally correct and
     externally baffling. */
  assert.match(routeSrc, /voided_at is null/);
});

test('10 — a period is validated and must run forwards', () => {
  assert.equal(parsePeriod('2026-08-01', '2026-08-31').ok, true);
  assert.equal(parsePeriod('2026-08-31', '2026-08-01').ok, false);
  assert.equal(parsePeriod('01/08/2026', '2026-08-31').ok, false);
  assert.equal(parsePeriod('', '').ok, false);
  assert.equal(parsePeriod('2020-01-01', '2026-08-31').ok, false, 'more than three years');
});

test('11 — ageing is computed from invoices only', () => {
  /* Ages relative to 2026-08-31: 30, 47, 77 and 242 days. */
  const buckets = ageingBuckets([
    { kind: 'invoice', date: '2026-08-01', debitMinor: 1000 },
    { kind: 'invoice', date: '2026-07-15', debitMinor: 1500 },
    { kind: 'invoice', date: '2026-06-15', debitMinor: 2000 },
    { kind: 'invoice', date: '2026-01-01', debitMinor: 3000 },
    /* A payment has no age, and including credits would make a bucket that
       nets to zero look like nothing is outstanding when two things are. */
    { kind: 'payment', date: '2026-08-01', debitMinor: 0, creditMinor: 5000 },
  ], '2026-08-31');
  assert.equal(buckets.current, 1000);
  assert.equal(buckets.days30, 1500);
  assert.equal(buckets.days60, 2000);
  assert.equal(buckets.days90plus, 3000);
});

test('12 — everything is in minor units and formatted once', () => {
  const s = buildStatement({ customer: CUSTOMER, currency: 'USD', from: '2026-08-01',
    to: '2026-08-31', openingMinor: 0,
    movements: [mv('invoice', '2026-08-02', 2997)], generatedAt: T0 });
  const out = serializeStatement(s);
  assert.equal(out.closingMinor, 2997);
  assert.equal(out.closing, '29.97');
  assert.equal(out.lines[0].debit, '29.97');
});

// ===========================================================================
// 13-22 — recipients
// ===========================================================================

const contact = (over = {}) => ({
  id: 'cc_1', first_name: 'Ada', last_name: 'Sterling', email: 'ada@example.test',
  responsibilities: [], is_primary: false, is_active: true, ...over,
});

test('13 — the accounts-payable contact is preferred', () => {
  const r = chooseRecipient({
    contacts: [
      contact({ id: 'cc_1', email: 'primary@example.test', is_primary: true }),
      contact({ id: 'cc_2', email: 'ap@example.test', responsibilities: ['accounts_payable'] }),
    ],
    customer: CUSTOMER,
  });
  assert.equal(r.address, 'ap@example.test');
  assert.equal(r.reason, 'accounts_payable_contact');
  assert.equal(r.contactId, 'cc_2');
});

test('14 — the primary contact is the fallback', () => {
  const r = chooseRecipient({
    contacts: [contact({ email: 'primary@example.test', is_primary: true })],
    customer: CUSTOMER,
  });
  assert.equal(r.address, 'primary@example.test');
  assert.equal(r.reason, 'primary_contact');
});

test('15 — the account email is the last resort', () => {
  const r = chooseRecipient({ contacts: [], customer: CUSTOMER });
  assert.equal(r.address, 'sam@example.test');
  assert.equal(r.reason, 'account_email');
});

test('16 — an explicit override beats everything', () => {
  const r = chooseRecipient({
    contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })],
    customer: CUSTOMER, override: 'someone@example.test',
  });
  assert.equal(r.address, 'someone@example.test');
  assert.equal(r.reason, 'explicit_override');
  assert.equal(r.contactId, null);
});

test('17 — a malformed override is refused rather than silently ignored', () => {
  const r = chooseRecipient({ contacts: [], customer: CUSTOMER, override: 'not-an-address' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_OVERRIDE');
});

test('18 — an archived contact is never chosen', () => {
  const r = chooseRecipient({
    contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'], is_active: false })],
    customer: CUSTOMER,
  });
  assert.equal(r.reason, 'account_email');
});

test('19 — a contact with no email is skipped', () => {
  const r = chooseRecipient({
    contacts: [contact({ email: '', responsibilities: ['accounts_payable'] }),
      contact({ id: 'cc_2', email: 'primary@example.test', is_primary: true })],
    customer: CUSTOMER,
  });
  assert.equal(r.reason, 'primary_contact');
});

test('20 — no recipient at all is reported, never sent to nowhere', () => {
  const r = chooseRecipient({ contacts: [], customer: { email: '' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_RECIPIENT');
  assert.match(r.error, /Enter an address to send to, or add a store contact first/);
});

test('21 — the reason is reported with a readable label before sending', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  const r = await proposedRecipient(db, CUSTOMER_ID);
  assert.equal(r.reasonLabel, 'accounts-payable contact');
  assert.equal(r.name, 'Ada Sterling');
  assert.deepEqual([...RECIPIENT_REASONS].sort(), Object.keys(RECIPIENT_LABELS).sort());
});

test('22 — every recipient reason is storable', () => {
  for (const reason of RECIPIENT_REASONS) {
    assert.ok(migration.includes(`'${reason}'`), `migration CHECK missing ${reason}`);
    assert.ok(migrateJs.includes(`'${reason}'`), `ensureSchema CHECK missing ${reason}`);
  }
});

// ===========================================================================
// 23-32 — the document
// ===========================================================================

async function buildPdf(over = {}) {
  const db = fullDb(over.db);
  const statement = await buildStatementFor(db, CUSTOMER_ID, {
    from: '2026-08-01', to: '2026-08-31', currency: 'USD', generatedAt: T0, brand: BRAND,
    ...over.options,
  });
  return { statement, bytes: await renderStatementPdf(statement) };
}

test('23 — the statement is a real PDF carrying every required element', async () => {
  const { bytes } = await buildPdf();
  assert.equal(bytes.slice(0, 5).toString(), '%PDF-');
  const text = allText(bytes);
  assert.match(text, /ACCOUNT STATEMENT/);
  assert.match(text, /Example Optics/, 'the customer identity');
  assert.match(text, /Customer 1001/);
  assert.match(text, /1 August 2026 to 31 August 2026/, 'the period');
  assert.match(text, /OPENING BALANCE/);
  assert.match(text, /CLOSING BALANCE/);
  assert.match(text, /Currency: USD/);
  assert.match(text, /Generated 2026-08-07/, 'the generated timestamp');
  assert.match(text, /Veyora Example Ltd/, 'the Veyora identity');
});

test('24 — invoices, payments, credit notes and the running balance all appear', async () => {
  const { bytes } = await buildPdf();
  const text = allText(bytes);
  assert.match(text, /IN1002/);
  assert.match(text, /BACS-1/);
  assert.match(text, /damaged in transit/);
  assert.match(text, /Opening balance/);
  assert.match(text, /Closing balance/);
});

test('25 — the arithmetic on the page is the arithmetic in the model', async () => {
  const { statement, bytes } = await buildPdf();
  assert.equal(statement.openingMinor, 100000);
  assert.equal(statement.closingMinor, 105000, '1000 + 500 - 400 - 50');
  assert.match(allText(bytes), /1050\.00 USD/);
});

test('26 — a refund appears as a debit', async () => {
  const { statement } = await buildPdf({ db: {
    refunds: [{ id: 'r1', amount_minor: 10000, currency: 'USD', reason: 'returned',
      created_at: '2026-08-06', invoice_number: 'IN1002' }],
  } });
  const refundLine = statement.lines.find((l) => l.kind === 'refund');
  assert.ok(refundLine);
  assert.equal(refundLine.debitMinor, 10000);
});

test('27 — payment instructions appear when a balance is outstanding', async () => {
  const { bytes } = await buildPdf();
  const text = allText(bytes);
  assert.match(text, /payable on your usual account terms/i);
  assert.match(text, /Example Bank/);
  assert.match(text, /each invoice carries its own payment link/i);
});

test('28 — a credit balance is described as credit, not as a debt', async () => {
  const { bytes } = await buildPdf({ db: {
    invoices: [], payments: [{ id: 'p1', amount: '250.00', currency: 'USD', method: 'transfer',
      reference: 'BACS-9', paid_on: '2026-08-02', voided_at: null }], creditNotes: [],
  } });
  assert.match(allText(bytes), /account is in credit/i);
});

test('29 — an empty period says so plainly', async () => {
  const { bytes, statement } = await buildPdf({
    options: { from: '2026-01-01', to: '2026-01-31' },
  });
  assert.equal(statement.lines.length, 0);
  assert.match(allText(bytes), /no activity on this account during the period/i);
});

test('30 — a long statement paginates and repeats its header', async () => {
  const invoices = Array.from({ length: 90 }, (_, i) => ({
    id: `in_${i}`, number: `IN2${String(i).padStart(3, '0')}`, order_number: `SO${i}`,
    amount: '10.00', settlement_currency: 'USD', issued_on: '2026-08-10',
  }));
  const { bytes } = await buildPdf({ db: { invoices } });
  assert.ok(pageCount(bytes) >= 2);
  assert.ok(textOf(bytes).filter((t) => t === 'BALANCE').length >= 2, 'the header repeats');
  const text = allText(bytes);
  assert.match(text, /Page 1 of/);
  assert.match(text, /IN2089/, 'the last line survives pagination');
});

test('31 — the ageing block appears when something is outstanding', async () => {
  const { bytes } = await buildPdf();
  const text = allText(bytes);
  assert.match(text, /OUTSTANDING BY AGE/);
  assert.match(text, /Over 90 days/);
});

test('32 — the filename is stable and safe', () => {
  assert.equal(statementFilename('1001', '2026-08-01', '2026-08-31'),
    'Veyora-Statement-1001-2026-08-01_2026-08-31.pdf');
  assert.equal(statementFilename('../etc', '2026-08-01', '2026-08-31'),
    'Veyora-Statement-..etc-2026-08-01_2026-08-31.pdf');
  assert.equal(statementFilename('', 'x', 'y'), 'Veyora-Statement-account-_.pdf');
});

// ===========================================================================
// 33-46 — sending
// ===========================================================================

test('33 — the fake "Send to Customer" behaviour is gone', () => {
  /* It toasted "Statement emailed to …" and wrote an audit line, having
     generated, attached and sent nothing. A false record is worse than no
     button, because it is consulted later and believed. */
  /* Comments stripped: the replacement's own header QUOTES the old code to
     explain what it replaced, and an assertion satisfied — or defeated — by a
     comment is no assertion at all. */
  const stripped = financePageSrc
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const screen = stripped.slice(stripped.indexOf("App.register('statements'"));
  assert.ok(!/toast\('Statement emailed/.test(screen), 'the fake toast must be gone');
  assert.ok(!/DB\.audit\('statement\.send'/.test(screen), 'and the fake audit line with it');
  /* And the browser no longer computes the statement at all. */
  assert.ok(!/DB\.d\.invoices/.test(screen), 'the browser must not aggregate the ledger');
  assert.match(screen, /DB\.statementPreview/, 'every figure comes from the server');
});

test('34 — sending records the statement AND queues a notification, in one transaction', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  const out = await sendStatement(db, CUSTOMER_ID,
    { from: '2026-08-01', to: '2026-08-31', currency: 'USD' }, ACTOR, { now: T0 });

  assert.equal(out.status, 'queued', 'never "sent" from a route');
  assert.equal(db.statements.length, 1);
  assert.equal(db.outbox.length, 1);
  assert.equal(db.outbox[0].source_type, 'account_statement');
  assert.equal(db.outbox[0].source_id, db.statements[0].id);
  assert.equal(db.statements[0].notification_id, db.outbox[0].id);
});

test('35 — the recipient and the REASON are recorded on the statement', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  const out = await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });
  assert.equal(out.recipientAddress, 'ap@example.test');
  assert.equal(out.recipientReason, 'accounts_payable_contact');
  assert.equal(out.recipientReasonLabel, 'accounts-payable contact');
  /* Recorded because "why did this go to the owner rather than accounts
     payable?" is asked months later, and the contact table as it stands then
     would give the wrong answer. */
});

test('36 — no route can mark a statement sent', () => {
  assert.ok(!/status = 'sent'/.test(routeSrc), 'no route may set sent');
  assert.match(code('notifications', 'statement-delivery.js'), /set status = 'sent'/);
});

test('37 — a statement becomes sent ONLY on confirmed delivery', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });
  assert.equal(db.statements[0].status, 'queued');

  const adapter = {
    async send() { return { ok: true, providerReference: 'msg-1' }; },
  };
  await runOnce(db, adapter, {
    now: () => T0,
    attachmentResolver: statementAttachmentResolver({ db, buildStatementFor, brand: BRAND }),
    onDelivered: markStatementSentOnDelivery({ db }),
  });

  assert.equal(db.outbox[0].status, 'delivered');
  assert.equal(db.statements[0].status, 'sent');
  assert.ok(db.statements[0].sent_at);
});

test('38 — a FAILED delivery never marks the statement sent', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });

  const adapter = {
    async send() { return { ok: false, retryable: true, code: 'SMTP_TIMEOUT', message: 'timed out' }; },
  };
  await runOnce(db, adapter, {
    now: () => T0,
    attachmentResolver: statementAttachmentResolver({ db, buildStatementFor, brand: BRAND }),
    onDelivered: markStatementSentOnDelivery({ db }),
  });

  assert.equal(db.statements[0].status, 'queued', 'still queued, never sent');
  assert.equal(db.outbox[0].status, 'retry_scheduled');
});

test('39 — an unconfigured provider queues rather than reporting success', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });

  const adapter = {
    async send() { return { ok: false, retryable: true, code: 'NOT_CONFIGURED', message: 'no provider' }; },
  };
  await runOnce(db, adapter, {
    now: () => T0,
    attachmentResolver: statementAttachmentResolver({ db, buildStatementFor, brand: BRAND }),
    onDelivered: markStatementSentOnDelivery({ db }),
  });
  assert.equal(db.statements[0].status, 'queued');
  assert.equal(db.outbox[0].last_error, 'NOT_CONFIGURED: no provider');
});

test('40 — the PDF is attached to the outgoing message', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });

  let sentMessage = null;
  const adapter = {
    async send(message) { sentMessage = message; return { ok: true, providerReference: 'msg-1' }; },
  };
  await runOnce(db, adapter, {
    now: () => T0,
    attachmentResolver: statementAttachmentResolver({ db, buildStatementFor, brand: BRAND }),
    onDelivered: markStatementSentOnDelivery({ db }),
  });

  assert.ok(Array.isArray(sentMessage.attachments), 'an attachment must be present');
  assert.equal(sentMessage.attachments.length, 1);
  assert.equal(sentMessage.attachments[0].contentType, 'application/pdf');
  assert.match(sentMessage.attachments[0].filename, /^Veyora-Statement-1001-/);
  assert.equal(sentMessage.attachments[0].content.slice(0, 5).toString(), '%PDF-');
});

test('41 — nothing binary is stored; the PDF is regenerated at send time', () => {
  assert.ok(!/pdf_bytes|document_blob|bytea/i.test(migration), 'no blob column');
  assert.match(code('notifications', 'statement-delivery.js'), /renderStatementPdf/);
});

test('42 — an attachment that cannot be built is RETRYABLE, not a silent empty email', async () => {
  /* A statement email with no statement attached would be worse than one that
     arrives a few minutes late. */
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });

  let called = false;
  const adapter = { async send() { called = true; return { ok: true, providerReference: 'x' }; } };
  await runOnce(db, adapter, {
    now: () => T0,
    attachmentResolver: async () => { throw new Error('storage unavailable'); },
    onDelivered: markStatementSentOnDelivery({ db }),
  });

  assert.equal(called, false, 'nothing may be sent without the attachment');
  assert.equal(db.outbox[0].status, 'retry_scheduled', 'and it is retried');
  assert.equal(db.statements[0].status, 'queued');
});

test('43 — an enquiry alert is unaffected by the attachment resolver', async () => {
  const db = fullDb();
  db.outbox.push({ id: 'ntf_enq', notification_type: 'enquiry_received',
    source_type: 'form_submission', source_id: 'fsub_1',
    recipient_address: 'ops@example.test', recipient_name: '',
    template_key: 'enquiry_received', template_version: 'v1',
    template_data: { formLabel: 'Contact' }, status: 'pending', attempt_count: 0,
    next_attempt_at: T0, created_at: T0 });

  let sentMessage = null;
  const adapter = { async send(m) { sentMessage = m; return { ok: true, providerReference: 'x' }; } };
  await runOnce(db, adapter, {
    now: () => T0,
    attachmentResolver: statementAttachmentResolver({ db, buildStatementFor, brand: BRAND }),
    onDelivered: markStatementSentOnDelivery({ db }),
  });
  assert.equal(sentMessage.attachments, undefined, 'an enquiry alert carries no attachment');
});

test('44 — sending the same period twice in a day is refused', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });
  await assert.rejects(
    () => sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 }),
    (err) => err instanceof StatementError && err.status === 409 && err.body.code === 'ALREADY_SENT_TODAY');
  assert.equal(db.statements.length, 1);
  assert.equal(db.outbox.length, 1, 'and no second email is queued');
});

test('45 — a customer with no recipient at all cannot be sent to', async () => {
  const db = fullDb({ contacts: [], customer: { ...CUSTOMER, email: '' } });
  await assert.rejects(
    () => sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 }),
    (err) => err.status === 422 && err.body.code === 'NO_RECIPIENT');
  assert.equal(db.statements.length, 0);
  assert.equal(db.outbox.length, 0);
});

test('46 — history carries the live delivery state from the outbox, not a copy', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });
  const history = await statementHistory(db, CUSTOMER_ID);
  assert.equal(history.length, 1);
  assert.equal(history[0].delivery.status, 'pending');
  assert.match(history[0].delivery.recipientMasked, /@example\.test$/);
  assert.ok(!history[0].delivery.recipientMasked.startsWith('ap@'), 'the outbox view masks');
});

// ===========================================================================
// 47-56 — authority, schema and scope
// ===========================================================================

test('47 — generating is payments.view; SENDING is its own capability', async () => {
  assert.deepEqual({ ...STATEMENT_CAPABILITIES },
    { view: 'payments.view', send: 'statements.send' });
  const { PERMISSION_KEYS } = await import('../src/permission-registry.js');
  assert.ok(PERMISSION_KEYS.includes('statements.send'));
  assert.ok(migration.includes("'statements.send'"));
  assert.ok(migrateJs.includes("'statements.send'"));
});

test('48 — holding payments.view does not confer statements.send', async () => {
  const db = { query: async () => ({ rows: [{ permission_key: 'payments.view' }] }) };
  assert.deepEqual(await getStatementCapabilities(db, 'u_ops'), { view: true, send: false });
});

test('49 — every route is gated, and the send route on statements.send', () => {
  assert.match(routeSrc, /r\.get\('\/:customerId\/preview',\s*canView\(\)/);
  assert.match(routeSrc, /r\.get\('\/:customerId\/pdf',\s*canView\(\)/);
  assert.match(routeSrc, /r\.post\('\/:customerId\/send',\s*canSend\(\)/);
  assert.ok(!/req\.user\.role\s*===/.test(routeSrc), 'no role fallback');
  const posts = routeSrc.match(/r\.post\('[^']+'/g) || [];
  assert.equal(posts.length, 1, 'exactly one write route');
});

test('50 — the actor comes from the session, never the body', () => {
  assert.ok(!/req\.body\??\.(actor|actorId|generatedBy)/.test(routeSrc));
  assert.match(routeSrc, /req\.user\)/);
});

test('51 — a preview creates no record', async () => {
  const db = fullDb();
  await buildStatementFor(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31', generatedAt: T0 });
  assert.equal(db.statements.length, 0, 'checking a figure must not litter the history');
  assert.equal(db.outbox.length, 0);
});

test('52 — there is NO scheduling anywhere', () => {
  /* Automatic monthly statements are out of scope, and a column anticipating
     them would be an invitation to wire one up. */
  for (const forbidden of ['cron', 'next_run_at', 'recurrence', 'schedule', 'monthly']) {
    assert.ok(!migration.toLowerCase().includes(`${forbidden} `), `migration mentions ${forbidden}`);
  }
  assert.ok(!/setInterval|cron/i.test(routeSrc), 'the router schedules nothing');
});

test('53 — a sent statement must carry evidence of where it went', () => {
  assert.match(migration, /check \(status <> 'sent' or \(sent_at is not null and recipient_address <> ''\)\)/);
  assert.match(migrateJs, /check \(status <> 'sent' or \(sent_at is not null and recipient_address <> ''\)\)/);
});

test('54 — the schema is additive and stores no document', () => {
  assert.doesNotMatch(migration, /drop table/i);
  assert.doesNotMatch(migration, /drop column/i);
  assert.doesNotMatch(migration, /delete from/i);
  assert.doesNotMatch(migration, /insert into account_permissions/i);
  assert.match(migration, /constraint account_statements_period_ordered/);
});

test('55 — marking sent is idempotent against a duplicated confirmation', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });
  const onDelivered = markStatementSentOnDelivery({ db });
  const row = db.outbox[0];
  await onDelivered(row, 'msg-1', T0);
  const firstSentAt = db.statements[0].sent_at;
  await onDelivered(row, 'msg-1', new Date('2027-01-01'));
  assert.equal(db.statements[0].sent_at, firstSentAt, 'the original timestamp stands');
});

test('56 — the statement email body carries no ledger detail', async () => {
  const db = fullDb({ contacts: [contact({ email: 'ap@example.test', responsibilities: ['accounts_payable'] })] });
  await sendStatement(db, CUSTOMER_ID, { from: '2026-08-01', to: '2026-08-31' }, ACTOR, { now: T0 });
  const data = db.outbox[0].template_data;
  /* The email says a statement is attached and what the closing balance is.
     The detail is in the PDF, which is the governed artefact. */
  assert.equal(data.periodLabel, '1 August 2026 to 31 August 2026');
  assert.equal(data.closingBalance, '1050.00');
  assert.equal('lines' in data, false);
  assert.equal('movements' in data, false);
});
