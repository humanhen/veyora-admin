/* ============ Commercial credit control ============

   A credit limit is not a decorative figure on the customer's account page. It
   is the ceiling on how much a customer may owe Veyora at once, and it has to
   mean something at the moment an order is placed or it means nothing at all.

   ---------------------------------------------------------------------------
   WHAT "OUTSTANDING EXPOSURE" IS, EXACTLY
   ---------------------------------------------------------------------------

   Two components, added:

     1. THE LEDGER BALANCE — `users.balance`.

        This is already the canonical net receivable in this platform. Every
        movement goes through `applyMovement()` in `routes/admin-finance.js`,
        which updates the balance and writes a `finance_events` row carrying
        `balance_before` and `balance_after`, so the figure is reconstructible
        from the ledger rather than merely asserted by a column.

        Because it is a NET figure, the properties this control needs hold by
        construction rather than by a special case:

          - a fully paid invoice contributes zero: the `invoice.issued` credit
            was offset by the `payment.recorded` debit;
          - a partly paid invoice contributes only the remainder;
          - an unpaid issued invoice contributes its full amount;
          - an invoice that was never issued never entered the ledger, and a
            voided payment is reversed by `payment.voided`, so neither inflates
            exposure;
          - credit notes and refunds are ledger entries like any other, so they
            are treated consistently by definition.

        Deriving exposure from invoice rows INSTEAD would be wrong here: an
        offline payment (bank transfer, cheque, cash) decreases the balance but
        does NOT write `invoices.amount_settled_minor` — only a verified Stripe
        webhook does. An invoice-derived figure would therefore over-state the
        debt of every customer who pays by transfer, which is most of them.

     2. COMMITTED, NOT YET INVOICED ORDERS.

        An order increases what a customer will owe the moment it is accepted,
        but it does not reach the ledger until somebody issues the invoice.
        Without this term, a credit limit is bypassed simply by ordering faster
        than Veyora invoices — which is precisely the situation a credit limit
        exists to prevent. Cancelled orders are excluded; an order that already
        has an invoice is excluded because the ledger is already counting it.

   ---------------------------------------------------------------------------
   CURRENCY
   ---------------------------------------------------------------------------

   Money is stored in the platform's base currency throughout: `orders.total`
   and `users.balance` are base amounts, with the account's own currency and
   the rate stamped alongside for display and reproducibility. So the sum below
   is single-currency by construction.

   That is asserted rather than assumed. If a contributing record ever carries
   a different currency, the exposure is reported as UNSUPPORTED and no figure
   is produced, because silently adding two currencies together would produce a
   number that looks authoritative and is meaningless.

   ---------------------------------------------------------------------------
   NULL
   ---------------------------------------------------------------------------

   `credit_limit IS NULL` means NOBODY HAS SET ONE. It is never unlimited and
   never zero. No credit decision is made for such an account: exposure is
   still reported, available credit is `null`, and an order is never held for
   review on the strength of a limit that does not exist.

   Zero is a real, deliberate limit — pro-forma only — and is distinct from
   NULL at every layer. */

import { BASE_CURRENCY } from './currency.js';

/** The capability that may set or clear a credit limit. */
export const CREDIT_LIMIT_CAPABILITY = 'finance.credit_limit';

/* Orders that have been committed but not yet invoiced still consume credit.
   'cancelled' never will. */
const NON_COMMITTING_ORDER_STATUSES = Object.freeze(['cancelled']);

/** A refusal carrying a sentence an operator can act on. */
export class CreditError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'credit error');
    this.name = 'CreditError';
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

/* ---------------------------------------------------------------------------
   Money, in integer minor units
   --------------------------------------------------------------------------- */

/** Minor units from a `numeric` string, never through a float. */
export function creditMinor(value) {
  const s = String(value ?? '0').trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const frac = (m[3] || '').padEnd(2, '0').slice(0, 2);
  return sign * (Number(m[2] || '0') * 100 + Number(frac));
}

/** A `numeric`-shaped string from minor units. */
export function creditMajor(minor) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Validate a proposed credit limit.
 *
 * Returns `{ limit: string|null }` or throws. `null` and `''` both mean
 * "clear it", which is a legitimate administrative act: a limit set in error
 * must be removable to *not configured* rather than only to zero, since zero
 * says something quite different.
 *
 * @throws {CreditError}
 */
export function validateCreditLimit(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { limit: null };
  }
  const s = String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new CreditError(400, {
      error: 'A credit limit must be a positive amount with at most two decimal places, '
        + 'or empty to clear it.',
      code: 'INVALID_CREDIT_LIMIT',
    });
  }
  const minor = creditMinor(s);
  /* A negative limit is meaningless — it would say the customer must be in
     credit before ordering at all — and the regex above already refuses the
     sign. This is the belt to that braces: the check does not depend on one
     pattern staying correct. */
  if (minor < 0) {
    throw new CreditError(400, {
      error: 'A credit limit cannot be negative.', code: 'INVALID_CREDIT_LIMIT',
    });
  }
  /* numeric(12,2) tops out below 10^10. Refusing here gives a sentence rather
     than a database error the operator cannot interpret. */
  if (minor > 9_999_999_999_99) {
    throw new CreditError(400, {
      error: 'That credit limit is larger than the system can store.',
      code: 'INVALID_CREDIT_LIMIT',
    });
  }
  return { limit: creditMajor(minor) };
}

/* ---------------------------------------------------------------------------
   Exposure
   --------------------------------------------------------------------------- */

/**
 * The customer's qualifying outstanding exposure, and their credit position.
 *
 * SERVER AUTHORITATIVE. Nothing here reads a request body. The caller passes a
 * customer id taken from a session or from a resolved ordering context, and
 * every figure is derived from the database.
 *
 * @param db          a pool or transaction client
 * @param customerId  whose exposure
 * @param opts.additionalMinor  a prospective amount to include, used to answer
 *   "what would this order do to their position" without writing anything
 * @param opts.excludeOrderId   an order already counted by the caller
 */
export async function creditPosition(db, customerId, opts = {}) {
  if (!customerId) {
    throw new CreditError(400, { error: 'A customer is required.', code: 'NO_CUSTOMER' });
  }
  const additionalMinor = Number.isFinite(opts.additionalMinor) ? opts.additionalMinor : 0;

  const { rows: users } = await db.query(
    `select id, balance, credit_limit, currency from users where id = $1`, [customerId]);
  if (!users.length) {
    throw new CreditError(404, { error: 'That customer could not be found.', code: 'NO_CUSTOMER' });
  }
  const u = users[0];

  /* Committed but not yet invoiced. `invoice_id is null` is the ledger's own
     definition of "not counted yet", so the two terms cannot double-count. */
  const { rows: open } = await db.query(
    `select coalesce(sum(total), 0) as total,
            count(*)::int as orders,
            count(distinct coalesce(currency, $3))::int as currencies,
            min(coalesce(currency, $3)) as sample_currency
       from orders
      where customer_id = $1
        and invoice_id is null
        and not (status = any($2))
        and ($4::text is null or id <> $4)`,
    [customerId, NON_COMMITTING_ORDER_STATUSES, BASE_CURRENCY, opts.excludeOrderId ?? null]);

  /* Single-currency by construction — asserted, not assumed. Two currencies
     added together produce a number that looks authoritative and is not. */
  const sampleCurrency = String(open[0].sample_currency || BASE_CURRENCY).toUpperCase();
  const mixed = Number(open[0].currencies) > 1
    || (Number(open[0].orders) > 0 && sampleCurrency !== BASE_CURRENCY);

  const ledgerMinor = creditMinor(u.balance);
  const uninvoicedMinor = creditMinor(open[0].total);
  const exposureMinor = ledgerMinor + uninvoicedMinor + additionalMinor;

  const configured = u.credit_limit !== null && u.credit_limit !== undefined;
  const limitMinor = configured ? creditMinor(u.credit_limit) : null;

  return {
    customerId: String(u.id),
    /* The currency every figure below is denominated in. */
    currency: BASE_CURRENCY,
    accountCurrency: String(u.currency || BASE_CURRENCY).toUpperCase(),

    /* When true, no figure here may be relied on for a credit decision. */
    exposureUnsupported: mixed,
    unsupportedReason: mixed
      ? 'This account has orders denominated in more than one currency, so an '
        + 'exposure figure cannot be produced without converting them. Nothing '
        + 'has been assumed.'
      : '',

    ledgerMinor,
    uninvoicedMinor,
    uninvoicedOrders: Number(open[0].orders) || 0,
    exposureMinor,

    ledger: creditMajor(ledgerMinor),
    uninvoiced: creditMajor(uninvoicedMinor),
    exposure: creditMajor(exposureMinor),

    creditLimitConfigured: configured,
    creditLimit: configured ? creditMajor(limitMinor) : null,
    creditLimitMinor: configured ? limitMinor : null,

    /* max(limit - exposure, 0). Never negative: "how much more may I order"
       has no negative answer. The shortfall is reported separately so the
       clamp loses nothing. */
    availableCreditMinor: configured && !mixed
      ? Math.max(limitMinor - exposureMinor, 0)
      : null,
    availableCredit: configured && !mixed
      ? creditMajor(Math.max(limitMinor - exposureMinor, 0))
      : null,

    overLimit: configured && !mixed ? exposureMinor > limitMinor : false,
    overLimitByMinor: configured && !mixed ? Math.max(exposureMinor - limitMinor, 0) : 0,
    overLimitBy: configured && !mixed
      ? creditMajor(Math.max(exposureMinor - limitMinor, 0))
      : '0.00',
  };
}

/* ---------------------------------------------------------------------------
   The order-time decision
   --------------------------------------------------------------------------- */

/** The outcomes an order-time credit evaluation can reach. */
export const CREDIT_DECISIONS = Object.freeze({
  /* No limit is configured, so no credit decision is possible or claimed. */
  notConfigured: 'not_configured',
  /* Within the configured limit — the ordinary path. */
  withinLimit: 'within_limit',
  /* Over the configured limit. The order is NOT rejected; it is flagged for
     an authorised human credit decision. */
  reviewRequired: 'credit_review_required',
  /* Exposure could not be computed honestly. Treated as needing review rather
     than as approval, because "we could not tell" is not "yes". */
  unsupported: 'exposure_unsupported',
});

/**
 * Decide, server-side, whether an order may proceed on ordinary credit.
 *
 * Nothing about this decision may come from the browser. The caller supplies a
 * customer id resolved from the session (or from an authorised assisted-order
 * context) and the order total the SERVER priced — never a figure the request
 * asserted.
 *
 * The result is deliberately not a rejection. Veyora's commercial model is
 * credit CHECKING with an approval stage, not automatic refusal: a legitimate
 * order above the limit is a conversation, not an error. What this guarantees
 * is that such an order can never be mistaken for one that passed a credit
 * check.
 *
 * @param orderTotal the server-priced total, as a decimal string
 */
export async function evaluateOrderCredit(db, customerId, orderTotal, opts = {}) {
  const position = await creditPosition(db, customerId, {
    additionalMinor: creditMinor(orderTotal),
    excludeOrderId: opts.excludeOrderId,
  });

  let decision = CREDIT_DECISIONS.withinLimit;
  if (position.exposureUnsupported) decision = CREDIT_DECISIONS.unsupported;
  else if (!position.creditLimitConfigured) decision = CREDIT_DECISIONS.notConfigured;
  else if (position.overLimit) decision = CREDIT_DECISIONS.reviewRequired;

  return {
    decision,
    /* The single flag every downstream reader should branch on. An order with
       this set has NOT passed a credit check and must not be treated as though
       it had. */
    reviewRequired: decision === CREDIT_DECISIONS.reviewRequired
      || decision === CREDIT_DECISIONS.unsupported,
    orderTotalMinor: creditMinor(orderTotal),
    /* Projected exposure INCLUDING this order — the number the decision was
       actually made on, recorded so it can be checked later. */
    projectedExposureMinor: position.exposureMinor,
    projectedExposure: position.exposure,
    creditLimit: position.creditLimit,
    creditLimitMinor: position.creditLimitMinor,
    overLimitByMinor: position.overLimitByMinor,
    currency: position.currency,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * The snapshot stamped onto an order that needs a credit decision.
 *
 * Only written when review is required — an ordinary order carries nothing, so
 * the presence of the column is itself the signal, and a reader cannot mistake
 * an absent snapshot for a passed check.
 */
export function creditReviewSnapshot(evaluation) {
  if (!evaluation?.reviewRequired) return null;
  return {
    decision: evaluation.decision,
    projectedExposureMinor: evaluation.projectedExposureMinor,
    creditLimitMinor: evaluation.creditLimitMinor,
    overLimitByMinor: evaluation.overLimitByMinor,
    orderTotalMinor: evaluation.orderTotalMinor,
    currency: evaluation.currency,
    evaluatedAt: evaluation.evaluatedAt,
    /* Filled in only by an authorised human decision, through its own route.
       Absent means nobody has decided yet. */
    resolvedBy: null,
    resolvedAt: null,
    resolution: null,
  };
}
