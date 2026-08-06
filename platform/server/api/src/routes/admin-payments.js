/* Governed payment operations API (Final Handover, Phase 3).

   Mounted at /admin/payments, BEFORE the general /admin router, so this
   router's own capability gates run. The general router admits several roles
   for operational work; none of them has any business moving money.

   AUTHORITY — FOUR CAPABILITIES, NOT ONE

     - `payments.view`      — read payment state and provider references
     - `payments.collect`   — create or re-send a secure payment link
     - `payments.refund`    — send money back
     - `payments.reconcile` — review events that could not be applied

   These are four genuinely different jobs. Seeing that an invoice was paid,
   asking a customer to pay, sending money back, and correcting the books are
   not the same authority, and the person who does one frequently must not
   thereby be able to do the others. There is no role fallback: an `admin` role
   alone satisfies nothing here, and none of the four is granted by any
   migration.

   WHAT THIS API CANNOT DO

     - It cannot mark an invoice paid. There is no route that sets
       `settlement_state = 'paid'`; only a verified webhook does that. An
       operator who believes a payment arrived must reconcile it, not assert it.
     - It cannot take a card. No card field exists anywhere in Veyora; the
       customer enters their details on Stripe's hosted page.
     - It cannot set an amount. Every amount comes from the invoice row.
     - It cannot return a secret. No secret key, no webhook secret, no raw
       provider event.
     - It cannot refund on a customer's say-so. A refund needs
       `payments.refund`, an explicit confirmation and a stated reason.
*/

import { Router } from 'express';
import { pool, tx as realTx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { requirePermission, getUserPermissions } from '../permissions.js';
import { stripeConfig, publicView } from '../payments/stripe-config.js';
import { getStripeClient } from '../payments/client-instance.js';
import { PaymentError, createOrGetSession, getInvoicePaymentState } from '../payments/sessions.js';
import { reconciliationExceptions } from '../payments/webhook.js';
import {
  fromMinorUnits, refundIdempotencyKey, serializeInvoicePayment, toMinorUnits,
} from '../payments/invoice-payments.js';

export const PAYMENT_CAPABILITIES = Object.freeze({
  view: 'payments.view',
  collect: 'payments.collect',
  refund: 'payments.refund',
  reconcile: 'payments.reconcile',
});

/* Same reasoning as the enquiry and contact routers: the session carries no
   capabilities, a 200/403 probe on a gated route cannot distinguish four of
   them, and finding out whether you may refund by attempting one is not an
   option. Authenticated but ungated, so an account holding none gets an honest
   all-false answer and the UI renders an accurate no-access state. */
export async function getPaymentCapabilities(db, userId) {
  const held = new Set(await getUserPermissions(db, userId));
  return {
    view: held.has(PAYMENT_CAPABILITIES.view),
    collect: held.has(PAYMENT_CAPABILITIES.collect),
    refund: held.has(PAYMENT_CAPABILITIES.refund),
    reconcile: held.has(PAYMENT_CAPABILITIES.reconcile),
  };
}

const MAX_REASON_LENGTH = 500;

/* ---------------------------------------------------------------------------
   Refunds
   --------------------------------------------------------------------------- */

/**
 * Sends money back for a settled invoice.
 *
 * Five refusals before anything moves:
 *
 *   - the invoice must exist and be settled;
 *   - a reason must be given, and be real text rather than a space;
 *   - the amount must be positive and within what remains refundable;
 *   - the caller must have confirmed explicitly (`confirm: true` in the body,
 *     which the UI only sends after a typed confirmation) — a refund reached
 *     by a mis-click is money gone;
 *   - the provider must accept it. Nothing is recorded as refunded until it
 *     does.
 */
export async function refundInvoice(db, stripe, invoiceRef, body, actor, { now = new Date() } = {}) {
  const reason = String(body?.reason ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (reason.length < 3 || reason.length > MAX_REASON_LENGTH) {
    throw new PaymentError(400, {
      error: 'A refund needs a stated reason of between 3 and 500 characters.',
      code: 'REASON_REQUIRED',
    });
  }
  if (body?.confirm !== true) {
    throw new PaymentError(400, {
      error: 'A refund must be confirmed explicitly.',
      code: 'CONFIRMATION_REQUIRED',
    });
  }

  const prepared = await db.tx(async (c) => {
    const { rows } = await c.query(
      `select id, number, customer_id, amount, settlement_state, settlement_currency,
              amount_settled_minor, amount_refunded_minor, settlement_reference
         from invoices where id = $1 or number = $1 limit 1 for update`,
      [invoiceRef]
    );
    const invoice = rows[0];
    if (!invoice) throw new PaymentError(404, { error: 'That invoice could not be found.', code: 'NOT_FOUND' });
    if (invoice.settlement_state !== 'paid' && invoice.settlement_state !== 'refunded') {
      throw new PaymentError(409, {
        error: 'This invoice has not been settled online, so there is nothing to refund.',
        code: 'NOT_SETTLED',
      });
    }

    const settled = Number(invoice.amount_settled_minor);
    const alreadyRefunded = Number(invoice.amount_refunded_minor);
    const remaining = settled - alreadyRefunded;
    if (remaining <= 0) {
      throw new PaymentError(409, { error: 'This invoice has already been refunded in full.', code: 'FULLY_REFUNDED' });
    }

    /* An absent amount means "all of what is left". An amount that was sent is
       validated as money, never coerced — `Number('12.5.3')` is NaN and
       `parseInt` would happily return 12. */
    let amountMinor = remaining;
    if (body?.amount != null && body.amount !== '') {
      const parsed = toMinorUnits(body.amount, invoice.settlement_currency);
      if (!parsed.ok) {
        throw new PaymentError(400, { error: 'That refund amount could not be read as money.', code: 'BAD_AMOUNT' });
      }
      amountMinor = parsed.minor;
    }
    if (amountMinor <= 0) {
      throw new PaymentError(400, { error: 'A refund must be for more than zero.', code: 'BAD_AMOUNT' });
    }
    if (amountMinor > remaining) {
      throw new PaymentError(409, {
        error: `That is more than remains refundable on this invoice (${fromMinorUnits(remaining, invoice.settlement_currency)} ${invoice.settlement_currency}).`,
        code: 'EXCEEDS_REMAINING',
      });
    }

    const key = refundIdempotencyKey({
      invoiceId: invoice.id, amountMinor,
      currency: invoice.settlement_currency, attempt: alreadyRefunded,
    });

    /* Reserved before the provider is contacted, so a failure leaves a visible
       `pending` row rather than nothing. */
    const { rows: created } = await c.query(
      `insert into payment_refunds
         (invoice_id, amount_minor, currency, reason, authorised_by, idempotency_key)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (idempotency_key) do nothing
       returning id, invoice_id, amount_minor, currency, status, idempotency_key`,
      [invoice.id, amountMinor, invoice.settlement_currency, reason, actor?.id ?? null, key]
    );
    if (!created[0]) {
      throw new PaymentError(409, {
        error: 'An identical refund is already being processed.',
        code: 'REFUND_IN_FLIGHT',
      });
    }
    return { refund: created[0], invoice };
  });

  const { refund, invoice } = prepared;
  try {
    const result = await stripe.createRefund({
      payment_intent: invoice.settlement_reference,
      amount: Number(refund.amount_minor),
      metadata: { veyoraInvoiceId: invoice.id, veyoraInvoiceNumber: invoice.number },
    }, { idempotencyKey: refund.idempotency_key || `rf_${refund.id}` });

    const applied = await db.tx(async (c) => {
      await c.query(
        `update payment_refunds set status = 'succeeded', provider_refund_id = $2, last_error = ''
          where id = $1`,
        [refund.id, result.id]
      );
      const { rows } = await c.query(
        `update invoices
            set amount_refunded_minor = amount_refunded_minor + $2,
                settlement_state = case when amount_refunded_minor + $2 >= amount_settled_minor
                                        then 'refunded' else settlement_state end
          where id = $1
          returning id, settlement_state, amount_refunded_minor, amount_settled_minor`,
        [invoice.id, Number(refund.amount_minor)]
      );
      return rows[0];
    });

    /* The reason is recorded in the audit log deliberately: it is a staff
       statement about a business decision, not a customer's personal data, and
       a refund nobody can explain later is the reason this field is mandatory. */
    await audit(
      { id: actor?.id, name: actor?.business || actor?.email, role: actor?.role },
      'payment.refund',
      `invoice:${invoice.number}`,
      `${fromMinorUnits(refund.amount_minor, refund.currency)} ${refund.currency} refunded — ${reason}`
    ).catch(() => {});

    return {
      refundId: String(refund.id),
      amountMinor: Number(refund.amount_minor),
      currency: String(refund.currency),
      status: 'succeeded',
      providerReference: String(result.id),
      settlementState: String(applied?.settlement_state ?? ''),
    };
  } catch (err) {
    await db.query(
      `update payment_refunds set status = 'failed', last_error = $2 where id = $1`,
      [refund.id, String(err?.code || 'PROVIDER_ERROR').slice(0, 200)]
    ).catch(() => {});
    if (err instanceof PaymentError) throw err;
    throw new PaymentError(502, {
      error: 'The payment provider refused the refund. Nothing was sent — the attempt is recorded.',
      code: 'REFUND_FAILED',
    });
  }
}

/* ---------------------------------------------------------------------------
   Router
   --------------------------------------------------------------------------- */

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

const r = Router();
r.use(requireAuth());

const canView = () => requirePermission(PAYMENT_CAPABILITIES.view);
const canCollect = () => requirePermission(PAYMENT_CAPABILITIES.collect);
const canRefund = () => requirePermission(PAYMENT_CAPABILITIES.refund);
const canReconcile = () => requirePermission(PAYMENT_CAPABILITIES.reconcile);

function send(res, next, promise, shape = (v) => v) {
  promise
    .then((value) => res.json(shape(value)))
    .catch((err) => {
      if (err instanceof PaymentError) return res.status(err.status).json(err.body);
      next(err);
    });
}

/* Capability discovery, plus whether payments are configured at all. The
   `stripe` block is `publicView()` — enabled, mode and a reason. No key of any
   kind, and `testMode` is surfaced on purpose so a test-mode deployment says
   so loudly rather than looking live. */
r.get('/capabilities', (req, res, next) =>
  send(res, next, getPaymentCapabilities(liveDb, req.user?.id), (capabilities) => ({
    capabilities,
    stripe: publicView(stripeConfig()),
  }))
);

// ---- reads ----
r.get('/invoice/:invoiceId', canView(), (req, res, next) =>
  send(res, next, getInvoicePaymentState(liveDb, req.params.invoiceId), (state) => {
    if (!state) return { error: 'That invoice could not be found.' };
    return {
      payment: serializeInvoicePayment(state.invoice, {
        session: state.session,
        /* The hosted link is a bearer URL. A viewer sees the STATE and the
           provider reference; only a holder of payments.collect gets the link
           itself, from the collect route below. */
        includeUrl: false,
      }),
    };
  })
);

r.get('/reconciliation', canReconcile(), (req, res, next) =>
  send(res, next, reconciliationExceptions(liveDb, { limit: 50 }), (exceptions) => ({ exceptions }))
);

// ---- collect ----
/* Creates the link, or returns the live one. Idempotent by construction: a
   second press finds the reusable session rather than opening another. */
r.post('/invoice/:invoiceId/collect', canCollect(), (req, res, next) =>
  send(res, next,
    createOrGetSession(liveDb, getStripeClient(), stripeConfig(), req.params.invoiceId, req.user),
    ({ session, invoice, reused }) => ({
      reused,
      payment: serializeInvoicePayment(invoice, { session, includeUrl: true }),
    }))
);

// ---- refund ----
r.post('/invoice/:invoiceId/refund', canRefund(), (req, res, next) =>
  send(res, next,
    refundInvoice(liveDb, getStripeClient(), req.params.invoiceId, req.body, req.user),
    (refund) => ({ refund }))
);

/* No route marks an invoice paid, deliberately. Only a verified webhook does
   that — see src/payments/webhook.js. */

export default r;
