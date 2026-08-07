/* ============ Balance & Payments, from the customer's side ============

   The portal showed a customer their invoices and nothing else. There was no
   single screen answering the three questions an optician actually rings up to
   ask: what do I owe, what has been paid, and how much can I still order.

   TWO RULES SHAPE ALL OF THIS.

   1. NULL CREDIT LIMIT IS NOT UNLIMITED. It means nobody has set one. Every
      account in the database reads NULL the moment 0017 runs, so treating it
      as unlimited would silently grant infinite credit to the entire customer
      base. `creditLimit: null` travels with `creditLimitConfigured: false`,
      no headroom is computed, and the page says "Credit limit not configured".

   2. THE CUSTOMER READS; THEY NEVER WRITE. Nothing here accepts input. A
      credit limit is a commercial decision Veyora makes about a customer, in
      the same family as pricing and payment terms — which is also why the
      column is deliberately absent from the admin sync collection, so it
      cannot be set by a whole-row diff posted from a browser either.

   Money arrives from `numeric` columns as strings. It is kept as strings all
   the way to the response: converting to a JS number to add three invoices
   together is how a balance ends up at 4079.999999999999. */

/** Cents from a `numeric` string, without ever going through a float. */
function toCents(value) {
  const s = String(value ?? '0').trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = m[2] || '0';
  const frac = (m[3] || '').padEnd(2, '0').slice(0, 2);
  return sign * (Number(whole) * 100 + Number(frac));
}

/** A `numeric`-shaped string from cents. */
function fromCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/* Invoices in these settlement states are no longer outstanding. `processing`
   deliberately IS still outstanding: a completed checkout is not a settled
   invoice until a signed webhook says so, and showing it as paid here would
   contradict the one rule the whole payment design exists to protect. */
const SETTLED_STATES = Object.freeze(['paid', 'refunded', 'void']);

/**
 * Everything the Balance & Payments screen shows, for the caller's own
 * account only.
 *
 * @returns {Promise<object>} a fresh literal — no database row is ever spread
 *   into the response.
 */
export async function accountBalance(db, customerId) {
  const { rows: users } = await db.query(
    `select id, balance, credit_limit, currency, payment_terms
       from users where id = $1`, [customerId]);
  if (!users.length) return null;
  const u = users[0];

  const { rows: invoices } = await db.query(
    `select id, number, amount, issued_on, status, settlement_state
       from invoices where customer_id = $1
       order by issued_on desc, number desc limit 50`, [customerId]);
  const { rows: payments } = await db.query(
    `select id, amount, method, reference, paid_on
       from payments where customer_id = $1
       order by paid_on desc, created_at desc limit 50`, [customerId]);
  const { rows: credits } = await db.query(
    `select id, amount, reason, issued_on
       from credit_notes where customer_id = $1
       order by issued_on desc limit 50`, [customerId]);

  const outstanding = invoices
    .filter((i) => !SETTLED_STATES.includes(String(i.settlement_state || 'on_terms')))
    .reduce((sum, i) => sum + toCents(i.amount), 0);

  /* NULL is "not configured". It is never coerced to 0 and never to Infinity:
     0 would say the customer may order nothing, Infinity would say anything. */
  const limitConfigured = u.credit_limit !== null && u.credit_limit !== undefined;
  const limitCents = limitConfigured ? toCents(u.credit_limit) : null;
  const balanceCents = toCents(u.balance);

  return {
    currency: String(u.currency || 'USD').toUpperCase(),
    paymentTerms: String(u.payment_terms || ''),
    balance: fromCents(balanceCents),
    outstanding: fromCents(outstanding),

    creditLimitConfigured: limitConfigured,
    creditLimit: limitConfigured ? fromCents(limitCents) : null,
    /* Headroom only exists once a limit does. `null` here means "we cannot
       say", which is the truth, and the page renders no figure rather than a
       reassuring one. */
    creditAvailable: limitConfigured ? fromCents(limitCents - balanceCents) : null,
    overLimit: limitConfigured ? balanceCents > limitCents : false,

    invoices: invoices.map((i) => ({
      id: String(i.id),
      number: String(i.number || ''),
      amount: String(i.amount ?? '0'),
      issuedOn: i.issued_on instanceof Date ? i.issued_on.toISOString().slice(0, 10) : i.issued_on,
      status: String(i.status || ''),
      settlementState: String(i.settlement_state || 'on_terms'),
      outstanding: !SETTLED_STATES.includes(String(i.settlement_state || 'on_terms')),
    })),
    payments: payments.map((p) => ({
      id: String(p.id),
      amount: String(p.amount ?? '0'),
      method: String(p.method || ''),
      reference: String(p.reference || ''),
      paidOn: p.paid_on instanceof Date ? p.paid_on.toISOString().slice(0, 10) : p.paid_on,
    })),
    creditNotes: credits.map((c) => ({
      id: String(c.id),
      amount: String(c.amount ?? '0'),
      reason: String(c.reason || ''),
      issuedOn: c.issued_on instanceof Date ? c.issued_on.toISOString().slice(0, 10) : c.issued_on,
    })),
  };
}

export const __testing = { toCents, fromCents, SETTLED_STATES };
