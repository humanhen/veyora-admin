/* Payment session service (Final Handover, Phase 3).

   Creates or retrieves the Stripe-hosted session a customer follows to pay one
   invoice. The database and the Stripe client are both INJECTED, so the whole
   lifecycle is exercised in tests with no network and no key.

   THE INVARIANTS THIS FILE EXISTS TO HOLD

     1. THE AMOUNT COMES FROM THE SERVER. It is read from the invoice row
        inside the transaction, converted once, and sent to Stripe. There is no
        code path by which a request body can influence it — the functions here
        do not take an amount parameter at all.

     2. ONE LIVE SESSION PER INVOICE. Enforced by a partial unique index, not
        by a check-then-insert. A duplicate request either finds the reusable
        session and returns it, or supersedes the old one inside the same
        transaction. Two concurrent requests cannot both create.

     3. AN UNPAYABLE INVOICE CANNOT OPEN A SESSION. Paid, refunded, void and
        awaiting-confirmation are all refused with a reason, and the check runs
        against the row locked for update — not against a copy read earlier.

     4. NOTHING IS MARKED PAID HERE. Not by a return from Stripe, not by the
        customer arriving on the success page. A session is a request to pay;
        only a verified webhook is evidence that money moved. That separation
        is the entire security model of this subsystem.
*/

import {
  assessPayability, buildCheckoutParams, isSessionReusable,
  sessionIdempotencyKey, toMinorUnits,
} from './invoice-payments.js';

export class PaymentError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'payment error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

const SESSION_COLUMNS = `id, invoice_id, customer_id, provider, status, amount_minor, currency,
  provider_session_id, provider_payment_intent, hosted_url, idempotency_key, requested_by,
  expires_at, completed_at, last_error, created_at, updated_at`;

const INVOICE_COLUMNS = `id, number, order_id, order_number, customer_id, amount, status,
  issued_on, settlement_state, settlement_currency, amount_settled_minor,
  amount_refunded_minor, settled_at, settlement_reference`;

/** The most recent session for an invoice, whatever its state. */
export async function latestSession(db, invoiceId) {
  const { rows } = await db.query(
    `select ${SESSION_COLUMNS} from payment_sessions
      where invoice_id = $1 order by created_at desc, id desc limit 1`,
    [invoiceId]
  );
  return rows[0] || null;
}

export async function loadInvoice(db, invoiceId) {
  const { rows } = await db.query(
    `select ${INVOICE_COLUMNS} from invoices where id = $1 or number = $1 limit 1`,
    [invoiceId]
  );
  return rows[0] || null;
}

/**
 * Creates a payment session, or returns the live one.
 *
 * @param actor the AUTHENTICATED user. `customerId` is derived from the
 *   invoice, never from the caller, so a customer cannot open a session
 *   against somebody else's invoice by supplying an id.
 * @param stripe an injected client.
 */
export async function createOrGetSession(db, stripe, config, invoiceRef, actor, {
  now = () => new Date(), isCustomer = false,
} = {}) {
  const at = now();

  /* Phase one, in a transaction: lock the invoice, decide, and either return
     the reusable session or reserve a new row. Stripe is NOT called inside the
     transaction — a provider round trip with a row lock held is how a slow
     third party becomes a database incident. */
  const reserved = await db.tx(async (c) => {
    const { rows } = await c.query(
      `select ${INVOICE_COLUMNS} from invoices where id = $1 or number = $1 limit 1 for update`,
      [invoiceRef]
    );
    const invoice = rows[0];
    if (!invoice) throw new PaymentError(404, { error: 'That invoice could not be found.', code: 'NOT_FOUND' });

    /* A customer may only pay their OWN invoice. Checked against the invoice
       row, so a guessed or enumerated id is a 404 rather than a session. */
    if (isCustomer && invoice.customer_id !== actor?.id) {
      throw new PaymentError(404, { error: 'That invoice could not be found.', code: 'NOT_FOUND' });
    }

    const verdict = assessPayability(invoice, { stripeEnabled: config?.enabled === true, now: at });
    if (!verdict.payable) {
      throw new PaymentError(409, { error: verdict.reason, code: verdict.code });
    }

    const existing = await currentLiveSession(c, invoice.id);
    if (isSessionReusable(existing, { amountMinor: verdict.amountMinor, currency: verdict.currency, now: at })) {
      return { reuse: existing, invoice };
    }

    /* Supersede whatever was there. `cancelled` rather than deleted: the
       attempt happened, and a session that vanished is one nobody can explain
       when a customer says they had a link. */
    if (existing) {
      await c.query(
        `update payment_sessions set status = 'cancelled', last_error = $2
          where id = $1 and status in ('created', 'open')`,
        [existing.id, 'superseded by a newer session']
      );
    }

    /* `attempt` makes the key genuinely new for a superseding session, while
       two simultaneous first requests still collide on the same key. */
    const attempt = await supersededCount(c, invoice.id);
    const key = sessionIdempotencyKey({
      invoiceId: invoice.id, amountMinor: verdict.amountMinor,
      currency: verdict.currency, attempt,
    });

    /* Reserved BEFORE Stripe is contacted. If the provider call then fails,
       the row survives in 'created' with the error on it — a visible
       reconciliation exception rather than a silent nothing. */
    const { rows: created } = await c.query(
      `insert into payment_sessions
         (invoice_id, customer_id, amount_minor, currency, idempotency_key, requested_by, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (idempotency_key) do nothing
       returning ${SESSION_COLUMNS}`,
      [invoice.id, invoice.customer_id, verdict.amountMinor, verdict.currency, key,
       actor?.id ?? null, new Date(at.getTime() + config.sessionTtlMinutes * 60_000)]
    );

    if (!created[0]) {
      /* Another request won the race on the same key. Its row is the live one;
         return that rather than creating a second Stripe session. */
      const raced = await currentLiveSession(c, invoice.id);
      if (raced) return { reuse: raced, invoice };
      throw new PaymentError(409, {
        error: 'A payment for this invoice is already being set up. Try again in a moment.',
        code: 'SESSION_IN_FLIGHT',
      });
    }
    return { created: created[0], invoice };
  });

  if (reserved.reuse) return { session: reserved.reuse, invoice: reserved.invoice, reused: true };

  // ---- phase two: the provider call, outside any transaction ----
  const row = reserved.created;
  const invoice = reserved.invoice;
  try {
    const params = buildCheckoutParams({
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      successUrl: config.successUrl,
      cancelUrl: config.cancelUrl,
      expiresAt: row.expires_at,
    });
    const session = await stripe.createCheckoutSession(params, { idempotencyKey: row.idempotency_key });

    /* Verified before the row is opened. Stripe returning a different amount
       than we asked for should be impossible; treating "impossible" as "need
       not be checked" is how money goes missing. */
    if (Number(session.amountTotalMinor) !== Number(row.amount_minor)
      || String(session.currency).toUpperCase() !== String(row.currency).toUpperCase()) {
      throw new PaymentError(502, {
        error: 'The payment provider returned an unexpected amount. Nothing was charged.',
        code: 'AMOUNT_MISMATCH',
      });
    }

    const { rows: opened } = await db.query(
      `update payment_sessions
          set status = 'open', provider_session_id = $2, hosted_url = $3,
              provider_payment_intent = $4, last_error = ''
        where id = $1 and status = 'created'
        returning ${SESSION_COLUMNS}`,
      [row.id, session.id, session.url, session.paymentIntentId || '']
    );
    return { session: opened[0] || row, invoice, reused: false };
  } catch (err) {
    /* The reservation is failed, not deleted, and the message recorded is the
       provider's CODE — never a raw error object, which can carry request
       details. */
    await db.query(
      `update payment_sessions set status = 'failed', last_error = $2 where id = $1 and status = 'created'`,
      [row.id, String(err?.code || err?.body?.code || 'PROVIDER_ERROR').slice(0, 200)]
    ).catch(() => {});
    if (err instanceof PaymentError) throw err;
    throw new PaymentError(502, {
      error: 'The payment provider could not be reached. Nothing was charged — please try again.',
      code: 'PROVIDER_UNAVAILABLE',
    });
  }
}

async function currentLiveSession(c, invoiceId) {
  const { rows } = await c.query(
    `select ${SESSION_COLUMNS} from payment_sessions
      where invoice_id = $1 and status in ('created', 'open')
      order by created_at desc limit 1`,
    [invoiceId]
  );
  return rows[0] || null;
}

async function supersededCount(c, invoiceId) {
  const { rows } = await c.query(
    `select count(*)::int as n from payment_sessions where invoice_id = $1`,
    [invoiceId]
  );
  return rows[0]?.n ?? 0;
}

/**
 * Expires sessions whose window has passed.
 *
 * Bounded and idempotent. Without this a customer sees "a payment is being set
 * up" forever after a link they never followed, and the invoice can never be
 * paid again — the one-live-session index would keep refusing.
 */
export async function expireStaleSessions(db, { now = new Date(), limit = 100 } = {}) {
  const { rows } = await db.query(
    `update payment_sessions
        set status = 'expired', last_error = 'the payment window closed'
      where id in (
        select id from payment_sessions
         where status in ('created', 'open') and expires_at is not null and expires_at <= $1
         order by expires_at limit $2 for update skip locked)
      returning id, invoice_id`,
    [now, limit]
  );
  return { expired: rows.length };
}

/**
 * The customer-facing or staff-facing read.
 *
 * `includeUrl` is decided by the CALLER's authority, not by the row: the
 * customer paying gets the link, and a staff member gets it only with
 * `payments.collect`. A viewer with `payments.view` sees the state and the
 * provider reference, and no bearer link.
 */
export async function getInvoicePaymentState(db, invoiceRef, { customerId = null } = {}) {
  const invoice = await loadInvoice(db, invoiceRef);
  if (!invoice) return null;
  if (customerId && invoice.customer_id !== customerId) return null;
  const session = await latestSession(db, invoice.id);
  return { invoice, session };
}
