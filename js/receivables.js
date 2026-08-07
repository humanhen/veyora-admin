/* ============ Accounts receivable (client feedback item L) ============

   Veyora had a Collection & Debt list of flagged customers and no way to see
   the receivable as a whole: nothing said how much was owed, how much of it
   was late, or how late.

   WHAT EACH FIGURE MEANS. These are stated because two of them can legitimately
   disagree, and a reader who does not know which is which will conclude the
   numbers are wrong rather than that they are telling him something:

     Revenue     total invoiced in the period. What was billed, not what was
                 collected.
     Open AR     the unsettled invoices themselves, added up.
     Past due    the part of Open AR whose due date has passed.
     Future due  the rest of Open AR — issued, not yet due.
     Total AR    the customer LEDGER balance: what the accounts say each
                 customer owes.

   Open AR and Total AR are computed from different places on purpose. Open AR
   comes from invoices; Total AR comes from customer balances, which also carry
   payments on account and credit notes. When they differ, the difference is
   usually unapplied cash or a credit nobody matched to an invoice — which is
   exactly the thing worth seeing, so the page reports the gap rather than
   quietly picking one.

   DUE DATE is the invoice date plus the customer's payment terms in days. A
   customer with no terms recorded falls back to DEFAULT_TERMS_DAYS, and the
   count of those is reported, because a silent default applied to a hundred
   accounts would make the ageing look precise when it is a guess.

   MONEY IS INTEGER CENTS throughout. Adding a few hundred invoices as floats
   is how a receivable total arrives at 128409.99999999999. */
'use strict';

/* Net 30 is the platform's own default (see the customer form), so an account
   with nothing recorded is aged as Net 30 rather than as due immediately. */
const DEFAULT_TERMS_DAYS = 30;

/* An invoice in one of these is no longer a receivable. Anything else — including
   a status this build has never seen — counts as OPEN, because under-stating a
   debt is the more dangerous error. */
const SETTLED_INVOICE_STATUSES = Object.freeze(
  ['paid', 'void', 'cancelled', 'refunded', 'credited']);

/* Days past due. The first bucket is not late at all. */
const AGEING_BUCKETS = Object.freeze([
  { key: 'current', label: 'Not yet due', min: -Infinity, max: 0 },
  { key: 'd1_30', label: '1–30 days', min: 1, max: 30 },
  { key: 'd31_60', label: '31–60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61–90 days', min: 61, max: 90 },
  { key: 'd90p', label: 'Over 90 days', min: 91, max: Infinity },
]);

/** Cents from anything money-shaped, without going through a float. */
function arCents(value) {
  const s = String(value ?? '0').trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const frac = (m[3] || '').padEnd(2, '0').slice(0, 2);
  return sign * (Number(m[2] || '0') * 100 + Number(frac));
}

/** Whole days from `a` to `b`, both YYYY-MM-DD or Date, UTC to avoid DST drift. */
function arDaysBetween(a, b) {
  const at = Date.parse(typeof a === 'string' ? `${a.slice(0, 10)}T00:00:00Z` : a);
  const bt = Date.parse(typeof b === 'string' ? `${b.slice(0, 10)}T00:00:00Z` : b);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return null;
  return Math.round((bt - at) / 86400000);
}

/**
 * The receivable, as at `today`.
 *
 * @param {object[]} invoices  admin rows: {customerId, amount, issuedOn|date, status}
 * @param {object[]} users     admin rows: {id, balance, paymentTerms, role}
 * @param {string}   today     YYYY-MM-DD
 * @returns {object} every money value in CENTS, plus the counts a reader needs
 *   to know how much to trust the ageing.
 */
function receivablesSummary(invoices, users, today) {
  const byId = new Map((users || []).map((u) => [u.id, u]));
  const day = String(today || '').slice(0, 10);

  let revenue = 0;
  let openAr = 0;
  let pastDue = 0;
  let futureDue = 0;
  let assumedTerms = 0;
  let undatable = 0;

  const ageing = Object.fromEntries(AGEING_BUCKETS.map((b) => [b.key, 0]));
  const worst = [];

  for (const inv of invoices || []) {
    const cents = arCents(inv.amount);
    revenue += cents;

    const status = String(inv.status || '').toLowerCase();
    if (SETTLED_INVOICE_STATUSES.includes(status)) continue;
    openAr += cents;

    const issued = inv.issuedOn || inv.date || null;
    const customer = byId.get(inv.customerId);
    /* `Number(null)` and `Number('')` are both 0, so a plain Number() here read
       "no terms recorded" as "due the day it was issued" — which would have
       shown a whole ledger as past due and sent people chasing customers who
       were not late. Missing must stay missing. */
    const recorded = customer == null ? undefined : customer.paymentTerms;
    const termsRaw = recorded === null || recorded === undefined || recorded === ''
      ? NaN
      : Number(recorded);
    const known = Number.isFinite(termsRaw) && termsRaw >= 0;
    const terms = known ? termsRaw : DEFAULT_TERMS_DAYS;
    if (!known) assumedTerms += 1;

    const sinceIssue = issued ? arDaysBetween(issued, day) : null;
    if (sinceIssue === null) {
      /* No usable date. It is still owed, so it stays in Open AR, but it
         cannot be aged — and is counted so the ageing is not read as complete. */
      undatable += 1;
      futureDue += cents;
      ageing.current += cents;
      continue;
    }

    const daysPastDue = sinceIssue - terms;
    if (daysPastDue > 0) pastDue += cents; else futureDue += cents;

    const bucket = AGEING_BUCKETS.find((b) => daysPastDue >= b.min && daysPastDue <= b.max);
    ageing[bucket.key] += cents;

    if (daysPastDue > 0) {
      worst.push({
        customerId: inv.customerId,
        number: inv.number || '',
        amount: cents,
        daysPastDue,
      });
    }
  }

  /* The ledger side. Only customers: an agent's balance is not a receivable. */
  const ledger = (users || [])
    .filter((u) => ['customer', 'special customer'].includes(String(u.role || '')))
    .reduce((sum, u) => sum + arCents(u.balance), 0);

  worst.sort((a, b) => b.daysPastDue - a.daysPastDue || b.amount - a.amount);

  return {
    revenue,
    openAr,
    pastDue,
    futureDue,
    totalAr: ledger,
    /* Positive means the ledger says more is owed than the open invoices
       account for — usually an unapplied credit or a manual balance. */
    unreconciled: ledger - openAr,
    ageing,
    buckets: AGEING_BUCKETS,
    assumedTerms,
    undatable,
    worst: worst.slice(0, 10),
  };
}
