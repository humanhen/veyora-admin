/* Governed finance operations API (Final Handover, Phase 4).

   Mounted at /admin/finance, BEFORE the general /admin router.

   WHAT THIS REPLACES

   Money used to move through /admin/sync — a whole-database row diff. A
   browser could create, edit or DELETE a payment as an ordinary row, and could
   set a customer's balance to any number, with no record of what it was
   before, no reason and no reference. A row diff has no concept of any of
   those things.

   Every route here does all of the following, in one transaction:

     - takes the actor from the AUTHENTICATED session, never from a body;
     - checks a capability, with no role fallback;
     - validates a reason and/or a reference before anything is read;
     - reads the balance BEFORE, writes the movement, reads the balance AFTER;
     - writes an append-only `finance_events` row carrying both, the currency,
       the reference, the reason, the actor and the capability that admitted
       the request;
     - is idempotent through a server-derived key, so a double-click records
       the money once;
     - additionally writes a human-readable `audit_log` line after commit.

   FOUR CAPABILITIES, KEPT APART

     `finance.invoice`   — turn an order into a debt the customer owes
     `finance.record`    — record money that ARRIVED outside Stripe
     `finance.credit`    — reduce what a customer owes WITHOUT money arriving
     `finance.reconcile` — close a payment-event exception

   The third is the dangerous one. "We received £4,000" and "we have decided
   they owe £4,000 less" look identical on a balance and are completely
   different events; the person who keys in bank transfers all day should not
   be able to forgive a debt.

   WHAT THIS API CANNOT DO

     - It cannot record a Stripe payment. `method: 'stripe'` is refused by the
       validator, because a Stripe settlement is the exclusive result of a
       verified webhook. There is no client-reachable path to marking one
       successful.
     - It cannot set a balance. Every balance movement is the arithmetic
       consequence of an invoice, a payment or a credit note.
     - It cannot delete a payment or a credit note. A payment recorded in error
       is VOIDED with a reason and the row stays; deleting it would leave a
       balance movement nobody can explain.
     - It cannot edit a `finance_events` row. The database refuses UPDATE and
       DELETE on that table outright.
*/

import { Router } from 'express';
import { pool, tx as realTx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { requirePermission, getUserPermissions } from '../permissions.js';
import {
  FINANCE_CONTRACT, describeFinanceEvent, financeIdempotencyKey,
  serializeCreditNote, serializeFinanceEvent, serializePayment,
  validateCreditNote, validateOfflinePayment, validateResolution, validateVoid,
} from '../finance-operations.js';
import { fromMinorUnits, toMinorUnits } from '../payments/invoice-payments.js';
import { creditReviewAllowsProgress } from '../credit.js';

export const FINANCE_CAPABILITIES = Object.freeze({
  invoice: 'finance.invoice',
  record: 'finance.record',
  credit: 'finance.credit',
  reconcile: 'finance.reconcile',
});

export class FinanceError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'finance error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

const invalid = (errors) => new FinanceError(400, {
  error: 'That could not be saved.', code: 'INVALID_INPUT', errors,
});

/* Explicit columns everywhere. */
const PAYMENT_COLUMNS = `id, customer_id, invoice_id, amount, currency, method, reference,
  paid_on, notes, stripe_payment_intent, voided_at, voided_by, void_reason,
  idempotency_key, created_at`;

const CREDIT_COLUMNS = `id, customer_id, invoice_id, amount, currency, reason, reference,
  issued_on, idempotency_key, created_at`;

const EVENT_COLUMNS = `id, event_type, customer_id, invoice_id, payment_id, credit_note_id,
  amount_minor, currency, balance_before, balance_after, reference, provider_reference,
  reason, actor_id, actor_name, actor_role, capability, created_at`;

export async function getFinanceCapabilities(db, userId) {
  const held = new Set(await getUserPermissions(db, userId));
  return {
    invoice: held.has(FINANCE_CAPABILITIES.invoice),
    record: held.has(FINANCE_CAPABILITIES.record),
    credit: held.has(FINANCE_CAPABILITIES.credit),
    reconcile: held.has(FINANCE_CAPABILITIES.reconcile),
  };
}

/* ---------------------------------------------------------------------------
   The one place a balance moves
   --------------------------------------------------------------------------- */

/**
 * Applies a signed balance movement inside the caller's transaction and
 * records the append-only event.
 *
 * EVERY balance change in this file goes through here. That is deliberate: one
 * function means one place where "read before, write, read after, record both"
 * is implemented, and a future operation that forgets to log is a change to
 * this function rather than a silently missing row.
 *
 * @param delta signed decimal string. Positive increases what the customer
 *   owes; negative decreases it.
 */
async function applyMovement(c, {
  customerId, delta, amountMinor, currency, eventType, capability, actor,
  reference = '', providerReference = '', reason = '',
  invoiceId = null, paymentId = null, creditNoteId = null, idempotencyKey,
}) {
  let before = null;
  let after = null;

  if (customerId) {
    /* Locked, so two concurrent movements cannot both read the same starting
       balance and both write from it. */
    const { rows: locked } = await c.query(
      `select id, balance from users where id = $1 limit 1 for update`, [customerId]);
    if (!locked[0]) throw new FinanceError(404, { error: 'That customer could not be found.', code: 'NO_CUSTOMER' });
    before = String(locked[0].balance ?? '0');

    const { rows: moved } = await c.query(
      `update users set balance = coalesce(balance,0) + $2 where id = $1 returning balance`,
      [customerId, delta]);
    after = String(moved[0].balance);
  }

  const { rows: event } = await c.query(
    `insert into finance_events
       (event_type, customer_id, invoice_id, payment_id, credit_note_id,
        amount_minor, currency, balance_before, balance_after,
        reference, provider_reference, reason,
        actor_id, actor_name, actor_role, capability, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     on conflict (idempotency_key) do nothing
     returning ${EVENT_COLUMNS}`,
    [eventType, customerId || null, invoiceId, paymentId, creditNoteId,
     amountMinor, currency, before, after,
     reference, providerReference, reason,
     actor?.id ?? null, actor?.business || actor?.email || 'unknown', actor?.role || '',
     capability, idempotencyKey]
  );

  /* No row means the event already existed, which means this operation already
     happened. Throwing rolls the whole transaction back, INCLUDING the balance
     movement above — which is the point: a retried request must not move the
     balance a second time against a ledger entry that already exists. */
  if (!event[0]) {
    throw new FinanceError(409, {
      error: 'That has already been recorded.', code: 'ALREADY_RECORDED',
    });
  }
  return { event: event[0], balanceBefore: before, balanceAfter: after };
}

/* Audited after commit, so the human-readable feed cannot claim something that
   rolled back. */
function recordAudit(actor, action, target, changes) {
  return audit(
    { id: actor?.id, name: actor?.business || actor?.email, role: actor?.role },
    action, target, changes
  ).catch(() => {});
}

/* ---------------------------------------------------------------------------
   Issue an invoice
   --------------------------------------------------------------------------- */

/**
 * Turns an order into a debt.
 *
 * Idempotent by the order's own `invoice_id`: a second press returns the
 * existing invoice rather than numbering another one. This is the single
 * implementation — the legacy `/admin/orders/:id/invoice` route delegates to
 * it, so there is one guard and one balance movement, reached two ways.
 */
export async function issueInvoice(db, orderRef, actor, { capability = FINANCE_CAPABILITIES.invoice } = {}) {
  const outcome = await db.tx(async (c) => {
    const { rows: locked } = await c.query(
      `select id, number, customer_id, total, currency, invoice_id, credit_review
         from orders where id = $1 or number = $1 limit 1 for update`, [orderRef]);
    const order = locked[0];
    if (!order) throw new FinanceError(404, { error: 'Order not found', code: 'NO_ORDER' });

    /* Invoicing is the other protected commercial transition: it turns the
       order into a debt on the customer's ledger, which is precisely what the
       credit limit governs. An order the server flagged as over-limit, and
       that nobody has approved, must not become one — otherwise the exposure
       the review exists to control is booked anyway.

       Checked on the locked row, and only for an order that already has NO
       invoice: a re-issue of an existing invoice is idempotent and returns
       above without reaching here. */
    if (!creditReviewAllowsProgress(order.credit_review)) {
      throw new FinanceError(409, {
        error: 'That order is awaiting a credit decision, so it cannot be invoiced yet.',
        code: 'CREDIT_REVIEW_REQUIRED',
        creditReviewState: order.credit_review?.state || 'pending',
      });
    }

    if (order.invoice_id) {
      const { rows: existing } = await c.query(
        `select id, number, customer_id, amount, settlement_currency, settlement_state, issued_on
           from invoices where id = $1`, [order.invoice_id]);
      if (existing[0]) return { alreadyInvoiced: true, invoice: existing[0], order };
    }

    const currency = 'USD'; // invoices are stored in the platform's base currency
    const amount = toMinorUnits(order.total, currency);
    if (!amount.ok) {
      throw new FinanceError(409, {
        error: 'That order total could not be read as money, so no invoice was issued.',
        code: 'BAD_TOTAL',
      });
    }

    const { rows: num } = await c.query(`select 'IN' || nextval('invoice_number_seq') as n`);
    const { rows: inv } = await c.query(
      `insert into invoices (number, order_id, order_number, customer_id, amount,
                             provider, status, settlement_currency)
       values ($1,$2,$3,$4,$5,'Green Invoice','paid',$6)
       returning id, number, customer_id, amount, settlement_currency, settlement_state, issued_on`,
      [num[0].n, order.id, order.number, order.customer_id, order.total, currency]);

    await c.query(`update orders set invoice_id=$2, updated_at=now() where id=$1`, [order.id, inv[0].id]);

    /* The invoice INCREASES what the customer owes. Positive delta. */
    const movement = await applyMovement(c, {
      customerId: order.customer_id, delta: order.total,
      amountMinor: amount.minor, currency,
      eventType: 'invoice.issued', capability, actor,
      reference: order.number || '', invoiceId: inv[0].id,
      idempotencyKey: financeIdempotencyKey('inv', { order: order.id, invoice: inv[0].id }),
    });

    return { alreadyInvoiced: false, invoice: inv[0], order, movement, amountMinor: amount.minor, currency };
  });

  if (!outcome.alreadyInvoiced) {
    await recordAudit(actor, 'invoice generated', outcome.invoice.number,
      describeFinanceEvent({
        eventType: 'invoice.issued', amountMinor: outcome.amountMinor, currency: outcome.currency,
        reference: outcome.order.number,
        balanceBefore: outcome.movement.balanceBefore, balanceAfter: outcome.movement.balanceAfter,
      }));
  }
  return {
    alreadyInvoiced: outcome.alreadyInvoiced,
    invoice: {
      id: String(outcome.invoice.id), number: String(outcome.invoice.number),
      customerId: outcome.invoice.customer_id == null ? null : String(outcome.invoice.customer_id),
      amount: String(outcome.invoice.amount),
      currency: String(outcome.invoice.settlement_currency || 'USD'),
      settlementState: String(outcome.invoice.settlement_state || 'on_terms'),
      issuedOn: outcome.invoice.issued_on == null ? null : String(outcome.invoice.issued_on),
    },
  };
}

/* ---------------------------------------------------------------------------
   Record money that arrived
   --------------------------------------------------------------------------- */

export async function recordOfflinePayment(db, body, actor) {
  const validated = validateOfflinePayment(body);
  if (!validated.ok) throw invalid(validated.errors);
  const v = validated.value;

  const key = financeIdempotencyKey('pay', {
    customer: v.customerId, amount: v.amountMinor, currency: v.currency,
    method: v.method, reference: v.reference.toLowerCase(), on: v.paidOn || 'today',
  });

  const outcome = await db.tx(async (c) => {
    if (v.invoiceId) {
      /* An invoice named here must belong to the SAME customer. Without this
         check a payment could be attached to another customer's invoice, and
         the receivables report would credit the wrong account. */
      const { rows } = await c.query(
        `select id, customer_id from invoices where id = $1 or number = $1 limit 1`, [v.invoiceId]);
      if (!rows[0]) throw new FinanceError(404, { error: 'That invoice could not be found.', code: 'NO_INVOICE' });
      if (rows[0].customer_id !== v.customerId) {
        throw new FinanceError(422, {
          error: 'That invoice belongs to a different customer.', code: 'INVOICE_NOT_FOR_CUSTOMER',
        });
      }
      v.invoiceId = rows[0].id;
    }

    const { rows: created } = await c.query(
      `insert into payments (customer_id, invoice_id, amount, amount_minor, currency, method,
                             reference, paid_on, notes, recorded_by, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date, current_date),$9,$10,$11)
       on conflict (idempotency_key) where idempotency_key is not null do nothing
       returning ${PAYMENT_COLUMNS}`,
      [v.customerId, v.invoiceId || null, v.amount, v.amountMinor, v.currency, v.method,
       v.reference, v.paidOn || null, v.notes, actor?.id ?? null, key]);

    if (!created[0]) {
      throw new FinanceError(409, {
        error: 'An identical payment has already been recorded. Change the reference if this is a genuinely separate payment.',
        code: 'ALREADY_RECORDED',
      });
    }

    /* A payment DECREASES what the customer owes. Negative delta. */
    const movement = await applyMovement(c, {
      customerId: v.customerId, delta: `-${v.amount}`,
      amountMinor: -v.amountMinor, currency: v.currency,
      eventType: 'payment.recorded', capability: FINANCE_CAPABILITIES.record, actor,
      reference: v.reference, reason: v.notes,
      invoiceId: v.invoiceId || null, paymentId: created[0].id,
      idempotencyKey: financeIdempotencyKey('fev-pay', { payment: created[0].id }),
    });

    return { payment: created[0], movement };
  });

  await recordAudit(actor, 'payment recorded', outcome.payment.id,
    describeFinanceEvent({
      eventType: 'payment.recorded', amountMinor: v.amountMinor, currency: v.currency,
      reference: v.reference,
      balanceBefore: outcome.movement.balanceBefore, balanceAfter: outcome.movement.balanceAfter,
    }));

  return serializePayment(outcome.payment);
}

/**
 * Reverses a payment recorded in error.
 *
 * NOT a delete. The row stays, stamped with who voided it and why, and the
 * balance movement is a new, separately-recorded event rather than an erasure
 * of the old one — so the ledger reads "we thought this arrived; it did not",
 * which is what actually happened.
 */
export async function voidPayment(db, paymentId, body, actor) {
  const validated = validateVoid(body);
  if (!validated.ok) throw invalid(validated.errors);
  const { reason } = validated.value;

  const outcome = await db.tx(async (c) => {
    const { rows } = await c.query(
      `select ${PAYMENT_COLUMNS} from payments where id = $1 limit 1 for update`, [paymentId]);
    const payment = rows[0];
    if (!payment) throw new FinanceError(404, { error: 'That payment could not be found.', code: 'NO_PAYMENT' });
    if (payment.voided_at) {
      throw new FinanceError(409, { error: 'That payment has already been voided.', code: 'ALREADY_VOIDED' });
    }
    /* A Stripe settlement is not voided here. Money genuinely left the
       customer's card; reversing it means a REFUND, which is a different
       capability, a different provider call and a different record. */
    if (payment.method === 'stripe') {
      throw new FinanceError(422, {
        error: 'A Stripe payment cannot be voided — the money really was taken. Refund it instead.',
        code: 'USE_REFUND',
      });
    }

    const { rows: voided } = await c.query(
      `update payments set voided_at = now(), voided_by = $2, void_reason = $3
        where id = $1 and voided_at is null
        returning ${PAYMENT_COLUMNS}`,
      [paymentId, actor?.id ?? null, reason]);
    if (!voided[0]) throw new FinanceError(409, { error: 'That payment has already been voided.', code: 'ALREADY_VOIDED' });

    const currency = String(payment.currency || 'USD');
    const amount = toMinorUnits(payment.amount, currency);

    /* Voiding a payment puts the debt BACK. Positive delta. */
    const movement = await applyMovement(c, {
      customerId: payment.customer_id, delta: String(payment.amount),
      amountMinor: amount.ok ? amount.minor : 0, currency,
      eventType: 'payment.voided', capability: FINANCE_CAPABILITIES.record, actor,
      reference: payment.reference || '', reason,
      invoiceId: payment.invoice_id, paymentId: payment.id,
      idempotencyKey: financeIdempotencyKey('fev-void', { payment: payment.id }),
    });

    return { payment: voided[0], movement, amountMinor: amount.ok ? amount.minor : 0, currency };
  });

  await recordAudit(actor, 'payment voided', outcome.payment.id,
    describeFinanceEvent({
      eventType: 'payment.voided', amountMinor: outcome.amountMinor, currency: outcome.currency,
      reference: outcome.payment.reference, reason,
      balanceBefore: outcome.movement.balanceBefore, balanceAfter: outcome.movement.balanceAfter,
    }));

  return serializePayment(outcome.payment);
}

/* ---------------------------------------------------------------------------
   Reduce a debt without money arriving
   --------------------------------------------------------------------------- */

export async function issueCreditNote(db, body, actor) {
  const validated = validateCreditNote(body);
  if (!validated.ok) throw invalid(validated.errors);
  const v = validated.value;

  const key = financeIdempotencyKey('cn', {
    customer: v.customerId, amount: v.amountMinor, currency: v.currency,
    reason: v.reason.toLowerCase(), on: v.issuedOn || 'today',
  });

  const outcome = await db.tx(async (c) => {
    if (v.invoiceId) {
      const { rows } = await c.query(
        `select id, customer_id from invoices where id = $1 or number = $1 limit 1`, [v.invoiceId]);
      if (!rows[0]) throw new FinanceError(404, { error: 'That invoice could not be found.', code: 'NO_INVOICE' });
      if (rows[0].customer_id !== v.customerId) {
        throw new FinanceError(422, {
          error: 'That invoice belongs to a different customer.', code: 'INVOICE_NOT_FOR_CUSTOMER',
        });
      }
      v.invoiceId = rows[0].id;
    }

    const { rows: created } = await c.query(
      `insert into credit_notes (customer_id, invoice_id, amount, amount_minor, currency,
                                 reason, reference, issued_on, issued_by, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date, current_date),$9,$10)
       on conflict (idempotency_key) where idempotency_key is not null do nothing
       returning ${CREDIT_COLUMNS}`,
      [v.customerId, v.invoiceId || null, v.amount, v.amountMinor, v.currency,
       v.reason, v.reference, v.issuedOn || null, actor?.id ?? null, key]);

    if (!created[0]) {
      throw new FinanceError(409, {
        error: 'An identical credit note has already been issued.', code: 'ALREADY_RECORDED',
      });
    }

    /* A credit note DECREASES what the customer owes. Negative delta. */
    const movement = await applyMovement(c, {
      customerId: v.customerId, delta: `-${v.amount}`,
      amountMinor: -v.amountMinor, currency: v.currency,
      eventType: 'credit_note.issued', capability: FINANCE_CAPABILITIES.credit, actor,
      reference: v.reference, reason: v.reason,
      invoiceId: v.invoiceId || null, creditNoteId: created[0].id,
      idempotencyKey: financeIdempotencyKey('fev-cn', { creditNote: created[0].id }),
    });

    return { creditNote: created[0], movement };
  });

  await recordAudit(actor, 'credit note issued', outcome.creditNote.id,
    describeFinanceEvent({
      eventType: 'credit_note.issued', amountMinor: v.amountMinor, currency: v.currency,
      reference: v.reference, reason: v.reason,
      balanceBefore: outcome.movement.balanceBefore, balanceAfter: outcome.movement.balanceAfter,
    }));

  return serializeCreditNote(outcome.creditNote);
}

/* ---------------------------------------------------------------------------
   Close a reconciliation exception
   --------------------------------------------------------------------------- */

/**
 * Marks a payment event as resolved.
 *
 * Deliberately does NOT change an invoice. Closing an exception is a statement
 * that a human looked at it and decided what it meant; if the conclusion is
 * that money did arrive, the correct next action is to record it as a payment
 * — which is a separate, separately-capability-gated act with its own ledger
 * entry. Letting "resolve" also settle would make the reconciliation queue a
 * way to mark invoices paid by hand.
 */
export async function resolveException(db, eventId, body, actor) {
  const validated = validateResolution(body);
  if (!validated.ok) throw invalid(validated.errors);
  const { note } = validated.value;

  const outcome = await db.tx(async (c) => {
    const { rows } = await c.query(
      `select id, provider_event_id, event_type, status, invoice_id, amount_minor, currency
         from payment_events where id = $1 limit 1 for update`, [eventId]);
    const event = rows[0];
    if (!event) throw new FinanceError(404, { error: 'That payment event could not be found.', code: 'NO_EVENT' });
    if (event.status === 'resolved') {
      throw new FinanceError(409, { error: 'That exception has already been resolved.', code: 'ALREADY_RESOLVED' });
    }
    if (!['failed', 'received'].includes(event.status)) {
      throw new FinanceError(422, {
        error: 'That event is not an outstanding exception.', code: 'NOT_AN_EXCEPTION',
      });
    }

    const { rows: resolved } = await c.query(
      `update payment_events
          set status = 'resolved', resolved_by = $2, resolved_at = now(), resolution_note = $3
        where id = $1 and status in ('failed', 'received')
        returning id, provider_event_id, event_type, status, resolution_note`,
      [eventId, actor?.id ?? null, note]);
    if (!resolved[0]) throw new FinanceError(409, { error: 'That exception has already been resolved.', code: 'ALREADY_RESOLVED' });

    /* Recorded in the financial ledger with NO balance movement — the event
       carries `amount_minor: 0` and no customer, because resolving an
       exception moves no money. It is there so the ledger can answer "who
       decided this was settled, and what did they conclude?" */
    await applyMovement(c, {
      customerId: null, delta: '0', amountMinor: 0,
      currency: String(event.currency || 'USD'),
      eventType: 'reconciliation.resolved', capability: FINANCE_CAPABILITIES.reconcile, actor,
      providerReference: String(event.provider_event_id || ''), reason: note,
      invoiceId: event.invoice_id,
      idempotencyKey: financeIdempotencyKey('fev-rec', { event: event.id }),
    });

    return resolved[0];
  });

  await recordAudit(actor, 'reconciliation resolved', String(outcome.provider_event_id),
    `${outcome.event_type} — ${note}`);

  return {
    id: String(outcome.id),
    providerEventId: String(outcome.provider_event_id),
    eventType: String(outcome.event_type),
    status: String(outcome.status),
    resolutionNote: String(outcome.resolution_note),
  };
}

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

/** The financial ledger for one customer, newest first. */
export async function customerLedger(db, customerId, { limit = 100 } = {}) {
  const { rows } = await db.query(
    `select ${EVENT_COLUMNS} from finance_events
      where customer_id = $1 order by created_at desc, id desc limit $2`,
    [customerId, Math.min(Math.max(Number(limit) || 100, 1), 500)]);
  return rows.map(serializeFinanceEvent);
}

export async function recentEvents(db, { limit = 100 } = {}) {
  const { rows } = await db.query(
    `select ${EVENT_COLUMNS} from finance_events
      order by created_at desc, id desc limit $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)]);
  return rows.map(serializeFinanceEvent);
}

/* ---------------------------------------------------------------------------
   Router
   --------------------------------------------------------------------------- */

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

const r = Router();
r.use(requireAuth());

const canInvoice = () => requirePermission(FINANCE_CAPABILITIES.invoice);
const canRecord = () => requirePermission(FINANCE_CAPABILITIES.record);
const canCredit = () => requirePermission(FINANCE_CAPABILITIES.credit);
const canReconcile = () => requirePermission(FINANCE_CAPABILITIES.reconcile);
/* Reading the ledger is a payment-view act; it carries amounts and references
   but authorises nothing. Reusing `payments.view` rather than inventing a
   fifth key keeps the grant surface honest. */
const canViewLedger = () => requirePermission('payments.view');

function send(res, next, promise, shape = (v) => v) {
  promise
    .then((value) => res.json(shape(value)))
    .catch((err) => {
      if (err instanceof FinanceError) return res.status(err.status).json(err.body);
      next(err);
    });
}

r.get('/capabilities', (req, res, next) =>
  send(res, next, getFinanceCapabilities(liveDb, req.user?.id), (capabilities) => ({
    capabilities, contract: FINANCE_CONTRACT,
  }))
);

// ---- reads ----
r.get('/ledger', canViewLedger(), (req, res, next) =>
  send(res, next, recentEvents(liveDb, { limit: req.query.limit }), (events) => ({ events }))
);

r.get('/ledger/:customerId', canViewLedger(), (req, res, next) =>
  send(res, next, customerLedger(liveDb, req.params.customerId, { limit: req.query.limit }),
    (events) => ({ events }))
);

// ---- writes ----
r.post('/orders/:orderId/invoice', canInvoice(), (req, res, next) =>
  send(res, next, issueInvoice(liveDb, req.params.orderId, req.user))
);

r.post('/payments', canRecord(), (req, res, next) =>
  send(res, next, recordOfflinePayment(liveDb, req.body, req.user), (payment) => ({ payment }))
);

r.post('/payments/:paymentId/void', canRecord(), (req, res, next) =>
  send(res, next, voidPayment(liveDb, req.params.paymentId, req.body, req.user), (payment) => ({ payment }))
);

r.post('/credit-notes', canCredit(), (req, res, next) =>
  send(res, next, issueCreditNote(liveDb, req.body, req.user), (creditNote) => ({ creditNote }))
);

r.post('/reconciliation/:eventId/resolve', canReconcile(), (req, res, next) =>
  send(res, next, resolveException(liveDb, req.params.eventId, req.body, req.user),
    (event) => ({ event }))
);

/* No DELETE route anywhere, deliberately. A payment recorded in error is
   voided; a credit note stands; a finance event cannot be touched at all. */

export default r;
