/* Invoice payment model (Final Handover, Phase 3).

   Pure and dependency-free: no database, no driver, no request object, no
   Stripe. Every rule below is testable without a server or a key.

   This module owns four things:

     1. WHICH SETTLEMENT STATES EXIST and which of them an invoice may be paid
        from. The payable set is a closed allowlist — an expired, paid,
        refunded or void invoice cannot start a new payment, and the rule is
        stated once rather than re-derived at each call site.

     2. MONEY IN MINOR UNITS. `toMinorUnits()` is the only conversion from the
        `numeric(12,2)` the invoices table holds to the integer Stripe speaks,
        and it refuses anything it cannot convert exactly. Every conversion
        between money representations is a chance to be out by a factor of a
        hundred on somebody's money, so there is exactly one of them.

     3. WHAT AN INVOICE LOOKS LIKE ON THE WAY OUT. Two serializers, both
        building fresh object literals with fixed keys, and neither ever
        returning a secret, a hosted URL to a caller who may not have it, or a
        raw provider object.

     4. THE IDEMPOTENCY KEY. Server-generated and derived from the invoice and
        its amount, so a double-click produces the same key and collides
        instead of opening a second payment session.
*/

import { createHash } from 'node:crypto';

/* ---------------------------------------------------------------------------
   Settlement states
   --------------------------------------------------------------------------- */

export const SETTLEMENT_STATES = Object.freeze([
  'on_terms',   // issued and outstanding on account terms — the normal state
  'processing', // a hosted session completed; awaiting the confirming webhook
  'paid',       // settled, evidenced by a provider reference
  'refunded',   // settled and since returned, in whole or in part
  'void',       // cancelled; never collectable
]);

/** The states from which a NEW payment session may be opened.
 *
 *  `processing` is deliberately absent. A completed session awaiting its
 *  webhook must not be joined by a second link, or the customer can pay twice
 *  and Veyora finds out from a reconciliation exception rather than from a
 *  refusal. */
export const PAYABLE_STATES = Object.freeze(['on_terms']);

export const isSettlementState = (v) => typeof v === 'string' && SETTLEMENT_STATES.includes(v);

/* Currencies the payment path accepts, mirroring src/currency.js. A currency
   outside this set is refused rather than passed through: Stripe would take it
   and Veyora's own conversion would then have no rate for it. */
export const PAYMENT_CURRENCIES = Object.freeze(['USD', 'CAD', 'EUR']);

/* Zero-decimal currencies have no minor unit at all — 100 JPY is `100`, not
   `10000`. None of the three above is one, but the table is here so that
   adding a currency is a change to a list rather than a silent hundred-fold
   error. */
const ZERO_DECIMAL = Object.freeze(new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']));

export function minorUnitFactor(currency) {
  return ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? 1 : 100;
}

/**
 * Converts a decimal money amount to integer minor units.
 *
 * REFUSES rather than rounds. `pg` returns `numeric` as a string precisely so
 * no precision is lost on the way out; parsing it into a float and multiplying
 * reintroduces exactly the error the string was protecting against. An amount
 * with more precision than the currency has is a bug upstream, and quietly
 * rounding it would hide the bug and mis-charge by a cent.
 *
 * @returns `{ ok: true, minor }` or `{ ok: false, reason }`.
 */
export function toMinorUnits(amount, currency) {
  const factor = minorUnitFactor(currency);
  const raw = typeof amount === 'number' ? amount.toString() : String(amount ?? '').trim();
  if (raw === '') return { ok: false, reason: 'EMPTY_AMOUNT' };
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return { ok: false, reason: 'NOT_A_DECIMAL' };

  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace('-', '').split('.');
  const places = factor === 1 ? 0 : 2;
  if (fraction.length > places) {
    /* Trailing zeros beyond the currency's precision are harmless; anything
       else is real precision that cannot be represented. */
    if (!/^0*$/.test(fraction.slice(places))) return { ok: false, reason: 'TOO_PRECISE' };
  }
  const padded = (fraction + '0'.repeat(places)).slice(0, places);
  const minor = Number(whole) * factor + (places ? Number(padded) : 0);
  if (!Number.isSafeInteger(minor)) return { ok: false, reason: 'OUT_OF_RANGE' };
  return { ok: true, minor: negative ? -minor : minor };
}

/** The inverse, for display only. Never used to decide anything. */
export function fromMinorUnits(minor, currency) {
  const factor = minorUnitFactor(currency);
  if (factor === 1) return String(Math.trunc(Number(minor) || 0));
  const n = Number(minor) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------------------
   Payability
   --------------------------------------------------------------------------- */

/**
 * Decides whether an invoice may be paid online, and says why not when it may
 * not.
 *
 * Every refusal carries a code AND a sentence written for the person reading
 * it, because this is rendered to a customer. "Cannot pay" with no reason is
 * how a support call starts.
 */
export function assessPayability(invoice, { stripeEnabled = true, now = new Date() } = {}) {
  const state = String(invoice?.settlement_state ?? 'on_terms');
  const currency = String(invoice?.settlement_currency ?? 'USD').toUpperCase();

  if (!invoice) {
    return { payable: false, code: 'NOT_FOUND', reason: 'That invoice could not be found.' };
  }
  if (!stripeEnabled) {
    /* Not an error and not a failure — online payment is simply switched off.
       The invoice is still payable by transfer on the usual terms, and saying
       so is the difference between a clear message and an apparent outage. */
    return {
      payable: false, code: 'PAYMENT_DISABLED',
      reason: 'Online payment is not available. This invoice is payable on your usual account terms.',
    };
  }
  if (state === 'paid') {
    return { payable: false, code: 'ALREADY_PAID', reason: 'This invoice has already been paid.' };
  }
  if (state === 'processing') {
    return {
      payable: false, code: 'PAYMENT_PENDING',
      reason: 'A payment for this invoice is being confirmed. This usually takes a moment; refresh to check.',
    };
  }
  if (state === 'refunded') {
    return { payable: false, code: 'REFUNDED', reason: 'This invoice was paid and has since been refunded.' };
  }
  if (state === 'void') {
    return { payable: false, code: 'VOID', reason: 'This invoice has been cancelled and is not payable.' };
  }
  if (!PAYABLE_STATES.includes(state)) {
    return { payable: false, code: 'NOT_PAYABLE', reason: 'This invoice is not payable online.' };
  }
  if (!PAYMENT_CURRENCIES.includes(currency)) {
    return {
      payable: false, code: 'UNSUPPORTED_CURRENCY',
      reason: 'This invoice is in a currency that cannot be paid online.',
    };
  }

  const amount = toMinorUnits(invoice.amount, currency);
  if (!amount.ok) {
    return { payable: false, code: 'AMOUNT_UNREADABLE', reason: 'This invoice cannot be paid online. Please contact us.' };
  }
  if (amount.minor <= 0) {
    return { payable: false, code: 'NOTHING_TO_PAY', reason: 'There is nothing outstanding on this invoice.' };
  }

  return { payable: true, code: 'PAYABLE', reason: '', amountMinor: amount.minor, currency };
}

/**
 * Whether an existing session can still be handed back to a customer.
 *
 * A session is reusable while it is open and unexpired. Anything else — a
 * completed one, an expired one, one whose amount no longer matches the
 * invoice — is superseded rather than reused, because handing a customer a
 * link for the wrong amount is worse than making them wait for a new one.
 */
export function isSessionReusable(session, { amountMinor, currency, now = new Date() } = {}) {
  if (!session) return false;
  if (session.status !== 'open') return false;
  if (!session.hosted_url) return false;
  if (Number(session.amount_minor) !== Number(amountMinor)) return false;
  if (String(session.currency).toUpperCase() !== String(currency).toUpperCase()) return false;
  if (session.expires_at && new Date(session.expires_at).getTime() <= now.getTime()) return false;
  return true;
}

/* ---------------------------------------------------------------------------
   Idempotency
   --------------------------------------------------------------------------- */

/**
 * The server's idempotency key for a payment session.
 *
 * Derived from the invoice, the amount and the currency — never from anything
 * a caller sent — so two identical requests produce the same key and the
 * unique constraint refuses the second. `attempt` lets a deliberate,
 * superseding retry produce a genuinely new key after the previous session was
 * closed off.
 *
 * Hashed rather than concatenated so the key carries no invoice number into
 * Stripe's idempotency store.
 */
export function sessionIdempotencyKey({ invoiceId, amountMinor, currency, attempt = 0 }) {
  return `ps_${createHash('sha256')
    .update(`${invoiceId}|${amountMinor}|${String(currency).toUpperCase()}|${attempt}`)
    .digest('hex')
    .slice(0, 48)}`;
}

export function refundIdempotencyKey({ invoiceId, amountMinor, currency, attempt = 0 }) {
  return `rf_${createHash('sha256')
    .update(`${invoiceId}|${amountMinor}|${String(currency).toUpperCase()}|${attempt}`)
    .digest('hex')
    .slice(0, 48)}`;
}

/* ---------------------------------------------------------------------------
   Serializers — fresh object literals, fixed keys, never a spread row
   --------------------------------------------------------------------------- */

export function isoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A payment session on the way out.
 *
 * `hostedUrl` is included ONLY when the caller asked for it and is entitled to
 * it — the customer paying, or a staff member holding `payments.collect`. It
 * is a bearer link: anyone holding it can pay, and more importantly it should
 * never end up in a list response that a wider audience reads.
 */
export function serializeSession(row, { includeUrl = false } = {}) {
  const out = {
    id: String(row?.id ?? ''),
    invoiceId: String(row?.invoice_id ?? ''),
    status: String(row?.status ?? ''),
    amountMinor: Number(row?.amount_minor ?? 0),
    currency: String(row?.currency ?? '').toUpperCase(),
    /* The provider's own reference, which is what staff quote to Stripe
       support. Not a secret — it is visible in the Stripe dashboard — but it
       is still only shown to a holder of a payment capability. */
    providerReference: String(row?.provider_payment_intent || row?.provider_session_id || ''),
    expiresAt: isoOrNull(row?.expires_at),
    completedAt: isoOrNull(row?.completed_at),
    lastError: String(row?.last_error ?? ''),
    createdAt: isoOrNull(row?.created_at),
  };
  if (includeUrl) out.hostedUrl = String(row?.hosted_url ?? '');
  return out;
}

/** The payment view of an invoice. Deliberately not the whole invoice row —
 *  no order contents, no internal pricing, no customer record. */
export function serializeInvoicePayment(invoice, { session = null, includeUrl = false } = {}) {
  const currency = String(invoice?.settlement_currency ?? 'USD').toUpperCase();
  return {
    invoiceId: String(invoice?.id ?? ''),
    invoiceNumber: String(invoice?.number ?? ''),
    amount: String(invoice?.amount ?? '0'),
    currency,
    settlementState: isSettlementState(invoice?.settlement_state) ? invoice.settlement_state : 'on_terms',
    amountSettledMinor: Number(invoice?.amount_settled_minor ?? 0),
    amountRefundedMinor: Number(invoice?.amount_refunded_minor ?? 0),
    settledAt: isoOrNull(invoice?.settled_at),
    settlementReference: String(invoice?.settlement_reference ?? ''),
    issuedOn: isoOrNull(invoice?.issued_on),
    session: session ? serializeSession(session, { includeUrl }) : null,
  };
}

/* ---------------------------------------------------------------------------
   The Stripe request Veyora builds
   --------------------------------------------------------------------------- */

/**
 * The Checkout Session parameters for one invoice.
 *
 * WHAT IS DELIBERATELY NOT SENT: the order contents, the SKUs, the wholesale
 * unit prices, the customer's pricing mode, their balance, their terms, or any
 * other party's details. Stripe needs an amount, a currency, a description and
 * somewhere to return the customer. Everything beyond that would be Veyora's
 * commercial data sitting in a third party's dashboard for no operational
 * benefit.
 *
 * The metadata carries the Veyora invoice NUMBER, which is safe: it is already
 * printed on the invoice the customer holds, and it is what makes a payment in
 * the Stripe dashboard traceable to a Veyora record during reconciliation.
 */
export function buildCheckoutParams({
  invoiceId, invoiceNumber, amountMinor, currency, successUrl, cancelUrl,
  customerEmail = '', expiresAt = null,
}) {
  const params = {
    mode: 'payment',
    /* Card only. Adding a redirect-based method here would mean a customer can
       complete a flow that settles days later, which needs a different set of
       webhook events than this phase implements. */
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: String(currency).toLowerCase(),
        unit_amount: amountMinor,
        product_data: { name: `Veyora invoice ${invoiceNumber}` },
      },
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      veyoraInvoiceId: String(invoiceId),
      veyoraInvoiceNumber: String(invoiceNumber),
    },
    /* Repeated on the PaymentIntent so a refund or a dispute — which arrive as
       intent-shaped events, not session-shaped ones — can still be traced back
       to the invoice without a lookup that might miss. */
    payment_intent_data: {
      description: `Veyora invoice ${invoiceNumber}`,
      metadata: {
        veyoraInvoiceId: String(invoiceId),
        veyoraInvoiceNumber: String(invoiceNumber),
      },
    },
  };
  if (customerEmail) params.customer_email = customerEmail;
  if (expiresAt) params.expires_at = Math.floor(new Date(expiresAt).getTime() / 1000);
  return params;
}
