/* Account statement model (Final Handover, Phase 6).

   Pure and dependency-free apart from the money helpers: no database, no PDF,
   no request object. The aggregation is testable on plain arrays.

   THE ARITHMETIC THIS FILE IS RESPONSIBLE FOR

   A statement says: you owed X at the start, here is everything that happened,
   you owe Y at the end. Three properties make that trustworthy:

     1. THE CLOSING BALANCE IS THE OPENING BALANCE PLUS THE MOVEMENTS. It is
        computed, never read from `users.balance`. The old screen did the
        opposite — it took the CURRENT balance as the closing figure and
        subtracted activity to derive an opening one, so any statement for a
        past period silently reported today's balance as that period's closing
        balance.

     2. EVERY FIGURE IS IN MINOR UNITS. Integers throughout; the decimal string
        is produced once, for display.

     3. ONE CURRENCY PER STATEMENT. A running balance that mixes USD and EUR is
        arithmetic nobody can defend. `currenciesFor()` reports what a customer
        actually has activity in, and the caller picks one — the "explicit
        supported presentation" rather than a silent merge.
*/

import { fromMinorUnits, toMinorUnits } from '../payments/invoice-payments.js';

/** What a statement line can be. Ordered as they read on the page. */
export const LINE_KINDS = Object.freeze([
  'invoice',      // increases what the customer owes
  'payment',      // decreases it
  'credit_note',  // decreases it
  'refund',       // increases it back
]);

/* Which direction each kind moves the balance. Stated once, so a new kind
   cannot be added without deciding its sign. */
const SIGN = Object.freeze({
  invoice: 1,
  payment: -1,
  credit_note: -1,
  refund: 1,
});

export const isLineKind = (k) => typeof k === 'string' && LINE_KINDS.includes(k);

/* ---------------------------------------------------------------------------
   Periods
   --------------------------------------------------------------------------- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a period. Both ends inclusive; a statement covers days. */
export function parsePeriod(from, to) {
  const f = String(from ?? '').trim();
  const t = String(to ?? '').trim();
  if (!DATE_RE.test(f) || !DATE_RE.test(t)) {
    return { ok: false, error: 'A statement period needs two dates in YYYY-MM-DD form.' };
  }
  if (f > t) {
    return { ok: false, error: 'A statement period must run forwards.' };
  }
  /* A bound on the span. Not a limit on what a customer may see — they can
     request consecutive periods — but a statement covering eleven years is a
     report nobody reads and a query nobody meant to run. */
  const days = Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000);
  if (days > 1096) {
    return { ok: false, error: 'A statement period may cover at most three years.' };
  }
  return { ok: true, from: f, to: t, days };
}

/** `2026-08-01` → `1 August 2026`. ISO in the data, readable on the page. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function readableDate(iso) {
  if (!DATE_RE.test(String(iso ?? ''))) return String(iso ?? '');
  const [y, m, d] = String(iso).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function periodLabel(from, to) {
  return `${readableDate(from)} to ${readableDate(to)}`;
}

/* ---------------------------------------------------------------------------
   Building
   --------------------------------------------------------------------------- */

const dateOnly = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

/**
 * Turns raw movements into a statement.
 *
 * @param movements `[{ kind, date, reference, description, amountMinor, currency }]`
 *   where `amountMinor` is always POSITIVE — the sign comes from the kind, so
 *   a caller cannot accidentally invert a credit by passing a negative.
 * @param openingMinor the balance at the START of the period, computed by the
 *   caller from everything before it. Passed in rather than derived here,
 *   because deriving it from a current balance is exactly the defect this
 *   replaces.
 */
export function buildStatement({
  customer, currency, from, to, openingMinor, movements = [], generatedAt, brand = null,
}) {
  const cur = String(currency || 'USD').toUpperCase();

  /* Filtered to the period and the currency HERE rather than trusting the
     caller: a movement outside either would corrupt the running balance
     silently, and this is the one place that can see both bounds. */
  const inScope = movements
    .filter((m) => isLineKind(m.kind))
    .filter((m) => String(m.currency || 'USD').toUpperCase() === cur)
    .map((m) => ({ ...m, date: dateOnly(m.date) }))
    .filter((m) => m.date >= from && m.date <= to)
    /* Date, then kind order, then reference: a total ordering, so two
       statements over the same data list the same lines in the same order and
       the running balance is reproducible. */
    .sort((a, b) => a.date.localeCompare(b.date)
      || LINE_KINDS.indexOf(a.kind) - LINE_KINDS.indexOf(b.kind)
      || String(a.reference).localeCompare(String(b.reference)));

  let running = Number(openingMinor) || 0;
  const lines = inScope.map((m) => {
    const amount = Math.abs(Number(m.amountMinor) || 0);
    const signed = amount * SIGN[m.kind];
    running += signed;
    return {
      kind: m.kind,
      date: m.date,
      reference: String(m.reference || ''),
      description: String(m.description || ''),
      /* Debit increases what is owed, credit decreases it — the convention a
         customer's own bookkeeper expects on a supplier statement. */
      debitMinor: signed > 0 ? signed : 0,
      creditMinor: signed < 0 ? -signed : 0,
      balanceMinor: running,
    };
  });

  const totals = lines.reduce((acc, l) => ({
    debitMinor: acc.debitMinor + l.debitMinor,
    creditMinor: acc.creditMinor + l.creditMinor,
  }), { debitMinor: 0, creditMinor: 0 });

  return {
    brand,
    customer,
    currency: cur,
    period: { from, to, label: periodLabel(from, to) },
    openingMinor: Number(openingMinor) || 0,
    /* COMPUTED, never read from a balance column. */
    closingMinor: running,
    lines,
    totals,
    generatedAt,
    /* Ageing is genuinely useful on a supplier statement and is derived here
       from the same lines, so it cannot disagree with them. */
    ageing: ageingBuckets(lines, to),
  };
}

/**
 * How overdue the closing balance is, by invoice age.
 *
 * Computed from the INVOICE lines only: a payment has no age, and including
 * credits would make a bucket that nets to zero look like nothing is
 * outstanding when two things are.
 */
export function ageingBuckets(lines, asOf) {
  const buckets = { current: 0, days30: 0, days60: 0, days90plus: 0 };
  const end = Date.parse(`${asOf}T00:00:00Z`);
  for (const line of lines) {
    if (line.kind !== 'invoice') continue;
    const age = Math.floor((end - Date.parse(`${line.date}T00:00:00Z`)) / 86_400_000);
    if (age <= 30) buckets.current += line.debitMinor;
    else if (age <= 60) buckets.days30 += line.debitMinor;
    else if (age <= 90) buckets.days60 += line.debitMinor;
    else buckets.days90plus += line.debitMinor;
  }
  return buckets;
}

/**
 * The currencies a customer has activity in.
 *
 * Returned so the caller can present a choice rather than a merge. A customer
 * with a single currency gets it without being asked; one with two is a
 * deliberate decision, not a silent sum.
 */
export function currenciesFor(movements = []) {
  const seen = new Map();
  for (const m of movements) {
    const cur = String(m.currency || 'USD').toUpperCase();
    seen.set(cur, (seen.get(cur) || 0) + 1);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([currency, count]) => ({ currency, movements: count }));
}

/* ---------------------------------------------------------------------------
   Recipients
   --------------------------------------------------------------------------- */

/** Why a statement went where it went. Stored on the statement row, because
 *  reconstructing it later from the contact table as it stands THEN would give
 *  the wrong answer. */
export const RECIPIENT_REASONS = Object.freeze([
  'accounts_payable_contact',
  'primary_contact',
  'account_email',
  'explicit_override',
]);

const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

/**
 * Chooses where a statement is sent.
 *
 * The approved order: the active ACCOUNTS-PAYABLE contact, then the PRIMARY
 * contact, then the customer's own account email. An explicit override beats
 * all three.
 *
 * Returns a REASON alongside the address so the screen can say "sending to the
 * accounts-payable contact" rather than showing a bare address the operator
 * has to recognise.
 */
export function chooseRecipient({ contacts = [], customer = null, override = '' }) {
  const clean = String(override ?? '').trim();
  if (clean !== '') {
    if (!EMAIL_RE.test(clean)) {
      return { ok: false, error: 'That does not look like an email address.', code: 'BAD_OVERRIDE' };
    }
    return { ok: true, address: clean, contactId: null, reason: 'explicit_override', name: '' };
  }

  const active = contacts.filter((c) => c.is_active !== false && String(c.email || '').trim() !== '');

  const payable = active.find((c) => Array.isArray(c.responsibilities)
    && c.responsibilities.includes('accounts_payable'));
  if (payable) {
    return {
      ok: true, address: String(payable.email).trim(), contactId: String(payable.id),
      reason: 'accounts_payable_contact',
      name: `${payable.first_name || ''} ${payable.last_name || ''}`.trim(),
    };
  }

  const primary = active.find((c) => c.is_primary === true);
  if (primary) {
    return {
      ok: true, address: String(primary.email).trim(), contactId: String(primary.id),
      reason: 'primary_contact',
      name: `${primary.first_name || ''} ${primary.last_name || ''}`.trim(),
    };
  }

  const accountEmail = String(customer?.email || '').trim();
  if (accountEmail !== '' && EMAIL_RE.test(accountEmail)) {
    return { ok: true, address: accountEmail, contactId: null, reason: 'account_email', name: '' };
  }

  /* No recipient at all is a real state and is reported as one. The screen
     asks for an address rather than sending to nowhere and reporting success. */
  return {
    ok: false,
    code: 'NO_RECIPIENT',
    error: 'This store has no accounts-payable contact, no primary contact and no account email. '
      + 'Enter an address to send to, or add a store contact first.',
  };
}

export const RECIPIENT_LABELS = Object.freeze({
  accounts_payable_contact: 'accounts-payable contact',
  primary_contact: 'primary store contact',
  account_email: 'account email address',
  explicit_override: 'address you entered',
});

/* ---------------------------------------------------------------------------
   Serialisation
   --------------------------------------------------------------------------- */

const money = (minor, currency) => fromMinorUnits(minor, currency);

/** The preview shape. Amounts are sent BOTH as minor units and as display
 *  strings: the browser must never do the arithmetic, and must never format a
 *  figure differently from the PDF. */
export function serializeStatement(statement) {
  const c = statement.currency;
  return {
    currency: c,
    customer: {
      id: String(statement.customer?.id || ''),
      business: String(statement.customer?.business || ''),
      customerNumber: String(statement.customer?.customer_number || ''),
    },
    period: { ...statement.period },
    openingMinor: statement.openingMinor,
    opening: money(statement.openingMinor, c),
    closingMinor: statement.closingMinor,
    closing: money(statement.closingMinor, c),
    totals: {
      debitMinor: statement.totals.debitMinor,
      debit: money(statement.totals.debitMinor, c),
      creditMinor: statement.totals.creditMinor,
      credit: money(statement.totals.creditMinor, c),
    },
    ageing: {
      current: money(statement.ageing.current, c),
      days30: money(statement.ageing.days30, c),
      days60: money(statement.ageing.days60, c),
      days90plus: money(statement.ageing.days90plus, c),
    },
    lines: statement.lines.map((l) => ({
      kind: l.kind,
      date: l.date,
      reference: l.reference,
      description: l.description,
      debit: l.debitMinor ? money(l.debitMinor, c) : '',
      credit: l.creditMinor ? money(l.creditMinor, c) : '',
      balance: money(l.balanceMinor, c),
    })),
    generatedAt: statement.generatedAt instanceof Date
      ? statement.generatedAt.toISOString() : String(statement.generatedAt || ''),
  };
}

/** The download filename. Stable for a given statement. */
export function statementFilename(customerNumber, from, to) {
  const safe = String(customerNumber || '').replace(/[^A-Za-z0-9._-]/g, '');
  const period = `${String(from).slice(0, 10)}_${String(to).slice(0, 10)}`.replace(/[^0-9_-]/g, '');
  return `Veyora-Statement-${safe || 'account'}-${period}.pdf`;
}

/** The server-derived idempotency key. Regenerating the same period for the
 *  same customer in the same currency on the same day reuses the row. */
export function statementIdempotencyKey({ customerId, from, to, currency, generatedOn }) {
  return `stm:${customerId}:${from}:${to}:${String(currency).toUpperCase()}:${generatedOn}`;
}
