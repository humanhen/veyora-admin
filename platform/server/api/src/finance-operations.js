/* Financial operation model (Final Handover, Phase 4).

   Pure and dependency-free apart from the money helpers: no database, no
   driver, no request object. Every rule below is testable without a server.

   WHAT A FINANCIAL MUTATION MUST CARRY

   The brief's list, and the reason each item is on it:

     actor          — from the authenticated session, never from a body, so a
                      change cannot be recorded as somebody else;
     capability     — which authority admitted it, recorded rather than
                      inferred from the event type;
     reason         — required for every DISCRETIONARY act. "We received
                      £4,000" needs a reference; "they owe £4,000 less" needs
                      an explanation;
     reference      — required for anything claiming money arrived, because a
                      payment with no bank reference cannot be reconciled;
     prior + new    — the balance before and after, so the ledger reconstructs
                      the balance independently of `users.balance`. If the two
                      ever disagree that becomes discoverable;
     currency       — never assumed;
     timestamp      — the database's, not a caller's;
     idempotency    — a server-derived key, so a double-click records once.

   NOTHING HERE MOVES MONEY. It validates, canonicalises and describes. The
   transaction boundaries live in routes/admin-finance.js.
*/

import { createHash } from 'node:crypto';
import { PAYMENT_CURRENCIES, fromMinorUnits, toMinorUnits } from './payments/invoice-payments.js';

/* ---------------------------------------------------------------------------
   Closed sets
   --------------------------------------------------------------------------- */

/** Offline methods a payment may legitimately have been received by.
 *
 *  `stripe` is deliberately ABSENT. A Stripe payment is recorded exclusively
 *  by a verified webhook (0013); letting a client name `stripe` here would be
 *  precisely the "client marks a Stripe payment successful" this phase
 *  forbids. `credit_card` means a card taken over the phone or in person under
 *  existing policy and settled outside Stripe — it is a record of something
 *  that already happened elsewhere, not a charge. */
export const OFFLINE_PAYMENT_METHODS = Object.freeze([
  'transfer',
  'check',
  'credit_card',
  'cash',
]);

/** Every method the `payments` table accepts, including the one only the
 *  webhook may write. Exported so a test can assert the difference. */
export const ALL_PAYMENT_METHODS = Object.freeze([...OFFLINE_PAYMENT_METHODS, 'stripe']);

export const FINANCE_EVENT_TYPES = Object.freeze([
  'invoice.issued',
  'payment.recorded',
  'payment.voided',
  'credit_note.issued',
  'refund.requested',
  'refund.settled',
  'settlement.applied',
  'reconciliation.resolved',
]);

export const isOfflineMethod = (m) => typeof m === 'string' && OFFLINE_PAYMENT_METHODS.includes(m);
export const isFinanceEventType = (t) => typeof t === 'string' && FINANCE_EVENT_TYPES.includes(t);

export const MAX_REASON_LENGTH = 500;
export const MAX_REFERENCE_LENGTH = 120;
export const MAX_NOTES_LENGTH = 2000;

/* Control characters are stripped for the same reason they are everywhere else
   in this codebase: a value that reaches a CSV export, a PDF or a log line must
   not be able to carry a newline. */
const stripControl = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '');

export function cleanText(value, maxLength) {
  const text = stripControl(value).trim();
  if (text.length > maxLength) return null;
  return text;
}

const err = (field, code, message) => ({ field, code, message });

/* ---------------------------------------------------------------------------
   Recording money that arrived
   --------------------------------------------------------------------------- */

/**
 * Validates an offline payment.
 *
 * A REFERENCE IS MANDATORY. A payment with no bank reference, cheque number or
 * receipt is one nobody can match against a statement, and an unmatched credit
 * on a customer's account is how a receivables ledger stops being trustworthy.
 * Cash is the one case where a reference is genuinely awkward, and it is still
 * required — a receipt number or a till reference exists, and typing "cash
 * 14/08 Sam" is better than nothing at all.
 */
export function validateOfflinePayment(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = [];

  const customerId = cleanText(body.customerId, 64) || '';
  if (customerId === '') {
    errors.push(err('customerId', 'REQUIRED', 'Choose the customer this payment is for.'));
  }

  if (!isOfflineMethod(body.method)) {
    errors.push(err('method', 'UNKNOWN_METHOD',
      `A payment method must be one of: ${OFFLINE_PAYMENT_METHODS.join(', ')}. `
      + 'A Stripe payment is recorded only by the payment provider itself.'));
  }

  const currency = String(body.currency || 'USD').toUpperCase();
  if (!PAYMENT_CURRENCIES.includes(currency)) {
    errors.push(err('currency', 'UNSUPPORTED_CURRENCY', 'That is not a currency this platform handles.'));
  }

  const amount = toMinorUnits(body.amount, currency);
  if (!amount.ok) {
    errors.push(err('amount', 'BAD_AMOUNT', 'That amount could not be read as money.'));
  } else if (amount.minor <= 0) {
    errors.push(err('amount', 'BAD_AMOUNT', 'A payment must be for more than zero.'));
  }

  const reference = cleanText(body.reference, MAX_REFERENCE_LENGTH);
  if (reference === null) {
    errors.push(err('reference', 'TOO_LONG', `A reference must be ${MAX_REFERENCE_LENGTH} characters or fewer.`));
  } else if (reference.length < 2) {
    errors.push(err('reference', 'REQUIRED',
      'A bank reference, cheque number or receipt is required so this payment can be matched against a statement.'));
  }

  const notes = cleanText(body.notes, MAX_NOTES_LENGTH);
  if (notes === null) errors.push(err('notes', 'TOO_LONG', 'That note is too long.'));

  /* An optional invoice this payment settles. Optional because a customer on
     terms often pays a round sum against several invoices; when it IS given,
     the route checks the invoice belongs to the same customer. */
  const invoiceId = cleanText(body.invoiceId, 64) || '';

  const paidOn = cleanDate(body.paidOn);
  if (paidOn === null) errors.push(err('paidOn', 'BAD_DATE', 'That is not a date this system can read.'));

  if (errors.length) {
    errors.sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code));
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      customerId, method: body.method, currency,
      amountMinor: amount.minor, amount: fromMinorUnits(amount.minor, currency),
      reference, notes: notes || '', invoiceId, paidOn,
    },
  };
}

/** An ISO date, or '' for "today". Never a free-form string handed to SQL. */
function cleanDate(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : raw;
}

/* ---------------------------------------------------------------------------
   Reducing a debt without money arriving
   --------------------------------------------------------------------------- */

/**
 * Validates a credit note.
 *
 * The REASON is mandatory and long-form. A credit note and a payment look
 * identical on a balance and are completely different events: one is money
 * that arrived, the other is Veyora deciding a customer owes less. The second
 * needs an explanation that survives the person who made it.
 */
export function validateCreditNote(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = [];

  const customerId = cleanText(body.customerId, 64) || '';
  if (customerId === '') {
    errors.push(err('customerId', 'REQUIRED', 'Choose the customer this credit note is for.'));
  }

  const currency = String(body.currency || 'USD').toUpperCase();
  if (!PAYMENT_CURRENCIES.includes(currency)) {
    errors.push(err('currency', 'UNSUPPORTED_CURRENCY', 'That is not a currency this platform handles.'));
  }

  const amount = toMinorUnits(body.amount, currency);
  if (!amount.ok) {
    errors.push(err('amount', 'BAD_AMOUNT', 'That amount could not be read as money.'));
  } else if (amount.minor <= 0) {
    errors.push(err('amount', 'BAD_AMOUNT', 'A credit note must be for more than zero.'));
  }

  const reason = cleanText(body.reason, MAX_REASON_LENGTH);
  if (reason === null) {
    errors.push(err('reason', 'TOO_LONG', `A reason must be ${MAX_REASON_LENGTH} characters or fewer.`));
  } else if (reason.length < 5) {
    errors.push(err('reason', 'REQUIRED',
      'A credit note reduces what a customer owes without money arriving, so it needs a stated reason.'));
  }

  const reference = cleanText(body.reference, MAX_REFERENCE_LENGTH) || '';
  const invoiceId = cleanText(body.invoiceId, 64) || '';
  const issuedOn = cleanDate(body.issuedOn);
  if (issuedOn === null) errors.push(err('issuedOn', 'BAD_DATE', 'That is not a date this system can read.'));

  if (errors.length) {
    errors.sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code));
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      customerId, currency, amountMinor: amount.minor,
      amount: fromMinorUnits(amount.minor, currency),
      reason, reference, invoiceId, issuedOn,
    },
  };
}

/* ---------------------------------------------------------------------------
   Reversing something recorded in error
   --------------------------------------------------------------------------- */

export function validateVoid(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const reason = cleanText(body.reason, MAX_REASON_LENGTH);
  if (reason === null || reason.length < 5) {
    return {
      ok: false,
      errors: [err('reason', 'REQUIRED',
        'Voiding a payment moves a customer balance, so it needs a stated reason.')],
    };
  }
  if (body.confirm !== true) {
    return {
      ok: false,
      errors: [err('confirm', 'CONFIRMATION_REQUIRED', 'Voiding a payment must be confirmed explicitly.')],
    };
  }
  return { ok: true, value: { reason } };
}

export function validateResolution(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const note = cleanText(body.note, MAX_REASON_LENGTH);
  if (note === null || note.length < 5) {
    return {
      ok: false,
      errors: [err('note', 'REQUIRED',
        'Closing a reconciliation exception needs a note saying what was concluded.')],
    };
  }
  return { ok: true, value: { note } };
}

/* ---------------------------------------------------------------------------
   Idempotency
   --------------------------------------------------------------------------- */

/**
 * The server's key for one financial operation.
 *
 * Derived from the FACTS of the operation, never from anything a caller
 * supplied as a key, so two identical submissions collide on the unique index
 * and the money is recorded once. A deliberate second payment of the same
 * amount on the same day with the same reference is indistinguishable from a
 * double-click — and refusing it is the right default, because the operator
 * can vary the reference to say which is which.
 */
export function financeIdempotencyKey(kind, parts) {
  const canonical = Object.keys(parts).sort().map((k) => `${k}=${parts[k]}`).join('|');
  return `${kind}_${createHash('sha256').update(canonical).digest('hex').slice(0, 48)}`;
}

/* ---------------------------------------------------------------------------
   Describing a mutation for the human-readable audit feed
   --------------------------------------------------------------------------- */

/**
 * One line for `audit_log`.
 *
 * Carries the amount, the currency, the reference and the balance movement —
 * enough for somebody scanning the activity feed to see what happened without
 * opening the structured ledger. It does NOT carry a customer's name or
 * address; the ids are there and resolve.
 */
export function describeFinanceEvent({ eventType, amountMinor, currency, reference, balanceBefore, balanceAfter, reason }) {
  const money = `${fromMinorUnits(Math.abs(Number(amountMinor) || 0), currency)} ${currency}`;
  const movement = (balanceBefore != null && balanceAfter != null)
    ? ` — balance ${balanceBefore} → ${balanceAfter}` : '';
  const ref = reference ? ` [${reference}]` : '';
  const why = reason ? ` — ${reason}` : '';
  return `${eventType} ${money}${ref}${movement}${why}`;
}

/* ---------------------------------------------------------------------------
   Serializers — fresh object literals, fixed keys, never a spread row
   --------------------------------------------------------------------------- */

export function isoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function serializeFinanceEvent(row) {
  return {
    id: String(row?.id ?? ''),
    eventType: String(row?.event_type ?? ''),
    customerId: row?.customer_id == null ? null : String(row.customer_id),
    invoiceId: row?.invoice_id == null ? null : String(row.invoice_id),
    paymentId: row?.payment_id == null ? null : String(row.payment_id),
    creditNoteId: row?.credit_note_id == null ? null : String(row.credit_note_id),
    amountMinor: Number(row?.amount_minor ?? 0),
    currency: String(row?.currency ?? ''),
    balanceBefore: row?.balance_before == null ? null : String(row.balance_before),
    balanceAfter: row?.balance_after == null ? null : String(row.balance_after),
    reference: String(row?.reference ?? ''),
    providerReference: String(row?.provider_reference ?? ''),
    reason: String(row?.reason ?? ''),
    /* The actor's NAME as recorded at the time, not a live lookup: the ledger
       must still read correctly after the account is renamed or removed. */
    actorName: String(row?.actor_name ?? ''),
    actorRole: String(row?.actor_role ?? ''),
    capability: String(row?.capability ?? ''),
    createdAt: isoOrNull(row?.created_at),
  };
}

export function serializePayment(row) {
  return {
    id: String(row?.id ?? ''),
    customerId: row?.customer_id == null ? null : String(row.customer_id),
    invoiceId: row?.invoice_id == null ? null : String(row.invoice_id),
    amount: String(row?.amount ?? '0'),
    currency: String(row?.currency ?? 'USD'),
    method: String(row?.method ?? ''),
    reference: String(row?.reference ?? ''),
    paidOn: isoOrNull(row?.paid_on),
    notes: String(row?.notes ?? ''),
    voidedAt: isoOrNull(row?.voided_at),
    voidReason: String(row?.void_reason ?? ''),
    /* The provider reference, not a secret — it is visible in the Stripe
       dashboard — and only ever returned to a holder of a payment capability. */
    providerReference: String(row?.stripe_payment_intent ?? ''),
    createdAt: isoOrNull(row?.created_at),
  };
}

export function serializeCreditNote(row) {
  return {
    id: String(row?.id ?? ''),
    customerId: row?.customer_id == null ? null : String(row.customer_id),
    invoiceId: row?.invoice_id == null ? null : String(row.invoice_id),
    amount: String(row?.amount ?? '0'),
    currency: String(row?.currency ?? 'USD'),
    reason: String(row?.reason ?? ''),
    reference: String(row?.reference ?? ''),
    issuedOn: isoOrNull(row?.issued_on),
    createdAt: isoOrNull(row?.created_at),
  };
}

/** The frozen contract a screen renders its pickers from. */
export const FINANCE_CONTRACT = Object.freeze({
  offlineMethods: OFFLINE_PAYMENT_METHODS,
  currencies: PAYMENT_CURRENCIES,
  eventTypes: FINANCE_EVENT_TYPES,
  limits: Object.freeze({
    reason: MAX_REASON_LENGTH,
    reference: MAX_REFERENCE_LENGTH,
    notes: MAX_NOTES_LENGTH,
  }),
});
