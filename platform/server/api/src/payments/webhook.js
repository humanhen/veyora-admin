/* Stripe webhook processing (Final Handover, Phase 3).

   THE ONLY EVIDENCE THAT MONEY MOVED.

   Nothing else in this platform may mark an invoice paid: not the customer
   arriving on the success page, not a session returning `complete`, not an
   operator's judgement. A browser redirect is a claim made by a browser. A
   signed webhook is a statement by Stripe, verified against a shared secret.
   Those are different things and the whole subsystem is built on the
   difference.

   WHAT THIS FILE GUARANTEES

     1. SIGNATURE FIRST. Nothing is parsed, stored or acted on before
        `constructEvent` verifies the raw bytes. An unverified body is a 400
        and is never retried, never logged in full, and never reaches the
        database.

     2. AN EXACT EVENT ALLOWLIST. Stripe sends dozens of event types and will
        add more. Anything outside the list is acknowledged with 200 — so the
        provider stops retrying — and recorded as `ignored`. Acknowledging is
        not the same as acting.

     3. PERSISTENT DEDUPLICATION. `payment_events.provider_event_id` is UNIQUE.
        A retried delivery collides on insert and is acknowledged without being
        processed again. The database is the mechanism; there is no
        application-level "have I seen this?" to race with itself.

     4. AMOUNT AND CURRENCY ARE VERIFIED. Stripe's figure is compared against
        the session Veyora created. A mismatch is a reconciliation exception,
        never a settlement.

     5. OUT-OF-ORDER EVENTS ARE SAFE. Processing is written as a transition
        that is a no-op when already applied, so an expiry arriving after a
        completion does not un-pay an invoice.

     6. NO RAW PAYLOAD IS LOGGED OR STORED. A Stripe event carries names,
        addresses and card metadata. What is kept is an allowlisted summary.

     7. NO AUTOMATIC REFUND. A `charge.refunded` event RECORDS a refund that
        already happened at the provider; nothing here initiates one, and
        nothing a customer can send causes money to move outward.
*/

import { toMinorUnits } from './invoice-payments.js';

/** The exact set this phase acts on. Everything else is acknowledged and
 *  ignored — deliberately narrow, because an event type nobody wrote a handler
 *  for is one whose semantics nobody checked. */
export const HANDLED_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'charge.refunded',
  'charge.dispute.created',
]);

export const isHandledEvent = (t) => typeof t === 'string' && HANDLED_EVENTS.includes(t);

export class WebhookError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ---------------------------------------------------------------------------
   Summarising — the only thing that reaches the database
   --------------------------------------------------------------------------- */

/**
 * An allowlisted summary of one event.
 *
 * Built key by key from a fresh object literal. The event object is never
 * spread, so a field Stripe adds later — or a customer detail already in there
 * — cannot arrive in `payment_events.summary` unreviewed.
 */
export function summariseEvent(event) {
  const o = event?.data?.object || {};
  const intent = typeof o.payment_intent === 'string' ? o.payment_intent : (o.payment_intent?.id ?? '');
  return {
    type: String(event?.type ?? ''),
    objectId: String(o.id ?? ''),
    objectType: String(o.object ?? ''),
    status: String(o.status ?? ''),
    paymentStatus: String(o.payment_status ?? ''),
    paymentIntentId: String(intent || o.id || ''),
    amountMinor: firstNumber(o.amount_total, o.amount, o.amount_captured),
    amountRefundedMinor: firstNumber(o.amount_refunded),
    currency: String(o.currency ?? '').toUpperCase(),
    /* Only the two keys Veyora set. Metadata is writable from the Stripe
       dashboard, so it is read narrowly and still checked against our own row
       before anything is settled. */
    veyoraInvoiceId: String(o.metadata?.veyoraInvoiceId ?? ''),
    veyoraInvoiceNumber: String(o.metadata?.veyoraInvoiceNumber ?? ''),
  };
}

function firstNumber(...values) {
  for (const v of values) if (v != null && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/* ---------------------------------------------------------------------------
   Verification
   --------------------------------------------------------------------------- */

/**
 * Verifies the signature and returns the parsed event.
 *
 * @param rawBody the EXACT bytes received. Re-serialising the parsed JSON
 *   changes whitespace and key order and invalidates the signature, which is
 *   why the route mounts a raw body parser for this path alone.
 */
export function verifyEvent(stripe, rawBody, signatureHeader, webhookSecret) {
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
    throw new WebhookError(400, 'NO_RAW_BODY',
      'The webhook body was not received as raw bytes, so its signature cannot be verified.');
  }
  if (!signatureHeader) {
    throw new WebhookError(400, 'NO_SIGNATURE', 'Missing Stripe-Signature header.');
  }
  try {
    return stripe.constructEvent(rawBody, signatureHeader, webhookSecret);
  } catch (err) {
    /* The message is not echoed back. A verification failure is either an
       attacker probing or a misconfiguration, and neither is helped by the
       response describing which. */
    throw new WebhookError(400, 'INVALID_SIGNATURE', 'Signature verification failed.');
  }
}

/* ---------------------------------------------------------------------------
   Processing
   --------------------------------------------------------------------------- */

/**
 * Records and applies one verified event.
 *
 * Returns `{ status, code }` describing what happened. The caller answers 200
 * for every one of these: the event was accepted. A non-200 tells Stripe to
 * retry, which is right only for a transient failure on our side.
 */
export async function processEvent(db, event, { now = new Date() } = {}) {
  const eventId = String(event?.id ?? '');
  const type = String(event?.type ?? '');
  if (!eventId) throw new WebhookError(400, 'NO_EVENT_ID', 'The event carried no id.');

  const summary = summariseEvent(event);

  /* The deduplication claim. `on conflict do nothing` means the second
     delivery of an event inserts nothing and returns no row — which is the
     signal that it has already been seen. */
  const { rows: claimed } = await db.query(
    `insert into payment_events
       (provider_event_id, event_type, status, amount_minor, currency, summary)
     values ($1,$2,'received',$3,$4,$5)
     on conflict (provider_event_id) do nothing
     returning id`,
    [eventId, type, summary.amountMinor, summary.currency, JSON.stringify(summary)]
  );
  if (!claimed[0]) return { status: 'duplicate', code: 'ALREADY_SEEN' };
  const eventRowId = claimed[0].id;

  if (!isHandledEvent(type)) {
    /* Acknowledged, not acted on. Recording it means "did that event arrive?"
       has an answer, without implying anything was done about it. */
    await db.query(
      `update payment_events set status = 'ignored', processed_at = $2 where id = $1`,
      [eventRowId, now]
    );
    return { status: 'ignored', code: 'NOT_HANDLED' };
  }

  try {
    const outcome = await db.tx((c) => applyEvent(c, type, summary, { eventRowId, now }));
    await db.query(
      `update payment_events
          set status = $2, processed_at = $3, invoice_id = $4,
              payment_session_id = $5, last_error = $6
        where id = $1`,
      [eventRowId, outcome.settled === false && outcome.code !== 'NO_OP' ? 'failed' : 'processed',
       now, outcome.invoiceId ?? null, outcome.sessionId ?? null, outcome.error ?? '']
    );
    return { status: outcome.code === 'NO_OP' ? 'noop' : 'processed', code: outcome.code };
  } catch (err) {
    /* The event row survives as `failed` with a CODE. It is the reconciliation
       queue: a human with `payments.reconcile` sees exactly which events could
       not be applied and why. */
    await db.query(
      `update payment_events set status = 'failed', processed_at = $2, last_error = $3 where id = $1`,
      [eventRowId, now, String(err?.code || err?.message || 'PROCESSING_FAILED').slice(0, 300)]
    ).catch(() => {});
    return { status: 'failed', code: String(err?.code || 'PROCESSING_FAILED') };
  }
}

/* Each branch is written as a transition that is a NO-OP when already applied,
   so retries and out-of-order deliveries are safe by construction rather than
   by the caller remembering to check. */
async function applyEvent(c, type, summary, { eventRowId, now }) {
  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return settleFromSession(c, summary, { now });
    case 'checkout.session.expired':
      return expireFromSession(c, summary, { now });
    case 'checkout.session.async_payment_failed':
      return failFromSession(c, summary, { now });
    case 'charge.refunded':
      return recordRefund(c, summary, { now });
    case 'charge.dispute.created':
      return recordDispute(c, summary, { now });
    default:
      return { code: 'NO_OP' };
  }
}

/* ---------------------------------------------------------------------------
   Settlement
   --------------------------------------------------------------------------- */

async function settleFromSession(c, summary, { now }) {
  /* `payment_status` is what says money actually arrived.
     `checkout.session.completed` fires for delayed methods too, where the
     session is complete but nothing has been captured. Settling on the session
     status alone would mark those paid. */
  if (summary.paymentStatus && summary.paymentStatus !== 'paid') {
    return { code: 'NO_OP', settled: false };
  }

  const session = await lockSessionByProviderId(c, summary.objectId);
  if (!session) {
    /* An event for a session Veyora has no record of. Never guessed at from
       metadata alone: metadata is writable in the Stripe dashboard, so trusting
       it here would let a dashboard user settle any invoice. */
    throw Object.assign(new Error('no matching payment session'), { code: 'UNKNOWN_SESSION' });
  }

  const { rows: invoices } = await c.query(
    `select id, number, customer_id, amount, settlement_state, settlement_currency,
            amount_settled_minor, amount_refunded_minor
       from invoices where id = $1 limit 1 for update`,
    [session.invoice_id]
  );
  const invoice = invoices[0];
  if (!invoice) throw Object.assign(new Error('no matching invoice'), { code: 'UNKNOWN_INVOICE' });

  /* Already settled: this is a retry or a duplicate lifecycle event. Returning
     a no-op rather than adding the money again is what makes replay safe. */
  if (invoice.settlement_state === 'paid' || session.status === 'completed') {
    return { code: 'NO_OP', invoiceId: invoice.id, sessionId: session.id };
  }

  // ---- amount and currency verification ----
  if (summary.amountMinor == null) {
    throw Object.assign(new Error('event carried no amount'), { code: 'NO_AMOUNT' });
  }
  if (Number(summary.amountMinor) !== Number(session.amount_minor)) {
    throw Object.assign(new Error('amount does not match the session'), { code: 'AMOUNT_MISMATCH' });
  }
  if (String(summary.currency).toUpperCase() !== String(session.currency).toUpperCase()) {
    throw Object.assign(new Error('currency does not match the session'), { code: 'CURRENCY_MISMATCH' });
  }
  /* And against the invoice itself, not only against the session — a session
     created before the invoice amount changed must not settle it. */
  const expected = toMinorUnits(invoice.amount, invoice.settlement_currency);
  if (!expected.ok || Number(expected.minor) !== Number(session.amount_minor)) {
    throw Object.assign(new Error('the invoice amount changed since the session was created'),
      { code: 'INVOICE_AMOUNT_CHANGED' });
  }

  const reference = summary.paymentIntentId || summary.objectId;

  await c.query(
    `update payment_sessions
        set status = 'completed', completed_at = $2, provider_payment_intent = $3, last_error = ''
      where id = $1`,
    [session.id, now, reference]
  );

  await c.query(
    `update invoices
        set settlement_state = 'paid', settled_at = $2,
            amount_settled_minor = $3, settlement_reference = $4
      where id = $1`,
    [invoice.id, now, summary.amountMinor, reference]
  );

  /* The existing payments ledger, extended rather than duplicated — it is what
     the finance screens read. `settlement_key` is unique, so a replayed event
     that somehow reached here still cannot record the money twice. */
  const { rows: payment } = await c.query(
    `insert into payments (customer_id, amount, method, reference, paid_on,
                           stripe_payment_intent, invoice_id, currency, amount_minor,
                           payment_session_id, settlement_key)
     values ($1,$2,'stripe',$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (settlement_key) where settlement_key is not null do nothing
     returning id`,
    [invoice.customer_id, invoice.amount, reference, now, reference, invoice.id,
     session.currency, summary.amountMinor, session.id, `stripe:${reference}`]
  );

  /* The customer's balance falls by what was actually collected. Only when the
     payment row was newly inserted — otherwise a replay would move the balance
     a second time against a ledger entry that already existed. */
  if (payment[0] && invoice.customer_id) {
    await c.query(
      `update users set balance = coalesce(balance,0) - $2 where id = $1`,
      [invoice.customer_id, invoice.amount]
    );
  }

  return { code: 'SETTLED', invoiceId: invoice.id, sessionId: session.id, settled: true };
}

/* ---------------------------------------------------------------------------
   Expiry and failure
   --------------------------------------------------------------------------- */

async function expireFromSession(c, summary, { now }) {
  const session = await lockSessionByProviderId(c, summary.objectId);
  if (!session) return { code: 'NO_OP' };
  /* An expiry arriving after a completion must not undo it. This is the
     out-of-order case, and the WHERE clause is what makes it safe. */
  const { rows } = await c.query(
    `update payment_sessions set status = 'expired', last_error = 'the payment window closed'
      where id = $1 and status in ('created', 'open')
      returning id`,
    [session.id]
  );
  return { code: rows[0] ? 'EXPIRED' : 'NO_OP', invoiceId: session.invoice_id, sessionId: session.id };
}

async function failFromSession(c, summary, { now }) {
  const session = await lockSessionByProviderId(c, summary.objectId);
  if (!session) return { code: 'NO_OP' };
  const { rows } = await c.query(
    `update payment_sessions set status = 'failed', last_error = 'the payment was not completed'
      where id = $1 and status in ('created', 'open')
      returning id`,
    [session.id]
  );
  return { code: rows[0] ? 'FAILED' : 'NO_OP', invoiceId: session.invoice_id, sessionId: session.id };
}

/* ---------------------------------------------------------------------------
   Refunds and disputes — RECORDED, never initiated
   --------------------------------------------------------------------------- */

async function recordRefund(c, summary, { now }) {
  const session = await lockSessionByIntent(c, summary.paymentIntentId);
  if (!session) return { code: 'NO_OP' };

  const { rows: invoices } = await c.query(
    `select id, amount_settled_minor, amount_refunded_minor, settlement_state, settlement_currency
       from invoices where id = $1 limit 1 for update`,
    [session.invoice_id]
  );
  const invoice = invoices[0];
  if (!invoice) return { code: 'NO_OP' };

  const refunded = Number(summary.amountRefundedMinor ?? 0);
  if (!Number.isFinite(refunded) || refunded <= 0) return { code: 'NO_OP', invoiceId: invoice.id };
  if (refunded > Number(invoice.amount_settled_minor)) {
    throw Object.assign(new Error('refund exceeds what was settled'), { code: 'REFUND_EXCEEDS_SETTLED' });
  }
  /* Stripe reports the CUMULATIVE refunded total on the charge, so this is an
     assignment, not an addition — adding would double-count a second partial
     refund event. Already-applied is a no-op. */
  if (refunded === Number(invoice.amount_refunded_minor)) {
    return { code: 'NO_OP', invoiceId: invoice.id, sessionId: session.id };
  }

  await c.query(
    `update invoices
        set amount_refunded_minor = $2,
            settlement_state = case when $2 >= amount_settled_minor then 'refunded' else settlement_state end
      where id = $1`,
    [invoice.id, refunded]
  );

  /* A provider-side refund still gets a row here, so the refunds table is a
     complete record whether the refund was started in Veyora or in the Stripe
     dashboard. `on conflict do nothing` keeps a replay from adding a second. */
  await c.query(
    `insert into payment_refunds
       (invoice_id, provider_refund_id, amount_minor, currency, status, reason, idempotency_key)
     values ($1,$2,$3,$4,'succeeded',$5,$6)
     on conflict (idempotency_key) do nothing`,
    [invoice.id, summary.objectId, refunded, invoice.settlement_currency || summary.currency,
     'recorded from a provider refund event', `evt:${summary.objectId}:${refunded}`]
  );

  return { code: 'REFUND_RECORDED', invoiceId: invoice.id, sessionId: session.id };
}

/* A dispute is recorded and surfaced for a human. It deliberately does NOT
   change the invoice's settlement state: the money has not moved yet, and
   marking an invoice unpaid the moment a dispute opens would misstate the
   receivables ledger for what is often resolved in Veyora's favour. */
async function recordDispute(c, summary, { now }) {
  const session = await lockSessionByIntent(c, summary.paymentIntentId);
  if (!session) return { code: 'NO_OP' };
  return { code: 'DISPUTE_RECORDED', invoiceId: session.invoice_id, sessionId: session.id };
}

/* ---------------------------------------------------------------------------
   Lookups — always by OUR record of the provider id
   --------------------------------------------------------------------------- */

const SESSION_COLUMNS = `id, invoice_id, customer_id, status, amount_minor, currency,
  provider_session_id, provider_payment_intent, completed_at`;

async function lockSessionByProviderId(c, providerSessionId) {
  if (!providerSessionId) return null;
  const { rows } = await c.query(
    `select ${SESSION_COLUMNS} from payment_sessions
      where provider_session_id = $1 limit 1 for update`,
    [providerSessionId]
  );
  return rows[0] || null;
}

async function lockSessionByIntent(c, intentId) {
  if (!intentId) return null;
  const { rows } = await c.query(
    `select ${SESSION_COLUMNS} from payment_sessions
      where provider_payment_intent = $1 order by created_at desc limit 1 for update`,
    [intentId]
  );
  return rows[0] || null;
}

/* ---------------------------------------------------------------------------
   Reconciliation
   --------------------------------------------------------------------------- */

/**
 * Events that could not be applied, for a holder of `payments.reconcile`.
 *
 * The summary is returned, not the raw payload — there is no raw payload to
 * return. That is the point.
 */
export async function reconciliationExceptions(db, { limit = 50 } = {}) {
  const { rows } = await db.query(
    `select id, provider_event_id, event_type, status, invoice_id, payment_session_id,
            amount_minor, currency, last_error, received_at, processed_at
       from payment_events
      where status in ('failed', 'received')
      order by received_at desc limit $1`,
    [limit]
  );
  return rows.map((r) => ({
    id: String(r.id),
    providerEventId: String(r.provider_event_id),
    eventType: String(r.event_type),
    status: String(r.status),
    invoiceId: r.invoice_id == null ? null : String(r.invoice_id),
    sessionId: r.payment_session_id == null ? null : String(r.payment_session_id),
    amountMinor: r.amount_minor == null ? null : Number(r.amount_minor),
    currency: String(r.currency || ''),
    lastError: String(r.last_error || ''),
    receivedAt: r.received_at instanceof Date ? r.received_at.toISOString() : String(r.received_at || ''),
    processedAt: r.processed_at == null ? null
      : (r.processed_at instanceof Date ? r.processed_at.toISOString() : String(r.processed_at)),
  }));
}
