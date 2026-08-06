/* Customer payment routes and the Stripe webhook (Final Handover, Phase 3).

   Two very different surfaces in one file, because they are two halves of one
   flow and reading them together is how the security model stays obvious:

     - `/user/invoices/:id/payment`        a customer reads their own invoice's
       `/user/invoices/:id/pay`            payment state, and asks for a link
     - `/webhooks/stripe`                  Stripe tells Veyora what happened

   THE ASYMMETRY IS THE POINT. The customer routes are authenticated and can
   REQUEST a payment; they cannot report one. The webhook is unauthenticated in
   the session sense and signature-verified instead, and it is the only thing
   in the platform that may settle an invoice.

   A customer arriving on the success page proves that a browser followed a
   redirect. It is not evidence that money moved, so the success page reads the
   invoice's real state and says "confirming" until a webhook says otherwise.
*/

import { Router } from 'express';
import { pool, tx as realTx } from '../db.js';
import { requireAuth } from '../authmw.js';
import { stripeConfig, publicView } from '../payments/stripe-config.js';
import { getStripeClient } from '../payments/client-instance.js';
import { PaymentError, createOrGetSession, getInvoicePaymentState } from '../payments/sessions.js';
import { processEvent, verifyEvent, WebhookError } from '../payments/webhook.js';
import { assessPayability, serializeInvoicePayment } from '../payments/invoice-payments.js';

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

/* ---------------------------------------------------------------------------
   Customer routes — mounted on /user
   --------------------------------------------------------------------------- */

export const customerPaymentRoutes = Router();
customerPaymentRoutes.use(requireAuth());

function send(res, next, promise, shape = (v) => v) {
  promise
    .then((value) => res.json(shape(value)))
    .catch((err) => {
      if (err instanceof PaymentError) return res.status(err.status).json(err.body);
      next(err);
    });
}

/**
 * The payment state of ONE of the caller's own invoices.
 *
 * `customerId` is taken from the session, so an invoice belonging to somebody
 * else is a 404 — the same answer as an invoice that does not exist, because
 * distinguishing them would confirm the existence of another customer's
 * records to anyone enumerating ids.
 *
 * Returns a payability verdict with a REASON, so the storefront can say
 * "already paid", "being confirmed" or "payable on your usual account terms"
 * rather than showing a disabled button with no explanation.
 */
customerPaymentRoutes.get('/invoices/:invoiceId/payment', (req, res, next) =>
  send(res, next,
    getInvoicePaymentState(liveDb, req.params.invoiceId, { customerId: req.user?.id }),
    (state) => {
      if (!state) return { error: 'That invoice could not be found.' };
      const config = stripeConfig();
      const verdict = assessPayability(state.invoice, { stripeEnabled: config.enabled });
      return {
        payment: serializeInvoicePayment(state.invoice, {
          session: state.session,
          /* The customer paying their own invoice is exactly who the hosted
             link is for — but only while it is still open. A completed or
             expired session's URL is not handed back. */
          includeUrl: state.session?.status === 'open',
        }),
        payable: verdict.payable,
        reason: verdict.reason,
        code: verdict.code,
        stripe: publicView(config),
      };
    })
);

/**
 * Asks for a secure hosted payment link for the caller's own invoice.
 *
 * The body is IGNORED entirely — there is no amount, no currency and no
 * invoice reference in it. Everything comes from the path and from the invoice
 * row read inside the transaction.
 */
customerPaymentRoutes.post('/invoices/:invoiceId/pay', (req, res, next) =>
  send(res, next,
    createOrGetSession(liveDb, getStripeClient(), stripeConfig(), req.params.invoiceId, req.user,
      { isCustomer: true }),
    ({ session, invoice, reused }) => ({
      reused,
      payment: serializeInvoicePayment(invoice, { session, includeUrl: true }),
    }))
);

/* ---------------------------------------------------------------------------
   The webhook — mounted on its own path, with a RAW body parser
   --------------------------------------------------------------------------- */

export const stripeWebhookRoutes = Router();

/**
 * Receives one Stripe event.
 *
 * MOUNTED WITH `express.raw()` IN index.js, before the JSON parser. The
 * signature is computed over the exact bytes Stripe sent; `express.json()`
 * parses and discards them, and re-serialising the object changes whitespace
 * and key order, so the signature would never verify again. That mounting
 * order is load-bearing and a test asserts it.
 *
 * RESPONSE POLICY
 *
 *   200 — accepted. Includes duplicates, ignored event types and events that
 *         could not be applied: all of those are recorded, and asking Stripe
 *         to retry would not change the outcome. A failure to apply becomes a
 *         reconciliation exception for a human, not an endless retry loop.
 *   400 — the signature did not verify, or the body was not raw. Never
 *         retried, and the response says nothing about which.
 *   500 — Veyora itself failed (the database is down). Stripe SHOULD retry.
 */
stripeWebhookRoutes.post('/stripe', async (req, res) => {
  const config = stripeConfig();
  if (!config.enabled) {
    /* 404, not 403: an endpoint for a provider that is not configured should
       not confirm that it exists and is merely switched off. */
    return res.status(404).json({ error: 'not found' });
  }

  let event;
  try {
    event = verifyEvent(getStripeClient(), req.body, req.get('stripe-signature'), config.webhookSecret);
  } catch (err) {
    /* Logged as a COUNT and a code. Never the body — an unverified payload is
       attacker-controlled input, and putting it in a log file is how a log
       viewer becomes an injection target. */
    console.warn(`[payments] rejected a webhook: ${err instanceof WebhookError ? err.code : 'INVALID'}`);
    return res.status(400).json({ error: 'invalid signature' });
  }

  try {
    const outcome = await processEvent(liveDb, event);
    /* The event TYPE and outcome only. No amount, no customer, no payload. */
    if (outcome.status === 'failed') {
      console.warn(`[payments] event ${event.type} could not be applied: ${outcome.code}`);
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('[payments] webhook processing failed:', err?.code || err?.message || 'unknown');
    return res.status(500).json({ error: 'processing failed' });
  }
});

export default customerPaymentRoutes;
