/* The Stripe client boundary (Final Handover, Phase 3).
 *
 * ONE narrow interface, four methods, and two implementations of it: a real
 * one backed by the official SDK, and a controllable one for tests.
 *
 * WHY A BOUNDARY RATHER THAN CALLING THE SDK DIRECTLY
 *
 * Every module above this one is written against `{ createCheckoutSession,
 * retrieveCheckoutSession, createRefund, constructEvent }` and knows nothing
 * about the SDK. Three things follow:
 *
 *   - NO TEST CONTACTS STRIPE. The session and webhook logic is driven by an
 *     injected client, so the whole payment lifecycle — including expiry,
 *     duplicate events and amount mismatches — is exercised deterministically
 *     with no network and no key.
 *   - The SDK is constructed LAZILY and only when Stripe is enabled. An API
 *     with no Stripe configuration never instantiates it.
 *   - Replacing or upgrading the SDK is a change to this file.
 *
 * WHY THE OFFICIAL SDK AND NOT A HAND-BUILT CLIENT
 *
 * This repository has a strong precedent for hand-built writers
 * (`src/xlsx-lite.js`). It was rejected here for one reason: `constructEvent`.
 * Webhook verification is an HMAC over a timestamped payload with a tolerance
 * window and a timing-safe comparison, and it is the ONLY thing standing
 * between the internet and "this invoice is paid". A subtly wrong
 * reimplementation of it does not fail loudly; it accepts forged events.
 */

import { STRIPE_API_VERSION } from './stripe-config.js';

export class StripeClientError extends Error {
  constructor(message, { code = 'STRIPE_ERROR', retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** Raised when a webhook signature does not verify. Separate from every other
 *  failure because the response is different: a bad signature is a 400 and is
 *  never retried, whereas a transient provider error should be. */
export class StripeSignatureError extends StripeClientError {
  constructor(message) {
    super(message, { code: 'INVALID_SIGNATURE', retryable: false });
  }
}

/* ---------------------------------------------------------------------------
   The real client
   --------------------------------------------------------------------------- */

/**
 * Builds a client over the official SDK.
 *
 * @param config a resolved, enabled Stripe configuration.
 * @param StripeCtor injected so the module can be imported and unit-tested
 *   without the SDK being constructed. Production passes the real one.
 */
export function createStripeClient(config, StripeCtor) {
  if (!config?.enabled) {
    throw new StripeClientError('Stripe is not enabled; no client may be created.', { code: 'DISABLED' });
  }
  const stripe = new StripeCtor(config.secretKey, {
    apiVersion: config.apiVersion || STRIPE_API_VERSION,
    /* Bounded. A payment route that hangs for the default timeout holds a
       request open long enough for an operator to press the button again. */
    timeout: 20_000,
    maxNetworkRetries: 2,
  });

  return {
    mode: config.mode,

    async createCheckoutSession(params, { idempotencyKey }) {
      try {
        const s = await stripe.checkout.sessions.create(params, { idempotencyKey });
        return normaliseSession(s);
      } catch (err) {
        throw wrap(err);
      }
    },

    async retrieveCheckoutSession(sessionId) {
      try {
        return normaliseSession(await stripe.checkout.sessions.retrieve(sessionId));
      } catch (err) {
        throw wrap(err);
      }
    },

    async createRefund(params, { idempotencyKey }) {
      try {
        const r = await stripe.refunds.create(params, { idempotencyKey });
        return normaliseRefund(r);
      } catch (err) {
        throw wrap(err);
      }
    },

    /** Verifies and parses a webhook. `rawBody` must be the exact bytes
     *  received — any re-serialisation changes the signature. */
    constructEvent(rawBody, signatureHeader, webhookSecret) {
      try {
        return stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
      } catch (err) {
        throw new StripeSignatureError(err?.message || 'signature verification failed');
      }
    },
  };
}

/* A provider error is retryable when it is about the connection rather than
   about the request. Retrying a card decline forever helps nobody; retrying a
   timeout is exactly right. */
function wrap(err) {
  const type = err?.type || '';
  const retryable = type === 'StripeConnectionError' || type === 'StripeAPIError'
    || type === 'StripeRateLimitError';
  return new StripeClientError(err?.message || 'Stripe request failed', {
    code: err?.code || type || 'STRIPE_ERROR',
    retryable,
  });
}

/* ---------------------------------------------------------------------------
   Normalisation — the shape everything above this file sees
   --------------------------------------------------------------------------- */

/* An allowlist, not a passthrough. A Stripe session carries the customer's
   name, email, address and card metadata; none of that is needed to settle an
   invoice, and returning it would let it drift into a log line or a response.
   `payment_intent` and `payment_status` are strings even when Stripe expands
   them into objects. */
export function normaliseSession(s) {
  const intent = s?.payment_intent;
  return {
    id: String(s?.id ?? ''),
    status: String(s?.status ?? ''),                 // open | complete | expired
    paymentStatus: String(s?.payment_status ?? ''),  // unpaid | paid | no_payment_required
    amountTotalMinor: s?.amount_total == null ? null : Number(s.amount_total),
    currency: String(s?.currency ?? '').toUpperCase(),
    paymentIntentId: typeof intent === 'string' ? intent : String(intent?.id ?? ''),
    url: String(s?.url ?? ''),
    expiresAt: s?.expires_at == null ? null : Number(s.expires_at),
    /* Only the two keys Veyora set. Metadata is caller-controlled on Stripe's
       side, so it is read narrowly rather than trusted wholesale. */
    metadata: {
      veyoraInvoiceId: String(s?.metadata?.veyoraInvoiceId ?? ''),
      veyoraInvoiceNumber: String(s?.metadata?.veyoraInvoiceNumber ?? ''),
    },
  };
}

export function normaliseRefund(r) {
  return {
    id: String(r?.id ?? ''),
    status: String(r?.status ?? ''),
    amountMinor: r?.amount == null ? null : Number(r.amount),
    currency: String(r?.currency ?? '').toUpperCase(),
    paymentIntentId: typeof r?.payment_intent === 'string' ? r.payment_intent : String(r?.payment_intent?.id ?? ''),
  };
}

/* ---------------------------------------------------------------------------
   The disabled client
   --------------------------------------------------------------------------- */

/**
 * What every route gets when Stripe is not configured.
 *
 * It REFUSES rather than pretending. There is no offline mode, no queued
 * payment and no optimistic success — showing a customer a payment succeeded
 * when no provider was ever contacted is the worst failure available to this
 * subsystem, so the disabled path cannot express success at all.
 */
export function createDisabledStripeClient(reason = 'Stripe is not configured.') {
  const refuse = () => {
    throw new StripeClientError(reason, { code: 'STRIPE_DISABLED', retryable: false });
  };
  return {
    mode: 'disabled',
    enabled: false,
    createCheckoutSession: refuse,
    retrieveCheckoutSession: refuse,
    createRefund: refuse,
    constructEvent: refuse,
  };
}
