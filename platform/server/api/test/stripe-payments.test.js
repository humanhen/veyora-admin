/* Stripe invoice payment foundation (Final Handover, Phase 3).

   Real handlers against a controlled database double and an INJECTED Stripe
   client. NOTHING HERE CONTACTS STRIPE: there is no key, no network call and
   no SDK instance anywhere in this file, and a test asserts that the modules
   under test import none.

   No real money, no real customer and no real key: every amount is invented,
   every id is a fixture, and every address is example.test. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  StripeConfigError, STRIPE_API_VERSION, publicView, resolveStripeConfig,
} from '../src/payments/stripe-config.js';
import {
  PAYABLE_STATES, PAYMENT_CURRENCIES, SETTLEMENT_STATES,
  assessPayability, buildCheckoutParams, fromMinorUnits, isSessionReusable,
  serializeInvoicePayment, serializeSession, sessionIdempotencyKey, toMinorUnits,
} from '../src/payments/invoice-payments.js';
import {
  HANDLED_EVENTS, WebhookError, isHandledEvent, processEvent,
  reconciliationExceptions, summariseEvent, verifyEvent,
} from '../src/payments/webhook.js';
import {
  PaymentError, createOrGetSession, expireStaleSessions, getInvoicePaymentState,
} from '../src/payments/sessions.js';
import {
  createDisabledStripeClient, normaliseRefund, normaliseSession,
} from '../src/payments/stripe-client.js';
import { getPaymentCapabilities, PAYMENT_CAPABILITIES, refundInvoice } from '../src/routes/admin-payments.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const MIGRATIONS = path.join(path.dirname(ROOT), 'db', 'migrations');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
/* Comments are stripped before any source assertion — an assertion satisfied
   by a comment saying the right thing is worse than no assertion. */
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const migration = fs.readFileSync(path.join(MIGRATIONS, '0013_stripe_payments.sql'), 'utf8')
  .replace(/--[^\n]*/g, ' ');
const migrateJs = read('migrate.js');
const webhookSrc = code('payments', 'webhook.js');
const sessionSrc = code('payments', 'sessions.js');
const adminSrc = code('routes', 'admin-payments.js');
const routesSrc = code('routes', 'payments.js');
const indexSrc = code('index.js');

const T0 = new Date('2026-08-07T09:00:00.000Z');
const ACTOR = { id: 'u_ops', email: 'ops@example.test', role: 'admin' };
const CUSTOMER_ID = 'u_cust1';

const CONFIG = Object.freeze({
  enabled: true, mode: 'test', disabledReason: '',
  secretKey: 'sk_test_x', webhookSecret: 'whsec_x', publishableKey: '',
  successUrl: 'https://portal.example.test/ok', cancelUrl: 'https://portal.example.test/no',
  apiVersion: STRIPE_API_VERSION, sessionTtlMinutes: 720,
});

/* ---------------------------------------------------------------------------
   An in-memory database with real transaction and unique-index semantics
   --------------------------------------------------------------------------- */

const invoiceRow = (over = {}) => ({
  id: 'in_1', number: 'IN1001', order_id: 'o_1', order_number: 'SO1', customer_id: CUSTOMER_ID,
  amount: '250.00', status: 'paid', issued_on: '2026-08-01',
  settlement_state: 'on_terms', settlement_currency: 'USD',
  amount_settled_minor: 0, amount_refunded_minor: 0,
  settled_at: null, settlement_reference: '', ...over,
});

function makeDb({ invoices = [invoiceRow()], sessions = [], events = [] } = {}) {
  let invoiceTable = invoices.map((i) => ({ ...i }));
  let sessionTable = sessions.map((s) => ({ ...s }));
  let eventTable = events.map((e) => ({ ...e }));
  let paymentTable = [];
  let refundTable = [];
  let balances = { [CUSTOMER_ID]: '250.00' };
  let seq = 0;

  /* The partial unique indexes, enforced — a handler that forgot to supersede
     must fail here rather than pass on a double that was too kind. */
  function assertIndexes() {
    const live = sessionTable.filter((s) => ['created', 'open'].includes(s.status));
    const byInvoice = new Set();
    for (const s of live) {
      if (byInvoice.has(s.invoice_id)) {
        throw Object.assign(new Error('violates payment_sessions_one_live_idx'), { code: '23505' });
      }
      byInvoice.add(s.invoice_id);
    }
    const keys = new Set();
    for (const s of sessionTable) {
      if (keys.has(s.idempotency_key)) {
        throw Object.assign(new Error('duplicate idempotency_key'), { code: '23505' });
      }
      keys.add(s.idempotency_key);
    }
  }

  async function query(sql, params = []) {
    // ---- invoices ----
    if (/^\s*select .*from invoices where id = \$1 or number = \$1/is.test(sql)) {
      const i = invoiceTable.find((x) => x.id === params[0] || x.number === params[0]);
      return { rows: i ? [{ ...i }] : [] };
    }
    if (/^\s*select .*from invoices where id = \$1/is.test(sql)) {
      const i = invoiceTable.find((x) => x.id === params[0]);
      return { rows: i ? [{ ...i }] : [] };
    }
    if (/^\s*update invoices\s+set settlement_state = 'paid'/is.test(sql)) {
      const i = invoiceTable.find((x) => x.id === params[0]);
      Object.assign(i, { settlement_state: 'paid', settled_at: params[1],
        amount_settled_minor: Number(params[2]), settlement_reference: params[3] });
      return { rows: [{ ...i }] };
    }
    if (/^\s*update invoices\s+set amount_refunded_minor = \$2/is.test(sql)) {
      const i = invoiceTable.find((x) => x.id === params[0]);
      i.amount_refunded_minor = Number(params[1]);
      if (i.amount_refunded_minor >= Number(i.amount_settled_minor)) i.settlement_state = 'refunded';
      return { rows: [{ ...i }] };
    }
    if (/^\s*update invoices\s+set amount_refunded_minor = amount_refunded_minor \+ \$2/is.test(sql)) {
      const i = invoiceTable.find((x) => x.id === params[0]);
      i.amount_refunded_minor = Number(i.amount_refunded_minor) + Number(params[1]);
      if (i.amount_refunded_minor >= Number(i.amount_settled_minor)) i.settlement_state = 'refunded';
      return { rows: [{ ...i }] };
    }

    // ---- payment sessions ----
    if (/^\s*insert into payment_sessions/is.test(sql)) {
      const [invoiceId, customerId, amountMinor, currency, key, requestedBy, expiresAt] = params;
      if (sessionTable.some((s) => s.idempotency_key === key)) return { rows: [] }; // on conflict do nothing
      const row = {
        id: `ps_${++seq}`, invoice_id: invoiceId, customer_id: customerId, provider: 'stripe',
        status: 'created', amount_minor: Number(amountMinor), currency,
        provider_session_id: '', provider_payment_intent: '', hosted_url: '',
        idempotency_key: key, requested_by: requestedBy, expires_at: expiresAt,
        completed_at: null, last_error: '', created_at: T0, updated_at: T0,
      };
      sessionTable.push(row);
      assertIndexes();
      return { rows: [{ ...row }] };
    }
    if (/from payment_sessions\s+where invoice_id = \$1 and status in \('created', 'open'\)/is.test(sql)) {
      const rows = sessionTable.filter((s) => s.invoice_id === params[0] && ['created', 'open'].includes(s.status));
      return { rows: rows.map((s) => ({ ...s })) };
    }
    if (/from payment_sessions\s+where invoice_id = \$1 order by created_at desc/is.test(sql)) {
      const rows = [...sessionTable].filter((s) => s.invoice_id === params[0]).reverse();
      return { rows: rows.map((s) => ({ ...s })) };
    }
    if (/select count\(\*\)::int as n from payment_sessions/is.test(sql)) {
      return { rows: [{ n: sessionTable.filter((s) => s.invoice_id === params[0]).length }] };
    }
    if (/from payment_sessions\s+where provider_session_id = \$1/is.test(sql)) {
      const s = sessionTable.find((x) => x.provider_session_id === params[0]);
      return { rows: s ? [{ ...s }] : [] };
    }
    if (/from payment_sessions\s+where provider_payment_intent = \$1/is.test(sql)) {
      const s = [...sessionTable].reverse().find((x) => x.provider_payment_intent === params[0]);
      return { rows: s ? [{ ...s }] : [] };
    }
    if (/^\s*update payment_sessions set status = 'cancelled'/is.test(sql)) {
      const s = sessionTable.find((x) => x.id === params[0] && ['created', 'open'].includes(x.status));
      if (s) Object.assign(s, { status: 'cancelled', last_error: params[1] });
      return { rows: [] };
    }
    if (/^\s*update payment_sessions\s+set status = 'open'/is.test(sql)) {
      const s = sessionTable.find((x) => x.id === params[0] && x.status === 'created');
      if (!s) return { rows: [] };
      Object.assign(s, { status: 'open', provider_session_id: params[1], hosted_url: params[2],
        provider_payment_intent: params[3], last_error: '' });
      assertIndexes();
      return { rows: [{ ...s }] };
    }
    if (/^\s*update payment_sessions\s+set status = 'completed'/is.test(sql)) {
      const s = sessionTable.find((x) => x.id === params[0]);
      Object.assign(s, { status: 'completed', completed_at: params[1], provider_payment_intent: params[2], last_error: '' });
      return { rows: [{ ...s }] };
    }
    if (/^\s*update payment_sessions set status = 'expired',[\s\S]*?where id = \$1 and status in/is.test(sql)) {
      const s = sessionTable.find((x) => x.id === params[0] && ['created', 'open'].includes(x.status));
      if (!s) return { rows: [] };
      s.status = 'expired'; s.last_error = 'the payment window closed';
      return { rows: [{ id: s.id }] };
    }
    if (/^\s*update payment_sessions set status = 'failed',[\s\S]*?where id = \$1 and status in/is.test(sql)) {
      const s = sessionTable.find((x) => x.id === params[0] && ['created', 'open'].includes(x.status));
      if (!s) return { rows: [] };
      s.status = 'failed'; s.last_error = 'the payment was not completed';
      return { rows: [{ id: s.id }] };
    }
    if (/^\s*update payment_sessions set status = 'failed', last_error = \$2/is.test(sql)) {
      const s = sessionTable.find((x) => x.id === params[0] && x.status === 'created');
      if (s) { s.status = 'failed'; s.last_error = params[1]; }
      return { rows: [] };
    }
    if (/^\s*update payment_sessions\s+set status = 'expired'/is.test(sql)) {
      const due = sessionTable.filter((s) => ['created', 'open'].includes(s.status)
        && s.expires_at && new Date(s.expires_at) <= params[0]).slice(0, params[1]);
      for (const s of due) { s.status = 'expired'; s.last_error = 'the payment window closed'; }
      return { rows: due.map((s) => ({ id: s.id, invoice_id: s.invoice_id })) };
    }

    // ---- payment events ----
    if (/^\s*insert into payment_events/is.test(sql)) {
      const [eventId, type, amountMinor, currency, summary] = params;
      if (eventTable.some((e) => e.provider_event_id === eventId)) return { rows: [] };
      const row = { id: `pev_${++seq}`, provider_event_id: eventId, event_type: type,
        status: 'received', invoice_id: null, payment_session_id: null,
        amount_minor: amountMinor, currency, summary: JSON.parse(summary),
        last_error: '', received_at: T0, processed_at: null };
      eventTable.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/^\s*update payment_events\s+set status = \$2/is.test(sql)) {
      const e = eventTable.find((x) => x.id === params[0]);
      Object.assign(e, { status: params[1], processed_at: params[2], invoice_id: params[3],
        payment_session_id: params[4], last_error: params[5] });
      return { rows: [] };
    }
    if (/^\s*update payment_events set status = 'ignored'/is.test(sql)) {
      const e = eventTable.find((x) => x.id === params[0]);
      Object.assign(e, { status: 'ignored', processed_at: params[1] });
      return { rows: [] };
    }
    if (/^\s*update payment_events set status = 'failed'/is.test(sql)) {
      const e = eventTable.find((x) => x.id === params[0]);
      Object.assign(e, { status: 'failed', processed_at: params[1], last_error: params[2] });
      return { rows: [] };
    }
    if (/from payment_events\s+where status in/is.test(sql)) {
      return { rows: eventTable.filter((e) => ['failed', 'received'].includes(e.status)).map((e) => ({ ...e })) };
    }

    // ---- payments and refunds ----
    if (/^\s*insert into payments/is.test(sql)) {
      const key = params[10];
      if (paymentTable.some((p) => p.settlement_key === key)) return { rows: [] };
      const row = { id: `pay_${++seq}`, customer_id: params[0], amount: params[1],
        reference: params[2], invoice_id: params[5], currency: params[6],
        amount_minor: params[7], settlement_key: key };
      paymentTable.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/^\s*update users set balance/is.test(sql)) {
      balances[params[0]] = String(Number(balances[params[0]] || 0) - Number(params[1]));
      return { rows: [] };
    }
    if (/^\s*insert into payment_refunds/is.test(sql)) {
      const key = params[params.length - 1];
      if (refundTable.some((x) => x.idempotency_key === key)) return { rows: [] };
      const row = params.length === 6
        ? { id: `rfn_${++seq}`, invoice_id: params[0], amount_minor: Number(params[1]),
            currency: params[2], reason: params[3], authorised_by: params[4],
            idempotency_key: key, status: 'pending', provider_refund_id: '', last_error: '' }
        : { id: `rfn_${++seq}`, invoice_id: params[0], provider_refund_id: params[1],
            amount_minor: Number(params[2]), currency: params[3], reason: params[4],
            idempotency_key: key, status: 'succeeded', last_error: '' };
      refundTable.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^\s*update payment_refunds set status = 'succeeded'/is.test(sql)) {
      const r = refundTable.find((x) => x.id === params[0]);
      Object.assign(r, { status: 'succeeded', provider_refund_id: params[1], last_error: '' });
      return { rows: [] };
    }
    if (/^\s*update payment_refunds set status = 'failed'/is.test(sql)) {
      const r = refundTable.find((x) => x.id === params[0]);
      if (r) Object.assign(r, { status: 'failed', last_error: params[1] });
      return { rows: [] };
    }
    return { rows: [] };
  }

  return {
    query,
    get invoices() { return invoiceTable; },
    get sessions() { return sessionTable; },
    get events() { return eventTable; },
    get payments() { return paymentTable; },
    get refunds() { return refundTable; },
    get balances() { return balances; },
    async tx(fn) {
      const snap = {
        i: invoiceTable.map((x) => ({ ...x })), s: sessionTable.map((x) => ({ ...x })),
        e: eventTable.map((x) => ({ ...x })), p: paymentTable.map((x) => ({ ...x })),
        r: refundTable.map((x) => ({ ...x })), b: { ...balances },
      };
      try {
        return await fn({ query });
      } catch (err) {
        invoiceTable = snap.i; sessionTable = snap.s; eventTable = snap.e;
        paymentTable = snap.p; refundTable = snap.r; balances = snap.b;
        throw err;
      }
    },
  };
}

/** A controllable Stripe client. No network, no key, no SDK. */
function makeStripe({ sessionOver = {}, fail = null, refundOver = {} } = {}) {
  const calls = [];
  return {
    calls,
    mode: 'test',
    async createCheckoutSession(params, opts) {
      calls.push({ method: 'createCheckoutSession', params, opts });
      if (fail) throw fail;
      return {
        id: 'cs_test_1', status: 'open', paymentStatus: 'unpaid',
        amountTotalMinor: params.line_items[0].price_data.unit_amount,
        currency: String(params.line_items[0].price_data.currency).toUpperCase(),
        paymentIntentId: '', url: 'https://checkout.stripe.test/cs_test_1',
        expiresAt: null, metadata: params.metadata, ...sessionOver,
      };
    },
    async retrieveCheckoutSession(id) { calls.push({ method: 'retrieve', id }); return { id }; },
    async createRefund(params, opts) {
      calls.push({ method: 'createRefund', params, opts });
      if (fail) throw fail;
      return { id: 're_test_1', status: 'succeeded', amountMinor: params.amount,
        currency: 'USD', paymentIntentId: params.payment_intent, ...refundOver };
    },
    constructEvent() { throw new Error('not used'); },
  };
}

const event = (type, object, id = 'evt_1') => ({ id, type, data: { object } });

// ===========================================================================
// 1-14 — configuration
// ===========================================================================

test('1 — unset configuration is disabled, not an error', () => {
  const c = resolveStripeConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.mode, 'disabled');
  assert.match(c.disabledReason, /not set/);
});

test('2 — STRIPE_ENABLED=false is disabled and says which', () => {
  const c = resolveStripeConfig({ STRIPE_ENABLED: 'false' });
  assert.equal(c.enabled, false);
  assert.match(c.disabledReason, /is false/);
});

test('3 — the API can boot with no Stripe configuration at all', () => {
  /* B2B ordering on account terms is the primary flow and must never depend on
     a payment provider being configured. */
  assert.doesNotThrow(() => resolveStripeConfig({}));
  assert.doesNotThrow(() => resolveStripeConfig({ STRIPE_ENABLED: '' }));
  assert.doesNotThrow(() => resolveStripeConfig({ STRIPE_SECRET_KEY: 'sk_test_x' }));
});

test('4 — enabling with no secret key throws', () => {
  assert.throws(() => resolveStripeConfig({ STRIPE_ENABLED: 'true' }), StripeConfigError);
});

test('5 — enabling with no webhook secret throws, and says why it matters', () => {
  assert.throws(() => resolveStripeConfig({
    STRIPE_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_SUCCESS_URL: 'https://a.test/ok', STRIPE_CANCEL_URL: 'https://a.test/no',
  }), (err) => err instanceof StripeConfigError && /unauthenticated way to mark an invoice paid/.test(err.message));
});

test('6 — a half-configured Stripe is never partially live', () => {
  /* Every one of these throws rather than producing an enabled config with a
     hole in it. */
  const base = { STRIPE_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
  assert.throws(() => resolveStripeConfig(base), StripeConfigError);
  assert.throws(() => resolveStripeConfig({ ...base, STRIPE_SUCCESS_URL: 'https://a.test/ok' }), StripeConfigError);
  assert.doesNotThrow(() => resolveStripeConfig({ ...base,
    STRIPE_SUCCESS_URL: 'https://a.test/ok', STRIPE_CANCEL_URL: 'https://a.test/no' }));
});

test('7 — the mode is derived from the key prefix, not declared', () => {
  const mk = (key) => resolveStripeConfig({
    STRIPE_ENABLED: 'true', STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_SUCCESS_URL: 'https://a.test/ok', STRIPE_CANCEL_URL: 'https://a.test/no',
  }, { isProduction: key.includes('live') });
  assert.equal(mk('sk_test_x').mode, 'test');
  assert.equal(mk('sk_live_x').mode, 'live');
  assert.equal(mk('rk_test_x').mode, 'test');
});

test('8 — a live key outside production is refused', () => {
  /* The usual way this happens is a staging box copied from production
     configuration, and the usual outcome is a real card charged during a test. */
  assert.throws(() => resolveStripeConfig({
    STRIPE_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_SUCCESS_URL: 'https://a.test/ok', STRIPE_CANCEL_URL: 'https://a.test/no',
  }, { isProduction: false }), (err) => /live-mode Stripe key was supplied outside production/.test(err.message));
});

test('9 — a mismatched test/live key pair is refused', () => {
  assert.throws(() => resolveStripeConfig({
    STRIPE_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PUBLISHABLE_KEY: 'pk_live_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_SUCCESS_URL: 'https://a.test/ok', STRIPE_CANCEL_URL: 'https://a.test/no',
  }), (err) => /different Stripe environment/.test(err.message));
});

test('10 — a malformed key, secret or return URL is refused', () => {
  const base = { STRIPE_ENABLED: 'true', STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_SUCCESS_URL: 'https://a.test/ok', STRIPE_CANCEL_URL: 'https://a.test/no' };
  assert.throws(() => resolveStripeConfig({ ...base, STRIPE_SECRET_KEY: 'nope' }), StripeConfigError);
  assert.throws(() => resolveStripeConfig({ ...base, STRIPE_SECRET_KEY: ' sk_test_x ' }), StripeConfigError);
  assert.throws(() => resolveStripeConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'nope' }), StripeConfigError);
  assert.throws(() => resolveStripeConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_SUCCESS_URL: 'not-a-url' }), StripeConfigError);
  assert.throws(() => resolveStripeConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_SUCCESS_URL: 'https://u:p@a.test/ok' }), StripeConfigError);
});

test('11 — the publishable key is optional and validated only when present', () => {
  const base = { STRIPE_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_SUCCESS_URL: 'https://a.test/ok', STRIPE_CANCEL_URL: 'https://a.test/no' };
  assert.equal(resolveStripeConfig(base).publishableKey, '');
  assert.throws(() => resolveStripeConfig({ ...base, STRIPE_PUBLISHABLE_KEY: 'sk_test_wrong' }), StripeConfigError);
});

test('12 — the public view carries no key of any kind', () => {
  const c = resolveStripeConfig({
    STRIPE_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_SECRET', STRIPE_WEBHOOK_SECRET: 'whsec_SECRET',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
    STRIPE_SUCCESS_URL: 'https://a.test/ok', STRIPE_CANCEL_URL: 'https://a.test/no',
  });
  const view = publicView(c);
  const json = JSON.stringify(view);
  for (const secret of ['sk_test_SECRET', 'whsec_SECRET', 'pk_test_x', 'secretKey', 'webhookSecret']) {
    assert.ok(!json.includes(secret), `the public view leaked ${secret}`);
  }
  assert.deepEqual(Object.keys(view).sort(), ['disabledReason', 'enabled', 'mode', 'testMode']);
  assert.equal(view.testMode, true, 'a test-mode deployment must say so');
});

test('13 — the API version is pinned', () => {
  /* An unpinned version means Stripe can change the shape of a webhook this
     code parses without a line of Veyora changing. */
  assert.match(STRIPE_API_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(resolveStripeConfig({}).apiVersion, STRIPE_API_VERSION);
});

test('14 — the disabled client refuses every operation and can never report success', () => {
  const client = createDisabledStripeClient('off');
  for (const method of ['createCheckoutSession', 'retrieveCheckoutSession', 'createRefund', 'constructEvent']) {
    assert.throws(() => client[method]({}), /off/, method);
  }
});

// ===========================================================================
// 15-26 — money
// ===========================================================================

test('15 — minor units are exact for ordinary amounts', () => {
  assert.deepEqual(toMinorUnits('250.00', 'USD'), { ok: true, minor: 25000 });
  assert.deepEqual(toMinorUnits('0.01', 'USD'), { ok: true, minor: 1 });
  assert.deepEqual(toMinorUnits('1', 'USD'), { ok: true, minor: 100 });
  assert.deepEqual(toMinorUnits('1.5', 'USD'), { ok: true, minor: 150 });
});

test('16 — an amount too precise for the currency is REFUSED, never rounded', () => {
  /* Quietly rounding would hide a bug upstream and mis-charge by a cent. */
  assert.deepEqual(toMinorUnits('12.345', 'USD'), { ok: false, reason: 'TOO_PRECISE' });
  assert.deepEqual(toMinorUnits('12.3400', 'USD'), { ok: true, minor: 1234 }, 'trailing zeros are harmless');
});

test('17 — a non-decimal is refused rather than coerced', () => {
  for (const bad of ['', '  ', 'abc', '12.5.3', '1e3', '$12.00', '12,00', null, undefined, {}]) {
    assert.equal(toMinorUnits(bad, 'USD').ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('18 — the float trap is avoided', () => {
  /* 0.1 + 0.2 arithmetic is why this parses the string rather than multiplying
     a float: `29.97 * 100` is 2996.9999999999995. */
  assert.deepEqual(toMinorUnits('29.97', 'USD'), { ok: true, minor: 2997 });
  assert.deepEqual(toMinorUnits('1.10', 'USD'), { ok: true, minor: 110 });
  assert.deepEqual(toMinorUnits('8.24', 'USD'), { ok: true, minor: 824 });
});

test('19 — zero-decimal currencies have no minor unit', () => {
  assert.deepEqual(toMinorUnits('1000', 'JPY'), { ok: true, minor: 1000 });
  assert.equal(fromMinorUnits(1000, 'JPY'), '1000');
});

test('20 — display conversion round-trips', () => {
  for (const amount of ['0.01', '1.00', '250.00', '12345.67']) {
    const minor = toMinorUnits(amount, 'USD');
    assert.equal(fromMinorUnits(minor.minor, 'USD'), amount.replace(/^(\d+)\.(\d\d)$/, '$1.$2'));
  }
});

test('21 — the settlement states are exactly the five specified', () => {
  assert.deepEqual([...SETTLEMENT_STATES], ['on_terms', 'processing', 'paid', 'refunded', 'void']);
});

test('22 — only an on-terms invoice may open a payment session', () => {
  assert.deepEqual([...PAYABLE_STATES], ['on_terms']);
  for (const state of ['paid', 'refunded', 'void', 'processing']) {
    const v = assessPayability(invoiceRow({ settlement_state: state }));
    assert.equal(v.payable, false, state);
    assert.ok(v.reason.length > 10, `${state} must carry a sentence, not just a code`);
  }
});

test('23 — a paid, refunded or void invoice each gets its OWN explanation', () => {
  assert.equal(assessPayability(invoiceRow({ settlement_state: 'paid' })).code, 'ALREADY_PAID');
  assert.equal(assessPayability(invoiceRow({ settlement_state: 'processing' })).code, 'PAYMENT_PENDING');
  assert.equal(assessPayability(invoiceRow({ settlement_state: 'refunded' })).code, 'REFUNDED');
  assert.equal(assessPayability(invoiceRow({ settlement_state: 'void' })).code, 'VOID');
});

test('24 — Stripe being off is explained as terms, not as an outage', () => {
  const v = assessPayability(invoiceRow(), { stripeEnabled: false });
  assert.equal(v.payable, false);
  assert.equal(v.code, 'PAYMENT_DISABLED');
  assert.match(v.reason, /payable on your usual account terms/i);
  assert.doesNotMatch(v.reason, /error|failed|unavailable due/i);
});

test('25 — an unsupported currency or unreadable amount cannot be paid', () => {
  assert.equal(assessPayability(invoiceRow({ settlement_currency: 'XYZ' })).code, 'UNSUPPORTED_CURRENCY');
  assert.equal(assessPayability(invoiceRow({ amount: 'abc' })).code, 'AMOUNT_UNREADABLE');
  assert.equal(assessPayability(invoiceRow({ amount: '0.00' })).code, 'NOTHING_TO_PAY');
  assert.deepEqual([...PAYMENT_CURRENCIES], ['USD', 'CAD', 'EUR']);
});

test('26 — the idempotency key is derived from the server’s facts only', () => {
  const a = sessionIdempotencyKey({ invoiceId: 'in_1', amountMinor: 25000, currency: 'USD' });
  const b = sessionIdempotencyKey({ invoiceId: 'in_1', amountMinor: 25000, currency: 'USD' });
  assert.equal(a, b, 'identical requests must produce an identical key');
  assert.notEqual(a, sessionIdempotencyKey({ invoiceId: 'in_1', amountMinor: 25001, currency: 'USD' }));
  assert.notEqual(a, sessionIdempotencyKey({ invoiceId: 'in_2', amountMinor: 25000, currency: 'USD' }));
  assert.notEqual(a, sessionIdempotencyKey({ invoiceId: 'in_1', amountMinor: 25000, currency: 'USD', attempt: 1 }));
  /* Hashed, so no invoice number rides into Stripe's idempotency store. */
  assert.ok(!a.includes('in_1'));
});

// ===========================================================================
// 27-40 — sessions
// ===========================================================================

test('27 — creating a session takes the amount from the invoice, never from a caller', async () => {
  const db = makeDb();
  const stripe = makeStripe();
  const { session } = await createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR);
  assert.equal(session.amount_minor, 25000);
  assert.equal(session.currency, 'USD');
  const params = stripe.calls[0].params;
  assert.equal(params.line_items[0].price_data.unit_amount, 25000);
  /* The signature takes no amount at all — there is no parameter a request
     body could reach. */
  assert.ok(!/function createOrGetSession\([^)]*amount/i.test(sessionSrc));
});

test('28 — a second request reuses the live session rather than opening another', async () => {
  const db = makeDb();
  const stripe = makeStripe();
  const first = await createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR);
  const second = await createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR);
  assert.equal(second.reused, true);
  assert.equal(second.session.id, first.session.id);
  assert.equal(stripe.calls.length, 1, 'Stripe must be contacted once');
  assert.equal(db.sessions.filter((s) => ['created', 'open'].includes(s.status)).length, 1);
});

test('29 — three simultaneous requests still produce one session', async () => {
  const db = makeDb();
  const stripe = makeStripe();
  const results = await Promise.allSettled([
    createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR),
    createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR),
    createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR),
  ]);
  const live = db.sessions.filter((s) => ['created', 'open'].includes(s.status));
  assert.equal(live.length, 1, 'the one-live-session index must hold');
  assert.ok(results.some((r) => r.status === 'fulfilled'));
});

test('30 — an unpayable invoice cannot open a session, and nothing is written', async () => {
  for (const state of ['paid', 'refunded', 'void', 'processing']) {
    const db = makeDb({ invoices: [invoiceRow({ settlement_state: state })] });
    const stripe = makeStripe();
    await assert.rejects(
      () => createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR),
      (err) => err instanceof PaymentError && err.status === 409, state);
    assert.equal(db.sessions.length, 0, state);
    assert.equal(stripe.calls.length, 0, `Stripe must not be contacted for a ${state} invoice`);
  }
});

test('31 — a customer cannot open a session against somebody else’s invoice', async () => {
  const db = makeDb();
  const stripe = makeStripe();
  await assert.rejects(
    () => createOrGetSession(db, stripe, CONFIG, 'in_1', { id: 'u_other' }, { isCustomer: true }),
    /* 404, not 403 — distinguishing them would confirm the invoice exists to
       anyone enumerating ids. */
    (err) => err.status === 404 && err.body.code === 'NOT_FOUND');
  assert.equal(stripe.calls.length, 0);
});

test('32 — Stripe is never called inside the transaction that locks the invoice', () => {
  /* A provider round trip with a row lock held is how a slow third party
     becomes a database incident. */
  const txStart = sessionSrc.indexOf('const reserved = await db.tx(');
  const txEnd = sessionSrc.indexOf('if (reserved.reuse)');
  const call = sessionSrc.indexOf('stripe.createCheckoutSession');
  assert.ok(txStart > -1 && txEnd > txStart, 'the transaction block must be findable');
  assert.ok(call > txEnd,
    'the provider must not be contacted while the invoice row lock is held');
});

test('33 — a provider failure leaves a visible failed session, not silence', async () => {
  const db = makeDb();
  const stripe = makeStripe({ fail: Object.assign(new Error('down'), { code: 'api_error' }) });
  await assert.rejects(() => createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR),
    (err) => err.status === 502 && err.body.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(db.sessions.length, 1);
  assert.equal(db.sessions[0].status, 'failed');
  assert.equal(db.sessions[0].last_error, 'api_error');
  assert.equal(db.invoices[0].settlement_state, 'on_terms', 'nothing may be marked paid');
});

test('34 — a provider returning the wrong amount is refused', async () => {
  const db = makeDb();
  const stripe = makeStripe({ sessionOver: { amountTotalMinor: 100 } });
  await assert.rejects(() => createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR),
    (err) => err.status === 502 && err.body.code === 'AMOUNT_MISMATCH');
  assert.equal(db.sessions[0].status, 'failed');
});

test('35 — the Stripe request carries no wholesale or internal detail', () => {
  const params = buildCheckoutParams({
    invoiceId: 'in_1', invoiceNumber: 'IN1001', amountMinor: 25000, currency: 'USD',
    successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/no',
  });
  const json = JSON.stringify(params);
  for (const leak of ['sku', 'wholesale', 'cost', 'balance', 'terms', 'pricing', 'agent']) {
    assert.ok(!json.toLowerCase().includes(leak), `the Stripe request leaked ${leak}`);
  }
  /* The invoice NUMBER is safe metadata: it is already printed on the invoice
     the customer holds, and it is what makes a dashboard payment traceable. */
  assert.equal(params.metadata.veyoraInvoiceNumber, 'IN1001');
  assert.equal(params.payment_intent_data.metadata.veyoraInvoiceNumber, 'IN1001');
  assert.equal(params.line_items.length, 1, 'one line, not the order contents');
});

test('36 — no secret is ever returned to a browser', () => {
  /* Neither route module may reference a secret at all. */
  for (const [name, src] of [['admin-payments', adminSrc], ['payments', routesSrc]]) {
    assert.ok(!/secretKey/.test(src), `${name} references the secret key`);
    assert.ok(!/webhookSecret\s*[,}\]]/.test(src.replace(/config\.webhookSecret/g, '')),
      `${name} may only pass the webhook secret to the verifier`);
    assert.ok(!/STRIPE_SECRET_KEY/.test(src), `${name} reads a key directly`);
  }
});

test('37 — a session is reusable only while open, unexpired and for the right amount', () => {
  const base = { status: 'open', hosted_url: 'https://x.test', amount_minor: 25000, currency: 'USD',
    expires_at: new Date(T0.getTime() + 3600_000) };
  const args = { amountMinor: 25000, currency: 'USD', now: T0 };
  assert.equal(isSessionReusable(base, args), true);
  assert.equal(isSessionReusable({ ...base, status: 'completed' }, args), false);
  assert.equal(isSessionReusable({ ...base, hosted_url: '' }, args), false);
  assert.equal(isSessionReusable({ ...base, amount_minor: 100 }, args), false);
  assert.equal(isSessionReusable({ ...base, currency: 'EUR' }, args), false);
  assert.equal(isSessionReusable({ ...base, expires_at: new Date(T0.getTime() - 1) }, args), false);
  assert.equal(isSessionReusable(null, args), false);
});

test('38 — an amount change supersedes the old session rather than reusing it', async () => {
  const db = makeDb();
  const stripe = makeStripe();
  await createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR);
  db.invoices[0].amount = '300.00';
  const second = await createOrGetSession(db, stripe, CONFIG, 'in_1', ACTOR);
  assert.equal(second.reused, false);
  assert.equal(second.session.amount_minor, 30000);
  assert.equal(db.sessions.find((s) => s.amount_minor === 25000).status, 'cancelled',
    'the old session is cancelled, not deleted — the attempt happened');
});

test('39 — stale sessions expire so an invoice does not become unpayable forever', async () => {
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  const later = new Date(T0.getTime() + 1000 * 60 * 60 * 24);
  const result = await expireStaleSessions(db, { now: later });
  assert.equal(result.expired, 1);
  assert.equal(db.sessions[0].status, 'expired');
  /* And the invoice can be paid again. */
  const again = await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  assert.equal(again.reused, false);
});

test('40 — the session serializer withholds the hosted link unless asked', () => {
  const row = { id: 'ps_1', invoice_id: 'in_1', status: 'open', amount_minor: 25000,
    currency: 'USD', hosted_url: 'https://checkout.stripe.test/secret-link',
    provider_payment_intent: 'pi_1', idempotency_key: 'ps_abc' };
  const without = serializeSession(row);
  assert.equal('hostedUrl' in without, false);
  assert.ok(!JSON.stringify(without).includes('secret-link'));
  assert.ok(!JSON.stringify(without).includes('ps_abc'), 'the idempotency key is not a public field');
  assert.equal(serializeSession(row, { includeUrl: true }).hostedUrl, 'https://checkout.stripe.test/secret-link');
});

// ===========================================================================
// 41-60 — the webhook
// ===========================================================================

test('41 — the webhook is mounted BEFORE the JSON parser, with a raw body', () => {
  /* Load-bearing: a signature is computed over the exact bytes, and
     express.json() discards them. */
  const rawAt = indexSrc.indexOf("express.raw");
  const jsonAt = indexSrc.indexOf("express.json");
  assert.ok(rawAt > -1, 'a raw body parser must be mounted');
  assert.ok(rawAt < jsonAt, 'the raw webhook mount must come before express.json()');
  assert.match(indexSrc, /app\.use\('\/webhooks',\s*express\.raw/);
});

test('42 — a body that is not raw bytes is refused', () => {
  const stripe = { constructEvent() { throw new Error('should not be reached'); } };
  assert.throws(() => verifyEvent(stripe, { parsed: 'object' }, 'sig', 'whsec_x'),
    (err) => err instanceof WebhookError && err.code === 'NO_RAW_BODY');
});

test('43 — a missing signature header is refused before anything is parsed', () => {
  const stripe = { constructEvent() { throw new Error('should not be reached'); } };
  assert.throws(() => verifyEvent(stripe, Buffer.from('{}'), '', 'whsec_x'),
    (err) => err.code === 'NO_SIGNATURE');
});

test('44 — a bad signature is a 400 that says nothing about why', () => {
  const stripe = { constructEvent() { throw new Error('No signatures found matching the expected signature'); } };
  assert.throws(() => verifyEvent(stripe, Buffer.from('{}'), 'sig', 'whsec_x'), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_SIGNATURE');
    assert.ok(!/expected signature/.test(err.message), 'the provider message must not be echoed');
    return true;
  });
});

test('45 — verification runs before anything is stored', () => {
  /* In the route, verifyEvent must precede processEvent textually and by
     control flow: a rejected body never reaches the database. */
  const handler = routesSrc.slice(routesSrc.indexOf("stripeWebhookRoutes.post('/stripe'"));
  const v = handler.indexOf('verifyEvent');
  const p = handler.indexOf('processEvent');
  assert.ok(v > -1, 'the handler must verify');
  assert.ok(p > v, 'the signature must be verified before the event is processed');
  /* And the verification failure path returns before reaching processEvent. */
  assert.ok(handler.indexOf('return res.status(400)') < p,
    'a rejected body must return before anything is stored');
});

test('46 — the event allowlist is exact', () => {
  assert.deepEqual([...HANDLED_EVENTS], [
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'checkout.session.expired',
    'charge.refunded',
    'charge.dispute.created',
  ]);
  for (const other of ['payment_intent.created', 'customer.created', 'invoice.paid', '', null]) {
    assert.equal(isHandledEvent(other), false, `${other} must not be handled`);
  }
});

test('47 — an unknown event is acknowledged and recorded, never acted on', async () => {
  const db = makeDb();
  const out = await processEvent(db, event('customer.created', { id: 'cus_1' }));
  assert.equal(out.status, 'ignored');
  assert.equal(db.events[0].status, 'ignored');
  assert.equal(db.invoices[0].settlement_state, 'on_terms');
});

test('48 — a duplicate event is deduplicated by the database, not by application memory', async () => {
  const db = makeDb();
  const e = event('customer.created', { id: 'cus_1' });
  const first = await processEvent(db, e);
  const second = await processEvent(db, e);
  assert.equal(first.status, 'ignored');
  assert.equal(second.status, 'duplicate');
  assert.equal(db.events.length, 1, 'the unique constraint is the mechanism');
  assert.match(webhookSrc, /on conflict \(provider_event_id\) do nothing/);
});

test('49 — the raw payload is never stored', async () => {
  const db = makeDb();
  await processEvent(db, event('customer.created', {
    id: 'cus_1', email: 'someone@example.test', name: 'A Person',
    address: { line1: '1 Somewhere' }, payment_method_details: { card: { last4: '4242' } },
  }));
  const stored = JSON.stringify(db.events[0].summary);
  for (const leak of ['someone@example.test', 'A Person', 'Somewhere', '4242', 'payment_method_details']) {
    assert.ok(!stored.includes(leak), `the summary leaked ${leak}`);
  }
  assert.ok(!/summary\s*:\s*JSON\.stringify\(event\)/.test(webhookSrc));
});

test('50 — the summariser is an allowlist and never spreads the event', () => {
  const s = summariseEvent(event('checkout.session.completed', {
    id: 'cs_1', object: 'checkout.session', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_1',
    customer_details: { email: 'x@example.test' }, secret_field: 'nope',
  }));
  assert.equal('customer_details' in s, false);
  assert.equal('secret_field' in s, false);
  assert.equal(s.paymentIntentId, 'pi_1');
  assert.equal(s.currency, 'USD');
  assert.ok(!/\.\.\.\s*(event|o|object)/.test(webhookSrc), 'the event must never be spread');
});

test('51 — a completed session settles the invoice, the ledger and the balance, once', async () => {
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  const out = await processEvent(db, event('checkout.session.completed', {
    id: 'cs_test_1', object: 'checkout.session', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_1',
    metadata: { veyoraInvoiceId: 'in_1', veyoraInvoiceNumber: 'IN1001' },
  }));
  assert.equal(out.code, 'SETTLED');
  assert.equal(db.invoices[0].settlement_state, 'paid');
  assert.equal(db.invoices[0].amount_settled_minor, 25000);
  assert.equal(db.invoices[0].settlement_reference, 'pi_1');
  assert.equal(db.sessions[0].status, 'completed');
  assert.equal(db.payments.length, 1);
  assert.equal(db.balances[CUSTOMER_ID], '0');
});

test('52 — a replayed settlement moves nothing a second time', async () => {
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  const payload = {
    id: 'cs_test_1', object: 'checkout.session', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_1',
  };
  await processEvent(db, event('checkout.session.completed', payload, 'evt_1'));
  /* A DIFFERENT event id carrying the same settlement — the dedup index cannot
     help, so the transition itself must be a no-op. */
  const again = await processEvent(db, event('checkout.session.completed', payload, 'evt_2'));
  assert.equal(again.status, 'noop');
  assert.equal(db.payments.length, 1, 'the money may be recorded once');
  assert.equal(db.balances[CUSTOMER_ID], '0', 'the balance may move once');
});

test('53 — a session completed but not PAID does not settle', async () => {
  /* checkout.session.completed fires for delayed methods too, where nothing
     has been captured. Settling on session status alone would mark those paid. */
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  const out = await processEvent(db, event('checkout.session.completed', {
    id: 'cs_test_1', status: 'complete', payment_status: 'unpaid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_1',
  }));
  assert.equal(out.status, 'noop');
  assert.equal(db.invoices[0].settlement_state, 'on_terms');
  assert.equal(db.payments.length, 0);
});

test('54 — an amount mismatch is a reconciliation exception, never a settlement', async () => {
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  const out = await processEvent(db, event('checkout.session.completed', {
    id: 'cs_test_1', status: 'complete', payment_status: 'paid',
    amount_total: 100, currency: 'usd', payment_intent: 'pi_1',
  }));
  assert.equal(out.status, 'failed');
  assert.equal(out.code, 'AMOUNT_MISMATCH');
  assert.equal(db.invoices[0].settlement_state, 'on_terms');
  assert.equal(db.payments.length, 0);
  assert.equal(db.events[0].status, 'failed');
});

test('55 — a currency mismatch is refused too', async () => {
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  const out = await processEvent(db, event('checkout.session.completed', {
    id: 'cs_test_1', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'eur', payment_intent: 'pi_1',
  }));
  assert.equal(out.code, 'CURRENCY_MISMATCH');
  assert.equal(db.invoices[0].settlement_state, 'on_terms');
});

test('56 — an event for a session Veyora never created cannot settle anything', async () => {
  /* Metadata is writable from the Stripe dashboard, so trusting it would let a
     dashboard user settle any invoice. */
  const db = makeDb();
  const out = await processEvent(db, event('checkout.session.completed', {
    id: 'cs_unknown', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_x',
    metadata: { veyoraInvoiceId: 'in_1', veyoraInvoiceNumber: 'IN1001' },
  }));
  assert.equal(out.status, 'failed');
  assert.equal(out.code, 'UNKNOWN_SESSION');
  assert.equal(db.invoices[0].settlement_state, 'on_terms');
});

test('57 — an expiry arriving AFTER a completion does not un-pay the invoice', async () => {
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  await processEvent(db, event('checkout.session.completed', {
    id: 'cs_test_1', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_1',
  }, 'evt_1'));
  const out = await processEvent(db, event('checkout.session.expired', { id: 'cs_test_1' }, 'evt_2'));
  assert.equal(out.status, 'noop');
  assert.equal(db.invoices[0].settlement_state, 'paid');
  assert.equal(db.sessions[0].status, 'completed');
});

test('58 — an expiry for an open session closes it', async () => {
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  const out = await processEvent(db, event('checkout.session.expired', { id: 'cs_test_1' }));
  assert.equal(out.code, 'EXPIRED');
  assert.equal(db.sessions[0].status, 'expired');
  assert.equal(db.invoices[0].settlement_state, 'on_terms');
});

test('59 — a refund event records the CUMULATIVE total rather than adding', async () => {
  /* Stripe reports the running refunded total on the charge; adding would
     double-count a second partial refund. */
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  await processEvent(db, event('checkout.session.completed', {
    id: 'cs_test_1', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_1',
  }, 'evt_1'));

  await processEvent(db, event('charge.refunded',
    { id: 'ch_1', payment_intent: 'pi_1', amount: 25000, amount_refunded: 10000, currency: 'usd' }, 'evt_2'));
  assert.equal(db.invoices[0].amount_refunded_minor, 10000);
  assert.equal(db.invoices[0].settlement_state, 'paid', 'a partial refund is not a full one');

  await processEvent(db, event('charge.refunded',
    { id: 'ch_1', payment_intent: 'pi_1', amount: 25000, amount_refunded: 25000, currency: 'usd' }, 'evt_3'));
  assert.equal(db.invoices[0].amount_refunded_minor, 25000);
  assert.equal(db.invoices[0].settlement_state, 'refunded');
});

test('60 — a refund exceeding what was settled is refused', async () => {
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  await processEvent(db, event('checkout.session.completed', {
    id: 'cs_test_1', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_1',
  }, 'evt_1'));
  const out = await processEvent(db, event('charge.refunded',
    { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 99999, currency: 'usd' }, 'evt_2'));
  assert.equal(out.status, 'failed');
  assert.equal(out.code, 'REFUND_EXCEEDS_SETTLED');
  assert.equal(db.invoices[0].amount_refunded_minor, 0);
});

test('61 — a dispute is recorded and does NOT flip the invoice back to unpaid', async () => {
  /* The money has not moved yet, and marking it unpaid would misstate the
     receivables ledger for something often resolved in Veyora's favour. */
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  await processEvent(db, event('checkout.session.completed', {
    id: 'cs_test_1', status: 'complete', payment_status: 'paid',
    amount_total: 25000, currency: 'usd', payment_intent: 'pi_1',
  }, 'evt_1'));
  const out = await processEvent(db, event('charge.dispute.created',
    { id: 'dp_1', payment_intent: 'pi_1', amount: 25000, currency: 'usd' }, 'evt_2'));
  assert.equal(out.code, 'DISPUTE_RECORDED');
  assert.equal(db.invoices[0].settlement_state, 'paid');
});

test('62 — nothing but a verified webhook can mark an invoice paid', () => {
  /* The strongest structural claim in this phase. No route file may contain a
     statement that sets settlement_state to 'paid'. */
  for (const [name, src] of [['admin-payments', adminSrc], ['payments routes', routesSrc], ['sessions', sessionSrc]]) {
    assert.ok(!/settlement_state\s*=\s*'paid'/.test(src), `${name} can mark an invoice paid`);
  }
  assert.match(webhookSrc, /settlement_state = 'paid'/);
});

test('63 — a browser redirect is never treated as proof of payment', () => {
  /* No route reads a success/return parameter and settles on it. */
  for (const src of [adminSrc, routesSrc, sessionSrc]) {
    assert.ok(!/req\.query\.(session_id|payment_intent|success)/.test(src));
  }
});

test('64 — reconciliation exposes the summary, never a raw payload', async () => {
  const db = makeDb();
  await createOrGetSession(db, makeStripe(), CONFIG, 'in_1', ACTOR);
  await processEvent(db, event('checkout.session.completed', {
    id: 'cs_test_1', status: 'complete', payment_status: 'paid',
    amount_total: 1, currency: 'usd', payment_intent: 'pi_1',
  }));
  const exceptions = await reconciliationExceptions(db);
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].lastError, 'AMOUNT_MISMATCH');
  assert.equal('summary' in exceptions[0], false, 'the reconciliation view returns no payload at all');
  assert.equal('payload' in exceptions[0], false);
});

// ===========================================================================
// 65-76 — capabilities, refunds and the schema
// ===========================================================================

test('65 — the four payment capabilities are separate and registered', async () => {
  const { PERMISSION_KEYS } = await import('../src/permission-registry.js');
  assert.deepEqual({ ...PAYMENT_CAPABILITIES }, {
    view: 'payments.view', collect: 'payments.collect',
    refund: 'payments.refund', reconcile: 'payments.reconcile',
  });
  for (const key of Object.values(PAYMENT_CAPABILITIES)) {
    assert.ok(PERMISSION_KEYS.includes(key), `registry missing ${key}`);
    assert.ok(migration.includes(`'${key}'`), `migration CHECK missing ${key}`);
    assert.ok(migrateJs.includes(`'${key}'`), `ensureSchema CHECK missing ${key}`);
  }
});

test('66 — capability discovery is honest for an account holding none', async () => {
  const db = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await getPaymentCapabilities(db, 'u_nobody'),
    { view: false, collect: false, refund: false, reconcile: false });
});

test('67 — holding one payment capability confers none of the others', async () => {
  const db = { query: async () => ({ rows: [{ permission_key: 'payments.view' }] }) };
  assert.deepEqual(await getPaymentCapabilities(db, 'u_ops'),
    { view: true, collect: false, refund: false, reconcile: false });
});

test('68 — every payment route is gated, and each on the right capability', () => {
  assert.match(adminSrc, /r\.get\('\/invoice\/:invoiceId',\s*canView\(\)/);
  assert.match(adminSrc, /r\.post\('\/invoice\/:invoiceId\/collect',\s*canCollect\(\)/);
  assert.match(adminSrc, /r\.post\('\/invoice\/:invoiceId\/refund',\s*canRefund\(\)/);
  assert.match(adminSrc, /r\.get\('\/reconciliation',\s*canReconcile\(\)/);
  /* No role fallback anywhere on the router. */
  assert.ok(!/req\.user\.role\s*===/.test(adminSrc), 'a role check leaked into the payment router');
});

test('69 — a refund needs an explicit confirmation and a stated reason', async () => {
  const db = makeDb({ invoices: [invoiceRow({ settlement_state: 'paid', amount_settled_minor: 25000,
    settled_at: T0, settlement_reference: 'pi_1' })] });
  const stripe = makeStripe();
  await assert.rejects(() => refundInvoice(db, stripe, 'in_1', { confirm: true }, ACTOR),
    (err) => err.status === 400 && err.body.code === 'REASON_REQUIRED');
  await assert.rejects(() => refundInvoice(db, stripe, 'in_1', { reason: 'duplicate charge' }, ACTOR),
    (err) => err.status === 400 && err.body.code === 'CONFIRMATION_REQUIRED');
  assert.equal(stripe.calls.length, 0, 'the provider must not be contacted');
  assert.equal(db.refunds.length, 0);
});

test('70 — a refund cannot exceed what was settled', async () => {
  const db = makeDb({ invoices: [invoiceRow({ settlement_state: 'paid', amount_settled_minor: 25000,
    settled_at: T0, settlement_reference: 'pi_1' })] });
  await assert.rejects(
    () => refundInvoice(db, makeStripe(), 'in_1', { confirm: true, reason: 'oops', amount: '500.00' }, ACTOR),
    (err) => err.status === 409 && err.body.code === 'EXCEEDS_REMAINING');
});

test('71 — an unsettled invoice has nothing to refund', async () => {
  const db = makeDb();
  await assert.rejects(
    () => refundInvoice(db, makeStripe(), 'in_1', { confirm: true, reason: 'oops' }, ACTOR),
    (err) => err.status === 409 && err.body.code === 'NOT_SETTLED');
});

test('72 — a successful refund records the amount, the reason and the authoriser', async () => {
  const db = makeDb({ invoices: [invoiceRow({ settlement_state: 'paid', amount_settled_minor: 25000,
    settled_at: T0, settlement_reference: 'pi_1' })] });
  const stripe = makeStripe();
  const out = await refundInvoice(db, stripe, 'in_1', { confirm: true, reason: 'goods returned' }, ACTOR);
  assert.equal(out.status, 'succeeded');
  assert.equal(out.amountMinor, 25000);
  assert.equal(db.refunds[0].reason, 'goods returned');
  assert.equal(db.refunds[0].authorised_by, 'u_ops');
  assert.equal(db.invoices[0].settlement_state, 'refunded');
  /* Stripe is asked to refund the PaymentIntent Veyora recorded, not one from
     a request body. */
  assert.equal(stripe.calls[0].params.payment_intent, 'pi_1');
});

test('73 — a refund the provider refuses records the attempt and moves nothing', async () => {
  const db = makeDb({ invoices: [invoiceRow({ settlement_state: 'paid', amount_settled_minor: 25000,
    settled_at: T0, settlement_reference: 'pi_1' })] });
  const stripe = makeStripe({ fail: Object.assign(new Error('no'), { code: 'charge_already_refunded' }) });
  await assert.rejects(
    () => refundInvoice(db, stripe, 'in_1', { confirm: true, reason: 'goods returned' }, ACTOR),
    (err) => err.status === 502 && err.body.code === 'REFUND_FAILED');
  assert.equal(db.refunds[0].status, 'failed');
  assert.equal(db.invoices[0].amount_refunded_minor, 0);
});

test('74 — nothing a customer can send causes a refund', () => {
  /* The customer router has no refund route, no refund import and no path
     that reaches one. */
  assert.ok(!/refund/i.test(routesSrc), 'the customer router must not mention refunds');
});

test('75 — the schema is additive and reuses invoices.status for nothing', () => {
  assert.doesNotMatch(migration, /drop table/i);
  assert.doesNotMatch(migration, /drop column/i);
  assert.doesNotMatch(migration, /delete from/i);
  assert.doesNotMatch(migration, /alter table orders/i);
  assert.doesNotMatch(migration, /insert into account_permissions/i);
  /* The new state lives in its own column, so "the external system issued
     this" and "a customer paid us" stay distinguishable. */
  assert.match(migration, /settlement_state text not null default 'on_terms'/);
  assert.ok(!/alter column status/i.test(migration));
});

test('76 — the money-critical constraints exist in both the migration and the mirror', () => {
  for (const constraint of [
    'invoices_paid_evidenced', 'invoices_refund_within_settled',
    'payment_sessions_one_live_idx', 'payment_sessions_completed_evidenced',
    'payments_settlement_key_idx',
  ]) {
    assert.ok(migration.includes(constraint), `migration missing ${constraint}`);
    assert.ok(migrateJs.includes(constraint), `ensureSchema missing ${constraint}`);
  }
  assert.match(migration, /provider_event_id\s+text not null unique/);
  assert.match(migrateJs, /provider_event_id\s+text not null unique/);
});

test('77 — no card field exists anywhere in the payment surface', () => {
  /* The reason for choosing a hosted flow: card details are entered on
     Stripe's page and never touch Veyora. */
  const all = [migration, migrateJs, adminSrc, routesSrc, sessionSrc, webhookSrc].join('\n').toLowerCase();
  for (const field of ['card_number', 'cardnumber', 'cvc', 'cvv', 'expiry_month', 'pan ']) {
    assert.ok(!all.includes(field), `a card field appeared: ${field}`);
  }
});

test('78 — no test in this file, and no module it exercises, imports the Stripe SDK', () => {
  /* Structural rather than promised. The SDK is loaded only by
     client-instance.js, dynamically, and only when Stripe is enabled. */
  for (const [name, src] of [['webhook', webhookSrc], ['sessions', sessionSrc],
    ['invoice-payments', code('payments', 'invoice-payments.js')],
    ['stripe-config', code('payments', 'stripe-config.js')]]) {
    assert.ok(!/from ['"]stripe['"]/.test(src), `${name} imports the SDK statically`);
  }
  const instance = code('payments', 'client-instance.js');
  assert.match(instance, /await import\('stripe'\)/, 'the SDK must be loaded dynamically');
  assert.ok(!/^import .* from 'stripe'/m.test(instance), 'and never statically');
});

test('79 — the invoice payment serializer returns no order contents or internal pricing', () => {
  const out = serializeInvoicePayment(invoiceRow({ order_id: 'o_1', status: 'paid' }));
  for (const forbidden of ['orderId', 'orderNumber', 'customerId', 'status', 'provider']) {
    assert.equal(forbidden in out, false, `the serializer leaked ${forbidden}`);
  }
  assert.equal(out.invoiceNumber, 'IN1001');
  assert.equal(out.settlementState, 'on_terms');
});

test('80 — normalisation of a provider object is an allowlist', () => {
  const s = normaliseSession({ id: 'cs_1', status: 'open', payment_status: 'unpaid',
    amount_total: 25000, currency: 'usd', payment_intent: { id: 'pi_1' },
    url: 'https://x.test', customer_details: { email: 'x@example.test' } });
  assert.equal('customer_details' in s, false);
  assert.equal(s.paymentIntentId, 'pi_1', 'an expanded intent object is flattened to its id');
  const r = normaliseRefund({ id: 're_1', status: 'succeeded', amount: 100, currency: 'usd',
    payment_intent: 'pi_1', charge: { id: 'ch_1', billing_details: {} } });
  assert.equal('charge' in r, false);
});
