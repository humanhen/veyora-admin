/* Duplicate-submission sweep (Final Handover, Phase 7).

   ONE PROPERTY, ASSERTED ACROSS EVERY HIGH-RISK MUTATION:

       Two immediate calls must not create two financial or operational
       mutations.

   Every test here fires the SAME operation two or three times — concurrently
   where the path allows it, sequentially where it does not — and asserts that
   exactly one row, one movement or one message resulted.

   These are SERVER-side assertions deliberately. A browser guard stops the
   second request being made; only the server stops it mattering, and the
   server is the thing an attacker, a retrying proxy or a flaky network talks
   to directly. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createOrGetSession, expireStaleSessions, PaymentError,
} from '../src/payments/sessions.js';
import { processEvent } from '../src/payments/webhook.js';
import {
  issueCreditNote, issueInvoice, recordOfflinePayment, resolveException, voidPayment,
} from '../src/routes/admin-finance.js';
import { refundInvoice } from '../src/routes/admin-payments.js';
import {
  archiveContact, createContact, makePrimary, updateContact,
} from '../src/routes/admin-customer-contacts.js';
import { makeContactToken } from '../src/customer-contacts.js';
import { sendStatement } from '../src/routes/admin-statements.js';
import { enqueue, requeue } from '../src/notifications/outbox.js';
import { STRIPE_API_VERSION } from '../src/payments/stripe-config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/* …/platform/server/api → …/Veyora */
const REPO = path.dirname(path.dirname(path.dirname(ROOT)));
const SRC = path.join(ROOT, 'src');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const srcOf = (...p) => strip(fs.readFileSync(path.join(SRC, ...p), 'utf8'));
const panelOf = (name) => strip(fs.readFileSync(path.join(REPO, 'js', name), 'utf8'));

const T0 = new Date('2026-08-07T09:00:00.000Z');
const ACTOR = { id: 'u_ops', email: 'ops@example.test', business: 'Ops', role: 'admin' };
const CUSTOMER_ID = 'u_cust1';

const CONFIG = Object.freeze({
  enabled: true, mode: 'test', disabledReason: '',
  secretKey: 'sk_test_x', webhookSecret: 'whsec_x', publishableKey: '',
  successUrl: 'https://portal.example.test/ok', cancelUrl: 'https://portal.example.test/no',
  apiVersion: STRIPE_API_VERSION, sessionTtlMinutes: 720,
});

/* ---------------------------------------------------------------------------
   A database double that enforces the real unique constraints
   --------------------------------------------------------------------------- */

function makeDb(seed = {}) {
  const t = {
    users: [{ id: CUSTOMER_ID, balance: '1000.00', business: 'Example Optics',
      customer_number: '1001', email: 'sam@example.test', status: 'active', ...seed.customer }],
    orders: (seed.orders || []).map((o) => ({ ...o })),
    invoices: (seed.invoices || []).map((i) => ({ ...i })),
    payments: [], creditNotes: [], financeEvents: [], refunds: [],
    sessions: [], paymentEvents: [], contacts: (seed.contacts || []).map((c) => ({ ...c })),
    statements: [], outbox: [],
  };
  let seq = 0;
  const dup = (msg) => Object.assign(new Error(msg), { code: '23505' });

  async function query(sql, params = []) {
    // ---------- users / balance ----------
    if (/^\s*select id, balance from users where id = \$1/is.test(sql)) {
      const u = t.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u }] : [] };
    }
    if (/^\s*update users set balance/is.test(sql)) {
      const u = t.users.find((x) => x.id === params[0]);
      if (!u) return { rows: [] };
      u.balance = (Math.round((Number(u.balance) + Number(params[1])) * 100) / 100).toFixed(2);
      return { rows: [{ balance: u.balance }] };
    }
    if (/from users where id = \$1/is.test(sql)) {
      const u = t.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u }] : [] };
    }

    // ---------- orders / invoices ----------
    if (/from orders where id = \$1 or number = \$1/is.test(sql)) {
      const o = t.orders.find((x) => x.id === params[0] || x.number === params[0]);
      return { rows: o ? [{ ...o }] : [] };
    }
    if (/^\s*update orders set invoice_id/is.test(sql)) {
      const o = t.orders.find((x) => x.id === params[0]);
      if (o) o.invoice_id = params[1];
      return { rows: [] };
    }
    if (/nextval\('invoice_number_seq'\)/is.test(sql)) return { rows: [{ n: `IN${1000 + (++seq)}` }] };
    if (/^\s*insert into invoices/is.test(sql)) {
      const row = { id: `in_${++seq}`, number: params[0], order_id: params[1],
        order_number: params[2], customer_id: params[3], amount: params[4],
        settlement_currency: params[5] || 'USD', settlement_state: 'on_terms',
        amount_settled_minor: 0, amount_refunded_minor: 0, settlement_reference: '',
        settled_at: null, issued_on: '2026-08-07' };
      t.invoices.push(row);
      return { rows: [{ ...row }] };
    }
    if (/from invoices where id = \$1 or number = \$1/is.test(sql)) {
      const i = t.invoices.find((x) => x.id === params[0] || x.number === params[0]);
      return { rows: i ? [{ ...i }] : [] };
    }
    if (/from invoices where id = \$1/is.test(sql)) {
      const i = t.invoices.find((x) => x.id === params[0]);
      return { rows: i ? [{ ...i }] : [] };
    }
    if (/^\s*update invoices\s+set settlement_state = 'paid'/is.test(sql)) {
      const i = t.invoices.find((x) => x.id === params[0]);
      Object.assign(i, { settlement_state: 'paid', settled_at: params[1],
        amount_settled_minor: Number(params[2]), settlement_reference: params[3] });
      return { rows: [{ ...i }] };
    }
    if (/^\s*update invoices\s+set amount_refunded_minor = amount_refunded_minor \+ \$2/is.test(sql)) {
      const i = t.invoices.find((x) => x.id === params[0]);
      i.amount_refunded_minor = Number(i.amount_refunded_minor) + Number(params[1]);
      if (i.amount_refunded_minor >= Number(i.amount_settled_minor)) i.settlement_state = 'refunded';
      return { rows: [{ ...i }] };
    }
    if (/^\s*update invoices\s+set amount_refunded_minor = \$2/is.test(sql)) {
      const i = t.invoices.find((x) => x.id === params[0]);
      i.amount_refunded_minor = Number(params[1]);
      if (i.amount_refunded_minor >= Number(i.amount_settled_minor)) i.settlement_state = 'refunded';
      return { rows: [{ ...i }] };
    }

    // ---------- payments (UNIQUE idempotency_key, UNIQUE settlement_key) ----------
    if (/^\s*insert into payments \(customer_id, invoice_id/is.test(sql)) {
      const key = params[10];
      if (key && t.payments.some((p) => p.idempotency_key === key)) return { rows: [] };
      const row = { id: `pay_${++seq}`, customer_id: params[0], invoice_id: params[1],
        amount: params[2], currency: params[4], method: params[5], reference: params[6],
        notes: params[8], recorded_by: params[9], idempotency_key: key,
        voided_at: null, void_reason: '', stripe_payment_intent: null };
      t.payments.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^\s*insert into payments \(customer_id, amount, method/is.test(sql)) {
      const key = params[10];
      if (t.payments.some((p) => p.settlement_key === key)) return { rows: [] };
      t.payments.push({ id: `pay_${++seq}`, customer_id: params[0], amount: params[1],
        settlement_key: key, method: 'stripe' });
      return { rows: [{ id: `pay_${seq}` }] };
    }
    if (/from payments where id = \$1/is.test(sql)) {
      const p = t.payments.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
    }
    if (/^\s*update payments set voided_at/is.test(sql)) {
      const p = t.payments.find((x) => x.id === params[0] && x.voided_at == null);
      if (!p) return { rows: [] };
      Object.assign(p, { voided_at: T0, voided_by: params[1], void_reason: params[2] });
      return { rows: [{ ...p }] };
    }

    // ---------- credit notes (UNIQUE idempotency_key) ----------
    if (/^\s*insert into credit_notes/is.test(sql)) {
      const key = params[9];
      if (key && t.creditNotes.some((n) => n.idempotency_key === key)) return { rows: [] };
      const row = { id: `cn_${++seq}`, customer_id: params[0], amount: params[2],
        currency: params[4], reason: params[5], idempotency_key: key };
      t.creditNotes.push(row);
      return { rows: [{ ...row }] };
    }

    // ---------- finance events (UNIQUE idempotency_key, append-only) ----------
    if (/^\s*(update|delete)\s+(from\s+)?finance_events/is.test(sql)) {
      throw Object.assign(new Error('finance_events is append-only'), { code: 'P0001' });
    }
    if (/^\s*insert into finance_events/is.test(sql)) {
      const key = params[16];
      if (t.financeEvents.some((e) => e.idempotency_key === key)) return { rows: [] };
      const row = { id: `fev_${++seq}`, event_type: params[0], customer_id: params[1],
        amount_minor: params[5], balance_before: params[7], balance_after: params[8],
        idempotency_key: key };
      t.financeEvents.push(row);
      return { rows: [{ ...row }] };
    }

    // ---------- refunds (UNIQUE idempotency_key) ----------
    if (/^\s*insert into payment_refunds/is.test(sql)) {
      const key = params[params.length - 1];
      if (t.refunds.some((r) => r.idempotency_key === key)) return { rows: [] };
      const row = { id: `rfn_${++seq}`, invoice_id: params[0], amount_minor: Number(params[1]),
        currency: params[2], reason: params[3], authorised_by: params[4],
        idempotency_key: key, status: 'pending' };
      t.refunds.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^\s*update payment_refunds set status/is.test(sql)) {
      const r = t.refunds.find((x) => x.id === params[0]);
      if (r) r.status = /succeeded/.test(sql) ? 'succeeded' : 'failed';
      return { rows: [] };
    }

    // ---------- payment sessions (UNIQUE one-live-per-invoice, UNIQUE key) ----------
    if (/^\s*insert into payment_sessions/is.test(sql)) {
      const key = params[4];
      if (t.sessions.some((s) => s.idempotency_key === key)) return { rows: [] };
      const live = t.sessions.filter((s) => s.invoice_id === params[0]
        && ['created', 'open'].includes(s.status));
      if (live.length) throw dup('payment_sessions_one_live_idx');
      const row = { id: `ps_${++seq}`, invoice_id: params[0], customer_id: params[1],
        amount_minor: Number(params[2]), currency: params[3], idempotency_key: key,
        requested_by: params[5], expires_at: params[6], status: 'created',
        provider_session_id: '', provider_payment_intent: '', hosted_url: '',
        last_error: '', created_at: T0, completed_at: null };
      t.sessions.push(row);
      return { rows: [{ ...row }] };
    }
    if (/from payment_sessions\s+where invoice_id = \$1 and status in/is.test(sql)) {
      return { rows: t.sessions.filter((s) => s.invoice_id === params[0]
        && ['created', 'open'].includes(s.status)).map((s) => ({ ...s })) };
    }
    if (/select count\(\*\)::int as n from payment_sessions/is.test(sql)) {
      return { rows: [{ n: t.sessions.filter((s) => s.invoice_id === params[0]).length }] };
    }
    if (/from payment_sessions\s+where provider_session_id = \$1/is.test(sql)) {
      const s = t.sessions.find((x) => x.provider_session_id === params[0]);
      return { rows: s ? [{ ...s }] : [] };
    }
    if (/from payment_sessions\s+where provider_payment_intent = \$1/is.test(sql)) {
      const s = [...t.sessions].reverse().find((x) => x.provider_payment_intent === params[0]);
      return { rows: s ? [{ ...s }] : [] };
    }
    if (/from payment_sessions\s+where invoice_id = \$1 order by/is.test(sql)) {
      return { rows: t.sessions.filter((s) => s.invoice_id === params[0]).reverse().map((s) => ({ ...s })) };
    }
    if (/^\s*update payment_sessions set status = 'cancelled'/is.test(sql)) {
      const s = t.sessions.find((x) => x.id === params[0] && ['created', 'open'].includes(x.status));
      if (s) s.status = 'cancelled';
      return { rows: [] };
    }
    if (/^\s*update payment_sessions\s+set status = 'open'/is.test(sql)) {
      const s = t.sessions.find((x) => x.id === params[0] && x.status === 'created');
      if (!s) return { rows: [] };
      Object.assign(s, { status: 'open', provider_session_id: params[1], hosted_url: params[2],
        provider_payment_intent: params[3] });
      return { rows: [{ ...s }] };
    }
    if (/^\s*update payment_sessions\s+set status = 'completed'/is.test(sql)) {
      const s = t.sessions.find((x) => x.id === params[0]);
      Object.assign(s, { status: 'completed', completed_at: params[1], provider_payment_intent: params[2] });
      return { rows: [{ ...s }] };
    }
    if (/^\s*update payment_sessions set status = 'failed', last_error/is.test(sql)) {
      const s = t.sessions.find((x) => x.id === params[0] && x.status === 'created');
      if (s) { s.status = 'failed'; s.last_error = params[1]; }
      return { rows: [] };
    }

    // ---------- payment events (UNIQUE provider_event_id) ----------
    if (/^\s*insert into payment_events/is.test(sql)) {
      if (t.paymentEvents.some((e) => e.provider_event_id === params[0])) return { rows: [] };
      const row = { id: `pev_${++seq}`, provider_event_id: params[0], event_type: params[1],
        status: 'received', currency: params[3], invoice_id: null };
      t.paymentEvents.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/^\s*update payment_events\s+set status = \$2/is.test(sql)) {
      const e = t.paymentEvents.find((x) => x.id === params[0]);
      if (e) e.status = params[1];
      return { rows: [] };
    }
    if (/^\s*update payment_events set status = '(ignored|failed)'/is.test(sql)) {
      const e = t.paymentEvents.find((x) => x.id === params[0]);
      if (e) e.status = /ignored/.test(sql) ? 'ignored' : 'failed';
      return { rows: [] };
    }
    if (/^\s*update payment_events\s+set status = 'resolved'/is.test(sql)) {
      const e = t.paymentEvents.find((x) => x.id === params[0]
        && ['failed', 'received'].includes(x.status));
      if (!e) return { rows: [] };
      Object.assign(e, { status: 'resolved', resolution_note: params[2] });
      return { rows: [{ ...e }] };
    }
    if (/from payment_events where id = \$1/is.test(sql)) {
      const e = t.paymentEvents.find((x) => x.id === params[0]);
      return { rows: e ? [{ ...e }] : [] };
    }

    // ---------- contacts (UNIQUE one active primary) ----------
    if (/^\s*insert into customer_contacts/is.test(sql)) {
      const row = { id: `cc_${++seq}`, customer_id: params[0], first_name: params[1],
        last_name: params[2], job_title: params[3], responsibilities: params[4],
        mobile: params[5], office_phone: params[7], email: params[9],
        preferred_contact_method: params[11], preferred_language: params[12],
        is_primary: params[13], is_active: params[14], notes: params[15],
        portal_user_id: null, last_verified_at: null,
        created_at: T0, updated_at: T0 };
      t.contacts.push(row);
      const primaries = t.contacts.filter((c) => c.is_primary && c.is_active
        && c.customer_id === row.customer_id);
      if (primaries.length > 1) throw dup('customer_contacts_one_primary_idx');
      return { rows: [{ ...row }] };
    }
    if (/from customer_contacts\s+where id = \$1 and customer_id = \$2/is.test(sql)) {
      const c = t.contacts.find((x) => x.id === params[0] && x.customer_id === params[1]);
      return { rows: c ? [{ ...c }] : [] };
    }
    if (/set is_primary = false/is.test(sql)) {
      for (const c of t.contacts) {
        if (c.customer_id === params[0] && c.is_primary && (!params[1] || c.id !== params[1])) {
          c.is_primary = false;
        }
      }
      return { rows: [] };
    }
    if (/set is_primary = true/is.test(sql)) {
      const c = t.contacts.find((x) => x.id === params[0] && x.customer_id === params[1] && x.is_active);
      if (!c) return { rows: [] };
      c.is_primary = true; c.updated_at = new Date('2026-08-08');
      const primaries = t.contacts.filter((x) => x.is_primary && x.is_active
        && x.customer_id === c.customer_id);
      if (primaries.length > 1) throw dup('customer_contacts_one_primary_idx');
      return { rows: [{ ...c }] };
    }
    if (/^\s*update customer_contacts set is_active = false/is.test(sql)) {
      const c = t.contacts.find((x) => x.id === params[0] && x.customer_id === params[1]);
      if (!c) return { rows: [] };
      Object.assign(c, { is_active: false, is_primary: false, updated_at: new Date('2026-08-08') });
      return { rows: [{ ...c }] };
    }
    if (/^\s*update customer_contacts set\s+first_name/is.test(sql)) {
      const c = t.contacts.find((x) => x.id === params[0] && x.customer_id === params[1]);
      if (!c) return { rows: [] };
      Object.assign(c, { first_name: params[2], last_name: params[3], notes: params[15],
        is_active: params[14], updated_at: new Date('2026-08-08') });
      return { rows: [{ ...c }] };
    }
    if (/from customer_contacts where customer_id = \$1 and is_active/is.test(sql)) {
      return { rows: t.contacts.filter((c) => c.customer_id === params[0] && c.is_active)
        .map((c) => ({ ...c })) };
    }

    // ---------- statements (UNIQUE idempotency_key) ----------
    if (/^\s*insert into account_statements/is.test(sql)) {
      const key = params[11];
      if (t.statements.some((s) => s.idempotency_key === key)) return { rows: [] };
      const row = { id: `stm_${++seq}`, customer_id: params[0], period_from: params[1],
        period_to: params[2], currency: params[3], opening_minor: params[4],
        closing_minor: params[5], line_count: params[6], status: 'queued',
        recipient_address: params[9], recipient_reason: params[10],
        idempotency_key: key, generated_at: T0, sent_at: null, notification_id: null,
        last_error: '' };
      t.statements.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^\s*update account_statements set notification_id/is.test(sql)) {
      const s = t.statements.find((x) => x.id === params[0]);
      if (s) s.notification_id = params[1];
      return { rows: [] };
    }
    if (/from account_statements\s+where customer_id/is.test(sql)) {
      return { rows: [...t.statements].reverse().map((s) => ({ ...s })) };
    }
    if (/from invoices where customer_id/is.test(sql)) {
      return { rows: t.invoices.map((i) => ({ ...i })) };
    }
    if (/from payments where customer_id/is.test(sql)) {
      return { rows: t.payments.filter((p) => !p.voided_at).map((p) => ({ ...p })) };
    }
    if (/from credit_notes where customer_id/is.test(sql)) {
      return { rows: t.creditNotes.map((n) => ({ ...n })) };
    }
    if (/from payment_refunds/is.test(sql)) return { rows: [] };

    // ---------- outbox (UNIQUE idempotency_key) ----------
    if (/^\s*insert into notification_outbox/is.test(sql)) {
      const idem = params[8];
      if (t.outbox.some((r) => r.idempotency_key === idem)) return { rows: [] };
      const row = { id: `ntf_${++seq}`, notification_type: params[0], source_type: params[1],
        source_id: params[2], recipient_address: params[3], recipient_name: params[4],
        template_key: params[5], template_data: JSON.parse(params[7]),
        idempotency_key: idem, status: 'pending', attempt_count: 0, next_attempt_at: T0,
        created_at: T0, last_error: '', provider_reference: '' };
      t.outbox.push(row);
      return { rows: [{ ...row }] };
    }
    if (/set status = 'pending'/is.test(sql)) {
      const r = t.outbox.find((x) => x.id === params[0]
        && ['failed', 'retry_scheduled', 'cancelled'].includes(x.status));
      if (!r) return { rows: [] };
      Object.assign(r, { status: 'pending', attempt_count: 0, next_attempt_at: params[1] });
      return { rows: [{ ...r }] };
    }
    if (/where source_type = \$1 and source_id = \$2/is.test(sql)) {
      return { rows: t.outbox.filter((r) => r.source_type === params[0] && r.source_id === params[1])
        .map((r) => ({ ...r })) };
    }

    if (/insert into audit_log/is.test(sql)) return { rows: [] };
    return { rows: [] };
  }

  /* TRANSACTIONS ARE SERIALISED.
   *
   * This is the single most important property of this double, and getting it
   * wrong made every concurrency test here pass for the wrong reason first
   * time round.
   *
   * A naive implementation snapshots the tables, runs the callback, and
   * restores the snapshot on failure. Under `Promise.allSettled` the two
   * callbacks interleave at every `await`, so the second transaction's
   * rollback restores a snapshot taken BEFORE the first one's writes — wiping
   * them. That is not what PostgreSQL does, and a test built on it would
   * report a balance that moved zero times when the code moved it once.
   *
   * Every contended path in this file takes `for update` on the row it is
   * about, so PostgreSQL serialises them in practice. A mutex models that
   * faithfully: the second transaction begins only after the first has
   * committed or rolled back, and therefore SEES the first's writes — which is
   * exactly the condition the unique constraints need in order to fire.
   */
  let queue = Promise.resolve();

  return {
    query, tables: t,
    tx(fn) {
      const run = queue.then(async () => {
        const snap = JSON.parse(JSON.stringify(t,
          (k, v) => (v instanceof Date ? { __d: v.toISOString() } : v)));
        try {
          return await fn({ query });
        } catch (err) {
          const revive = (v) => (v && typeof v === 'object' && v.__d ? new Date(v.__d) : v);
          for (const key of Object.keys(t)) {
            t[key] = snap[key].map((row) => {
              const out = {};
              for (const [k, v] of Object.entries(row)) out[k] = revive(v);
              return out;
            });
          }
          throw err;
        }
      });
      /* The queue must advance whether the transaction committed or threw, or
         one failure would deadlock every later transaction. */
      queue = run.then(() => {}, () => {});
      return run;
    },
  };
}

const stripeDouble = () => {
  let calls = 0;
  return {
    get calls() { return calls; },
    async createCheckoutSession(params) {
      calls += 1;
      return { id: `cs_${calls}`, status: 'open', paymentStatus: 'unpaid',
        amountTotalMinor: params.line_items[0].price_data.unit_amount,
        currency: String(params.line_items[0].price_data.currency).toUpperCase(),
        paymentIntentId: '', url: `https://checkout.test/${calls}`, expiresAt: null,
        metadata: params.metadata };
    },
    async createRefund(params) {
      calls += 1;
      return { id: `re_${calls}`, status: 'succeeded', amountMinor: params.amount,
        currency: 'USD', paymentIntentId: params.payment_intent };
    },
  };
};

const settled = (results) => results.filter((r) => r.status === 'fulfilled').length;

/* ===========================================================================
   1-4 — invoicing
   =========================================================================== */

test('1 — two concurrent invoice requests produce ONE invoice', async () => {
  const db = makeDb({ orders: [{ id: 'o_1', number: 'SO1', customer_id: CUSTOMER_ID,
    total: '250.00', currency: 'USD', invoice_id: null }] });
  const results = await Promise.allSettled([
    issueInvoice(db, 'o_1', ACTOR),
    issueInvoice(db, 'o_1', ACTOR),
  ]);
  assert.ok(settled(results) >= 1);
  assert.equal(db.tables.invoices.length, 1, 'one invoice');
  assert.equal(db.tables.financeEvents.filter((e) => e.event_type === 'invoice.issued').length, 1);
  assert.equal(db.tables.users[0].balance, '1250.00', 'the balance moved once');
});

test('2 — three sequential invoice presses produce ONE invoice and ONE balance movement', async () => {
  const db = makeDb({ orders: [{ id: 'o_1', number: 'SO1', customer_id: CUSTOMER_ID,
    total: '250.00', currency: 'USD', invoice_id: null }] });
  for (let i = 0; i < 3; i += 1) await issueInvoice(db, 'o_1', ACTOR);
  assert.equal(db.tables.invoices.length, 1);
  assert.equal(db.tables.users[0].balance, '1250.00');
});

/* ===========================================================================
   3-8 — offline payments, credit notes, voids
   =========================================================================== */

const offline = (over = {}) => ({ customerId: CUSTOMER_ID, method: 'transfer',
  amount: '250.00', currency: 'USD', reference: 'BACS-99213', ...over });

test('3 — two concurrent identical payments record ONE', async () => {
  const db = makeDb();
  const results = await Promise.allSettled([
    recordOfflinePayment(db, offline(), ACTOR),
    recordOfflinePayment(db, offline(), ACTOR),
  ]);
  assert.equal(settled(results), 1, 'exactly one succeeds');
  assert.equal(db.tables.payments.length, 1);
  assert.equal(db.tables.users[0].balance, '750.00', 'the balance moved once');
});

test('4 — three sequential identical payments record ONE', async () => {
  const db = makeDb();
  let ok = 0;
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await recordOfflinePayment(db, offline(), ACTOR).then(() => { ok += 1; }, () => {});
  }
  assert.equal(ok, 1);
  assert.equal(db.tables.payments.length, 1);
  assert.equal(db.tables.users[0].balance, '750.00');
});

test('5 — a genuinely different payment is still accepted', async () => {
  const db = makeDb();
  await recordOfflinePayment(db, offline(), ACTOR);
  await recordOfflinePayment(db, offline({ reference: 'BACS-99214' }), ACTOR);
  assert.equal(db.tables.payments.length, 2);
});

test('6 — two concurrent identical credit notes issue ONE', async () => {
  const db = makeDb();
  const body = { customerId: CUSTOMER_ID, amount: '50.00', currency: 'USD',
    reason: 'goods damaged in transit' };
  const results = await Promise.allSettled([
    issueCreditNote(db, body, ACTOR),
    issueCreditNote(db, body, ACTOR),
  ]);
  assert.equal(settled(results), 1);
  assert.equal(db.tables.creditNotes.length, 1);
  assert.equal(db.tables.users[0].balance, '950.00');
});

test('7 — two concurrent voids of the same payment move the balance ONCE', async () => {
  const db = makeDb();
  const payment = await recordOfflinePayment(db, offline(), ACTOR);
  const body = { reason: 'keyed twice by mistake', confirm: true };
  const results = await Promise.allSettled([
    voidPayment(db, payment.id, body, ACTOR),
    voidPayment(db, payment.id, body, ACTOR),
  ]);
  assert.equal(settled(results), 1);
  assert.equal(db.tables.users[0].balance, '1000.00', 'back to where it started, once');
});

test('8 — a refused payment leaves the balance and every ledger untouched', async () => {
  const db = makeDb();
  await assert.rejects(() => recordOfflinePayment(db, offline({ reference: '' }), ACTOR));
  assert.equal(db.tables.payments.length, 0);
  assert.equal(db.tables.financeEvents.length, 0);
  assert.equal(db.tables.users[0].balance, '1000.00');
});

/* ===========================================================================
   9-14 — payment sessions, webhooks, refunds
   =========================================================================== */

const paidInvoice = (over = {}) => ({ id: 'in_1', number: 'IN1001', customer_id: CUSTOMER_ID,
  amount: '250.00', settlement_currency: 'USD', settlement_state: 'on_terms',
  amount_settled_minor: 0, amount_refunded_minor: 0, settlement_reference: '',
  settled_at: null, issued_on: '2026-08-01', ...over });

test('9 — three concurrent "pay" presses open ONE payment session', async () => {
  const db = makeDb({ invoices: [paidInvoice()] });
  const stripe = stripeDouble();
  const results = await Promise.allSettled([
    createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR),
    createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR),
    createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR),
  ]);
  assert.ok(settled(results) >= 1);
  const live = db.tables.sessions.filter((s) => ['created', 'open'].includes(s.status));
  assert.equal(live.length, 1, 'one live session');
  assert.ok(stripe.calls <= 1, 'and at most one provider call');
});

test('10 — a second press after the link exists reuses it', async () => {
  const db = makeDb({ invoices: [paidInvoice()] });
  const stripe = stripeDouble();
  const first = await createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR);
  const second = await createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR);
  assert.equal(second.reused, true);
  assert.equal(second.session.id, first.session.id);
  assert.equal(stripe.calls, 1);
});

test('11 — the SAME webhook delivered twice settles ONCE', async () => {
  const db = makeDb({ invoices: [paidInvoice()] });
  await createOrGetSession(db, stripeDouble(), CONFIG, 'in_1', ACTOR);
  const event = {
    id: 'evt_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', status: 'complete', payment_status: 'paid',
      amount_total: 25000, currency: 'usd', payment_intent: 'pi_1' } },
  };
  const a = await processEvent(db, event);
  const b = await processEvent(db, event);
  assert.equal(a.status, 'processed');
  assert.equal(b.status, 'duplicate');
  assert.equal(db.tables.payments.length, 1, 'the money is recorded once');
});

test('12 — a DIFFERENT event carrying the same settlement is still a no-op', async () => {
  /* The dedup index cannot help here, so the transition itself must be safe. */
  const db = makeDb({ invoices: [paidInvoice()] });
  await createOrGetSession(db, stripeDouble(), CONFIG, 'in_1', ACTOR);
  const object = { id: 'cs_1', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_1' };
  await processEvent(db, { id: 'evt_1', type: 'checkout.session.completed', data: { object } });
  const again = await processEvent(db, { id: 'evt_2', type: 'checkout.session.completed', data: { object } });
  assert.equal(again.status, 'noop');
  assert.equal(db.tables.payments.length, 1);
});

test('13 — two concurrent identical refunds send ONE', async () => {
  const db = makeDb({ invoices: [paidInvoice({ settlement_state: 'paid',
    amount_settled_minor: 25000, settled_at: T0, settlement_reference: 'pi_1' })] });
  const stripe = stripeDouble();
  const body = { confirm: true, reason: 'goods returned' };
  const results = await Promise.allSettled([
    refundInvoice(db, stripe, 'in_1', body, ACTOR),
    refundInvoice(db, stripe, 'in_1', body, ACTOR),
  ]);
  assert.equal(settled(results), 1);
  assert.equal(db.tables.refunds.length, 1);
  assert.ok(stripe.calls <= 1, 'the provider is asked once');
});

test('14 — two concurrent resolutions of one exception close it ONCE', async () => {
  const db = makeDb();
  db.tables.paymentEvents.push({ id: 'pev_1', provider_event_id: 'evt_x',
    event_type: 'checkout.session.completed', status: 'failed', currency: 'USD', invoice_id: null });
  const results = await Promise.allSettled([
    resolveException(db, 'pev_1', { note: 'customer paid by transfer instead' }, ACTOR),
    resolveException(db, 'pev_1', { note: 'customer paid by transfer instead' }, ACTOR),
  ]);
  assert.equal(settled(results), 1);
  assert.equal(db.tables.financeEvents.filter((e) => e.event_type === 'reconciliation.resolved').length, 1);
});

/* ===========================================================================
   15-19 — contacts
   =========================================================================== */

const person = (over = {}) => ({ firstName: 'Ada', lastName: 'Sterling',
  email: 'ada@example.test', ...over });

test('15 — two concurrent promotions leave exactly one active primary', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER_ID, person(), ACTOR);
  const b = await createContact(db, CUSTOMER_ID,
    person({ firstName: 'Ben', lastName: 'Marsh', email: 'ben@example.test' }), ACTOR);
  const tok = (id) => makeContactToken(db.tables.contacts.find((c) => c.id === id));
  await Promise.allSettled([
    makePrimary(db, CUSTOMER_ID, a.id, { concurrencyToken: tok(a.id) }, ACTOR),
    makePrimary(db, CUSTOMER_ID, b.id, { concurrencyToken: tok(b.id) }, ACTOR),
  ]);
  const primaries = db.tables.contacts.filter((c) => c.is_primary && c.is_active);
  assert.equal(primaries.length, 1, 'the partial unique index holds');
});

test('16 — two concurrent archives of one contact apply ONCE', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER_ID, person(), ACTOR);
  const token = makeContactToken(db.tables.contacts.find((c) => c.id === a.id));
  const results = await Promise.allSettled([
    archiveContact(db, CUSTOMER_ID, a.id, { concurrencyToken: token }, ACTOR),
    archiveContact(db, CUSTOMER_ID, a.id, { concurrencyToken: token }, ACTOR),
  ]);
  /* Both may report success — archiving is idempotent by design — but the row
     must be archived, present and singular. */
  assert.ok(settled(results) >= 1);
  assert.equal(db.tables.contacts.length, 1);
  assert.equal(db.tables.contacts[0].is_active, false);
});

test('17 — a stale token cannot apply a second, different edit', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER_ID, person(), ACTOR);
  const token = makeContactToken(db.tables.contacts.find((c) => c.id === a.id));
  await updateContact(db, CUSTOMER_ID, a.id, { notes: 'first', concurrencyToken: token }, ACTOR);
  await assert.rejects(
    () => updateContact(db, CUSTOMER_ID, a.id, { notes: 'second', concurrencyToken: token }, ACTOR),
    (err) => err.status === 409);
  assert.equal(db.tables.contacts[0].notes, 'first');
});

/* ===========================================================================
   18-21 — statements and enquiry retry
   =========================================================================== */

test('18 — two concurrent sends of the same statement queue ONE email', async () => {
  const db = makeDb({
    invoices: [paidInvoice()],
    contacts: [{ id: 'cc_1', customer_id: CUSTOMER_ID, first_name: 'Ada', last_name: 'Sterling',
      email: 'ap@example.test', responsibilities: ['accounts_payable'],
      is_primary: false, is_active: true }],
  });
  const body = { from: '2026-08-01', to: '2026-08-31', currency: 'USD' };
  const results = await Promise.allSettled([
    sendStatement(db, CUSTOMER_ID, body, ACTOR, { now: T0 }),
    sendStatement(db, CUSTOMER_ID, body, ACTOR, { now: T0 }),
  ]);
  assert.equal(settled(results), 1);
  assert.equal(db.tables.statements.length, 1);
  assert.equal(db.tables.outbox.length, 1, 'and one email');
});

test('19 — two concurrent enqueues of the same alert queue ONE', async () => {
  const db = makeDb();
  const spec = {
    notificationType: 'enquiry_received', sourceType: 'form_submission', sourceId: 'fsub_1',
    recipientAddress: 'ops@example.test', templateKey: 'enquiry_received', templateData: {},
  };
  await Promise.allSettled([enqueue(db, spec), enqueue(db, spec)]);
  assert.equal(db.tables.outbox.length, 1);
});

test('20 — two concurrent retries of one notification requeue it ONCE', async () => {
  const db = makeDb();
  await enqueue(db, {
    notificationType: 'enquiry_received', sourceType: 'form_submission', sourceId: 'fsub_1',
    recipientAddress: 'ops@example.test', templateKey: 'enquiry_received', templateData: {},
  });
  db.tables.outbox[0].status = 'failed';
  const results = await Promise.all([
    requeue(db, db.tables.outbox[0].id, { now: T0 }),
    requeue(db, db.tables.outbox[0].id, { now: T0 }),
  ]);
  /* The status precondition in the WHERE clause is what makes the second a
     no-op rather than a second reset of the attempt count. */
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(db.tables.outbox[0].attempt_count, 0);
});

/* ===========================================================================
   21-30 — the guards, asserted structurally
   =========================================================================== */

test('21 — every high-risk server path carries an explicit guard', () => {
  /* One table, so a new financial route without a guard is visible rather
     than merely absent. */
  const expectations = [
    ['payment sessions', srcOf('payments', 'sessions.js'), /on conflict \(idempotency_key\) do nothing/],
    ['webhook dedup', srcOf('payments', 'webhook.js'), /on conflict \(provider_event_id\) do nothing/],
    ['offline payments', srcOf('routes', 'admin-finance.js'), /on conflict \(idempotency_key\)[\s\S]*?do nothing/],
    ['finance events', srcOf('routes', 'admin-finance.js'), /insert into finance_events[\s\S]*?on conflict \(idempotency_key\) do nothing/],
    ['refunds', srcOf('routes', 'admin-payments.js'), /on conflict \(idempotency_key\) do nothing/],
    ['statements', srcOf('routes', 'admin-statements.js'), /on conflict \(idempotency_key\) do nothing/],
    ['outbox', srcOf('notifications', 'outbox.js'), /on conflict \(idempotency_key\) do nothing/],
    ['inventory', srcOf('routes', 'admin-inventory.js'), /for update/],
  ];
  for (const [name, source, pattern] of expectations) {
    assert.match(source, pattern, `${name} has no server-side duplicate guard`);
  }
});

test('22 — every financial mutation runs inside a transaction', () => {
  for (const [name, source] of [
    ['finance', srcOf('routes', 'admin-finance.js')],
    ['payments', srcOf('routes', 'admin-payments.js')],
    ['sessions', srcOf('payments', 'sessions.js')],
    ['statements', srcOf('routes', 'admin-statements.js')],
    ['webhook', srcOf('payments', 'webhook.js')],
  ]) {
    assert.match(source, /db\.tx\(|\.tx\(async/, `${name} has an untransacted mutation path`);
  }
});

test('23 — the shared in-flight guards exist and check state INSIDE the handler', () => {
  /* `button.disabled = true` is bypassed by a direct handler call, by Enter on
     a focused control, and by a re-render producing a fresh button. */
  const util = strip(fs.readFileSync(path.join(REPO, 'js', 'util.js'), 'utf8'));
  assert.match(util, /function guarded\(action\)/);
  assert.match(util, /function keyedGuard\(\)/);
  assert.match(util, /function bindAction\(button, action/);
  /* Each checks a flag before doing anything. */
  assert.match(util, /if\(inFlight\)return undefined;\s*inFlight=true;/);
  assert.match(util, /if\(active\.has\(k\)\)return undefined;/);
});

test('24 — every screen that mutates holds explicit in-flight state', () => {
  /* Each of these declares a flag (or an id, where rows act independently) and
     READS it in a guard before anything is sent. `disabled` remains as the
     affordance; it is not the control. */
  const screens = [
    ['finance', 'pages_finance.js', /\bbusy\b/],
    ['store contacts', 'pages_store_contacts.js', /\bbusy\b/],
    ['enquiries', 'pages_enquiries.js', /\bretrying\b/],
    ['catalog / stock', 'pages_catalog.js', /_busy|\bapplying\b/],
    ['orders', 'pages_sales.js', /\brunBusy\b/],
    ['purchase orders', 'pages_ops.js', /\breceiving\b/],
    ['permissions', 'pages_permissions.js', /\bbusy\b/],
    ['public content', 'pages_public_content.js', /\bdecisionBusy\b/],
  ];
  for (const [name, file, flag] of screens) {
    const source = panelOf(file);
    assert.match(source, flag, `${name} declares no in-flight state`);
    /* And the flag appears inside an `if (…) return` — the shape that makes it
       a control rather than a decoration. Matched on the collapsed source
       against the flag NAME, because the guard expression legitimately varies
       (`if(busy)return`, `if(busy||!canManage())return`,
       `if(!detail||retrying||…)return`) and a regex trying to model all three
       is more likely to be wrong than the code is. */
    const name0 = flag.source.replace(/[\\^$.*+?()[\]{}|]/g, '').replace(/b/g, '');
    const collapsed = source.replace(/\s+/g, ' ');
    const guards = collapsed.match(/if\s*\([^;{]*\)\s*return/g) || [];
    assert.ok(guards.some((g) => flag.test(g)),
      `${name} declares an in-flight flag but never guards on it`);
  }
});

test('24b — the two paths that had NO guard at all now have one', () => {
  /* Both were found by the Phase 7 audit. The inventory CSV import doubled
     every `adjust` delta on a second click; the purchase-order receipt escaped
     the same fault only because its handler happened to be synchronous. */
  const catalog = panelOf('pages_catalog.js');
  const apply = catalog.slice(catalog.indexOf("#ic-apply').onclick"));
  assert.match(apply.slice(0, 200), /if\(applying\)return;/,
    'the inventory CSV apply must refuse a second click');
  assert.match(apply, /rows=null;/,
    'and clear the parsed file so it cannot be re-applied by any route');

  const ops = panelOf('pages_ops.js');
  const receive = ops.slice(ops.indexOf('let receiving=false;'));
  assert.match(receive.slice(0, 300), /if\(receiving\)return;/,
    'the purchase-order receipt must refuse a second click');
});

test('25 — no financial screen sends without checking in-flight state first', () => {
  /* The specific shape that would be wrong: setting `disabled` and then
     sending, with no flag test. */
  const finance = panelOf('pages_finance.js');
  const handler = finance.slice(finance.indexOf('function financeModal'));
  const guardAt = handler.indexOf('if(busy)return;');
  const sendAt = handler.indexOf('await submit(ov)');
  assert.ok(guardAt > -1 && sendAt > guardAt, 'the guard must precede the send');
});

test('26 — a refused mutation never half-applies', async () => {
  /* Transaction rollback, asserted through the double's real snapshot
     semantics rather than assumed. */
  const db = makeDb();
  await recordOfflinePayment(db, offline(), ACTOR);
  const balance = db.tables.users[0].balance;
  const events = db.tables.financeEvents.length;
  await assert.rejects(() => recordOfflinePayment(db, offline(), ACTOR));
  assert.equal(db.tables.users[0].balance, balance);
  assert.equal(db.tables.financeEvents.length, events);
});

test('27 — an expired session frees the invoice so it can be paid again', async () => {
  /* The other half of a one-live-session rule: without expiry, an abandoned
     link would make an invoice permanently unpayable. */
  const db = makeDb({ invoices: [paidInvoice()] });
  await createOrGetSession(db, stripeDouble(), CONFIG, 'in_1', ACTOR);
  db.tables.sessions[0].expires_at = new Date(T0.getTime() - 1000);
  /* The double has no bulk-expire branch, so expire directly and confirm the
     invoice becomes payable. */
  db.tables.sessions[0].status = 'expired';
  const again = await createOrGetSession(db, stripeDouble(), CONFIG, 'in_1', ACTOR);
  assert.equal(again.reused, false);
  assert.equal(db.tables.sessions.filter((s) => ['created', 'open'].includes(s.status)).length, 1);
});

/* ===========================================================================
   28-36 — the two paths the audit found unguarded
   =========================================================================== */

test('28 — an identical public enquiry inside the window is stored ONCE', async () => {
  /* Before this, a refresh of the POST result, a synthetic requestSubmit(), a
     second tab, or scripting simply being off each produced a second stored
     enquiry AND a second alert to every recipient. */
  const { storeSubmission } = await import('../src/routes/public-forms.js');
  const db = makeFormsDb();
  const submission = { formType: 'contact', payload: { name: 'Sam', email: 'sam@example.test',
    message: 'Do you ship to Ireland?' }, sourceUrl: '/contact', region: 'IE',
    businessType: '', consentGiven: true };

  const first = await storeSubmission(db, submission, { recipients: ['ops@example.test'], now: () => T0 });
  const second = await storeSubmission(db, submission, { recipients: ['ops@example.test'], now: () => T0 });

  assert.ok(first, 'the first is stored');
  assert.equal(second, null, 'the second is refused');
  assert.equal(db.tables.submissions.length, 1);
  assert.equal(db.tables.outbox.length, 1, 'and the staff alert is not duplicated');
});

test('29 — the same enquiry AFTER the window is a new enquiry', async () => {
  /* Two genuine enquiries can be identical — somebody asks the same question a
     week later. A permanent content constraint would lose the second, and a
     lost enquiry is invisible where a duplicated one is merely untidy. */
  const { storeSubmission, DEDUPE_WINDOW_MS } = await import('../src/routes/public-forms.js');
  const db = makeFormsDb();
  const submission = { formType: 'contact', payload: { name: 'Sam', email: 'sam@example.test',
    message: 'Do you ship to Ireland?' }, sourceUrl: '/contact', region: 'IE',
    businessType: '', consentGiven: true };

  await storeSubmission(db, submission, { recipients: [], now: () => T0 });
  const later = new Date(T0.getTime() + DEDUPE_WINDOW_MS * 2);
  const second = await storeSubmission(db, submission, { recipients: [], now: () => later });

  assert.ok(second, 'a later identical enquiry is accepted');
  assert.equal(db.tables.submissions.length, 2);
});

test('30 — a DIFFERENT enquiry in the same window is always accepted', async () => {
  const { storeSubmission } = await import('../src/routes/public-forms.js');
  const db = makeFormsDb();
  const base = { formType: 'contact', sourceUrl: '/contact', region: 'IE',
    businessType: '', consentGiven: true };
  await storeSubmission(db, { ...base, payload: { name: 'Sam', message: 'A' } },
    { recipients: [], now: () => T0 });
  await storeSubmission(db, { ...base, payload: { name: 'Sam', message: 'B' } },
    { recipients: [], now: () => T0 });
  assert.equal(db.tables.submissions.length, 2);
});

test('31 — the fingerprint is order-independent and carries no legible content', async () => {
  const { submissionFingerprint } = await import('../src/routes/public-forms.js');
  const a = submissionFingerprint({ formType: 'contact',
    payload: { name: 'Sam', message: 'hello' }, at: T0 });
  const b = submissionFingerprint({ formType: 'contact',
    payload: { message: 'hello', name: 'Sam' }, at: T0 });
  assert.equal(a, b, 'key order must not change the fingerprint');
  /* It goes in an indexed column a database administrator reads. A submitter's
     message must not be legible there. */
  assert.ok(!a.includes('Sam'));
  assert.ok(!a.includes('hello'));
  assert.match(a, /^[0-9a-f]{48}$/);
});

test('32 — a duplicated enquiry still returns ok to the submitter', async () => {
  /* Telling them it failed would make them send a third. */
  const { handleSubmission } = await import('../src/routes/public-forms.js');
  const db = makeFormsDb();
  const body = { name: 'Sam Example', email: 'sam@example.test',
    message: 'Do you ship to Ireland?', consent: 'true' };
  const first = await handleSubmission(db, 'contact', { body, sourceUrl: '/contact' });
  const second = await handleSubmission(db, 'contact', { body, sourceUrl: '/contact' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { ok: true });
});

test('33 — a duplicated inventory adjustment is refused, and stock does NOT move twice', async () => {
  const { adjustStock } = await import('../src/routes/admin-inventory.js');
  const db = makeStockDb();
  const input = { sku: '158.1', warehouseId: 'wh_1', delta: 10, reason: 'count',
    note: '', idempotencyKey: 'adj_158.1_wh_1_10_1' };

  const first = await adjustStock(db, input, ACTOR);
  assert.equal(first.qty, 60);

  await assert.rejects(() => adjustStock(db, input, ACTOR),
    (err) => err.status === 409 && err.body.code === 'ALREADY_APPLIED');

  assert.equal(db.tables.stock[0].qty, 60, 'the quantity moved once');
  assert.equal(db.tables.movements.length, 1, 'and the ledger has one row');
});

test('34 — a genuine second adjustment with its own key still applies', async () => {
  /* Two +10s legitimately mean +20. The key identifies the PRESS, not the
     content, precisely so this stays possible. */
  const { adjustStock } = await import('../src/routes/admin-inventory.js');
  const db = makeStockDb();
  const base = { sku: '158.1', warehouseId: 'wh_1', delta: 10, reason: 'count', note: '' };
  await adjustStock(db, { ...base, idempotencyKey: 'adj_aaaaaaaa' }, ACTOR);
  await adjustStock(db, { ...base, idempotencyKey: 'adj_bbbbbbbb' }, ACTOR);
  assert.equal(db.tables.stock[0].qty, 70);
  assert.equal(db.tables.movements.length, 2);
});

test('35 — an adjustment with NO key keeps working exactly as before', async () => {
  /* Every existing caller — the ordering path, the sync path — passes none,
     and must not start colliding with itself. */
  const { adjustStock } = await import('../src/routes/admin-inventory.js');
  const db = makeStockDb();
  const base = { sku: '158.1', warehouseId: 'wh_1', delta: 5, reason: 'count', note: '' };
  await adjustStock(db, base, ACTOR);
  await adjustStock(db, base, ACTOR);
  assert.equal(db.tables.stock[0].qty, 60, 'two unkeyed adjustments both apply');
  assert.equal(db.tables.movements.length, 2);
});

test('36 — the stock ledger records the variation and warehouse it is about', async () => {
  /* This was NULL on every adjustment and transfer: the route passed
     snake_case keys and recordMovement reads camelCase. A movement that cannot
     be attributed is exactly what you would need in order to DETECT a
     duplicated adjustment after the fact. */
  const { adjustStock } = await import('../src/routes/admin-inventory.js');
  const db = makeStockDb();
  await adjustStock(db, { sku: '158.1', warehouseId: 'wh_1', delta: 3,
    reason: 'count', note: 'counted' }, ACTOR);
  const movement = db.tables.movements[0];
  assert.equal(movement.variation_id, 'v_1');
  assert.equal(movement.warehouse_id, 'wh_1');
  assert.equal(movement.ref_type, 'adjustment');
  assert.equal(movement.sku, '158.1');
  assert.equal(movement.balance_after, 53);
});

/* --------------------------------------------------------------------------
   Doubles for the two paths above
   -------------------------------------------------------------------------- */

function makeFormsDb() {
  const t = { submissions: [], outbox: [] };
  let seq = 0;
  async function query(sql, params = []) {
    if (/^\s*insert into form_submissions/is.test(sql)) {
      const fingerprint = params[7];
      /* The partial unique index. */
      if (fingerprint && t.submissions.some((s) => s.dedupe_fingerprint === fingerprint)) {
        return { rows: [] };
      }
      const row = { id: `fsub_${++seq}`, form_type: params[0], payload: JSON.parse(params[1]),
        dedupe_fingerprint: fingerprint };
      t.submissions.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/^\s*insert into notification_outbox/is.test(sql)) {
      const idem = params[8];
      if (t.outbox.some((r) => r.idempotency_key === idem)) return { rows: [] };
      const row = { id: `ntf_${++seq}`, source_id: params[2], idempotency_key: idem };
      t.outbox.push(row);
      return { rows: [{ ...row }] };
    }
    return { rows: [] };
  }
  return { query, tables: t, async tx(fn) { return fn({ query }); } };
}

function makeStockDb() {
  const t = {
    variations: [{ id: 'v_1', sku: '158.1', product_id: 'p_1' }],
    warehouses: [{ id: 'wh_1', code: 'main', name: 'Main' }],
    stock: [{ variation_id: 'v_1', warehouse_id: 'wh_1', qty: 50 }],
    movements: [],
  };
  let seq = 0;
  async function query(sql, params = []) {
    if (/from variations/is.test(sql)) {
      const v = t.variations.find((x) => x.sku === params[0]);
      return { rows: v ? [{ ...v }] : [] };
    }
    if (/from warehouses/is.test(sql)) {
      const w = t.warehouses.find((x) => x.id === params[0]);
      return { rows: w ? [{ ...w }] : [] };
    }
    if (/select qty from stock/is.test(sql)) {
      const s = t.stock.find((x) => x.variation_id === params[0] && x.warehouse_id === params[1]);
      return { rows: s ? [{ qty: s.qty }] : [] };
    }
    if (/^\s*insert into stock/is.test(sql)) {
      let s = t.stock.find((x) => x.variation_id === params[0] && x.warehouse_id === params[1]);
      if (!s) { s = { variation_id: params[0], warehouse_id: params[1], qty: 0 }; t.stock.push(s); }
      s.qty = Number(params[2]);
      return { rows: [] };
    }
    if (/^\s*insert into inventory_movements/is.test(sql)) {
      const key = params[12];
      /* The partial unique index. */
      if (key && t.movements.some((m) => m.idempotency_key === key)) return { rows: [] };
      const row = { id: `mv_${++seq}`, variation_id: params[0], sku: params[1],
        warehouse_id: params[2], qty_delta: params[3], balance_after: params[4],
        reason: params[5], ref_type: params[6], ref_id: params[7], idempotency_key: key };
      t.movements.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/insert into audit_log/is.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  return {
    query, tables: t,
    async tx(fn) {
      const snap = JSON.parse(JSON.stringify(t));
      try { return await fn({ query }); }
      catch (e) { for (const k of Object.keys(t)) t[k] = snap[k]; throw e; }
    },
  };
}
