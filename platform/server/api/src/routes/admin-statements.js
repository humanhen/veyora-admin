/* Account statements: generate, preview, download, send (Final Handover, Phase 6).

   WHAT THIS REPLACES

       DB.audit('statement.send', u.business, 'Emailed to ' + u.email);
       toast('Statement emailed to ' + u.email);

   Nothing was generated, nothing was attached, nothing was sent, and the audit
   log recorded a delivery that never happened. A false record is worse than no
   button, because it is consulted later and believed.

   THE APPROVED WORKFLOW, IMPLEMENTED

     - manually generated, never scheduled;
     - previewed before sending;
     - delivered as a PDF attachment;
     - addressed to the active accounts-payable contact, then the primary
       contact, then the account email — with an explicit override available;
     - delivered through the NOTIFICATION OUTBOX, so it inherits bounded
       retries and the rule that nothing is reported delivered without provider
       confirmation;
     - visible as pending, delivered, retrying or failed;
     - recorded in append-only audit evidence.

   AUTHORITY

     `payments.view`     — generate, preview and download. This is reading
                           payment state, which that capability already
                           describes; a second key for it would be two grants
                           to keep in step.
     `statements.send`   — send one to a customer. Outward-facing, so its own.

   ONE CURRENCY PER STATEMENT. A running balance mixing USD and EUR is
   arithmetic nobody can defend. `GET /currencies` reports what a customer
   actually has activity in and the caller picks — the explicit presentation
   rather than a silent merge.
*/

import { Router } from 'express';
import { pool, tx as realTx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { requirePermission, getUserPermissions } from '../permissions.js';
import { brandConfig } from '../documents/brand-config.js';
import { renderStatementPdf } from '../documents/statement-pdf.js';
import {
  RECIPIENT_LABELS, buildStatement, chooseRecipient, currenciesFor, parsePeriod,
  periodLabel, serializeStatement, statementFilename, statementIdempotencyKey,
} from '../documents/statement.js';
import { toMinorUnits } from '../payments/invoice-payments.js';
import { enqueue, findBySource, serializeNotification } from '../notifications/outbox.js';
import { buildStatementTemplateData } from '../notifications/templates.js';
import { adminLink } from '../origins.js';

export const STATEMENT_CAPABILITIES = Object.freeze({
  view: 'payments.view',
  send: 'statements.send',
});

export class StatementError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'statement error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

export async function getStatementCapabilities(db, userId) {
  const held = new Set(await getUserPermissions(db, userId));
  return {
    view: held.has(STATEMENT_CAPABILITIES.view),
    send: held.has(STATEMENT_CAPABILITIES.send),
  };
}

/* ---------------------------------------------------------------------------
   Gathering the movements
   --------------------------------------------------------------------------- */

/**
 * Every financial movement for one customer, from the four ledgers.
 *
 * Read from the SOURCE tables rather than from `finance_events`, deliberately:
 * `finance_events` only carries movements made since Phase 4 shipped, and a
 * statement covering an earlier period must include the history that predates
 * it. The ledger is the audit record; these are the documents.
 *
 * A VOIDED payment is excluded — the money did not arrive, and its reversal is
 * already reflected in the balance. Showing both the payment and its void on a
 * customer's statement would be internally correct and externally baffling.
 */
export async function loadMovements(db, customerId) {
  const [invoices, payments, credits, refunds] = await Promise.all([
    db.query(
      `select id, number, order_number, amount, settlement_currency, issued_on
         from invoices where customer_id = $1 order by issued_on, id`, [customerId]),
    db.query(
      `select id, amount, currency, method, reference, paid_on, voided_at
         from payments where customer_id = $1 and voided_at is null
         order by paid_on, id`, [customerId]),
    db.query(
      `select id, amount, currency, reason, reference, issued_on
         from credit_notes where customer_id = $1 order by issued_on, id`, [customerId]),
    db.query(
      `select r.id, r.amount_minor, r.currency, r.reason, r.created_at, i.number as invoice_number
         from payment_refunds r
         join invoices i on i.id = r.invoice_id
        where i.customer_id = $1 and r.status = 'succeeded'
        order by r.created_at, r.id`, [customerId]).catch(() => ({ rows: [] })),
  ]);

  const minor = (amount, currency) => {
    const parsed = toMinorUnits(amount ?? 0, currency);
    return parsed.ok ? Math.abs(parsed.minor) : 0;
  };

  const movements = [];

  for (const i of invoices.rows) {
    const currency = String(i.settlement_currency || 'USD').toUpperCase();
    movements.push({
      kind: 'invoice', date: i.issued_on, currency,
      reference: String(i.number || ''),
      description: i.order_number ? `Order ${i.order_number}` : 'Invoice',
      amountMinor: minor(i.amount, currency),
    });
  }
  for (const p of payments.rows) {
    const currency = String(p.currency || 'USD').toUpperCase();
    movements.push({
      kind: 'payment', date: p.paid_on, currency,
      reference: String(p.reference || ''),
      description: `Payment received (${String(p.method || '').replace(/_/g, ' ')})`,
      amountMinor: minor(p.amount, currency),
    });
  }
  for (const n of credits.rows) {
    const currency = String(n.currency || 'USD').toUpperCase();
    movements.push({
      kind: 'credit_note', date: n.issued_on, currency,
      reference: String(n.reference || ''),
      description: String(n.reason || 'Credit note'),
      amountMinor: minor(n.amount, currency),
    });
  }
  for (const r of refunds.rows) {
    movements.push({
      kind: 'refund', date: r.created_at, currency: String(r.currency || 'USD').toUpperCase(),
      reference: String(r.invoice_number || ''),
      description: 'Refund issued',
      amountMinor: Math.abs(Number(r.amount_minor) || 0),
    });
  }

  return movements;
}

/**
 * The balance at the START of a period.
 *
 * Computed by summing everything BEFORE it — never taken from
 * `users.balance`. The screen this replaces did the opposite: it read the
 * CURRENT balance as the closing figure and subtracted the period's activity
 * to derive an opening one, so a statement for any past period silently
 * reported today's balance as that period's closing balance.
 */
export function openingBalanceMinor(movements, { before, currency }) {
  const cur = String(currency).toUpperCase();
  const sign = { invoice: 1, refund: 1, payment: -1, credit_note: -1 };
  return movements
    .filter((m) => String(m.currency).toUpperCase() === cur)
    .filter((m) => {
      const d = typeof m.date === 'string' ? m.date.slice(0, 10)
        : new Date(m.date).toISOString().slice(0, 10);
      return d < before;
    })
    .reduce((sum, m) => sum + Math.abs(Number(m.amountMinor) || 0) * (sign[m.kind] || 0), 0);
}

async function loadCustomer(db, customerId) {
  const { rows } = await db.query(
    `select id, business, customer_number, email, first_name, last_name,
            address, city, state, zip, country
       from users where id = $1 limit 1`, [customerId]);
  if (!rows[0]) throw new StatementError(404, { error: 'That customer could not be found.', code: 'NO_CUSTOMER' });
  return rows[0];
}

async function loadContacts(db, customerId) {
  const { rows } = await db.query(
    `select id, first_name, last_name, email, responsibilities, is_primary, is_active
       from customer_contacts where customer_id = $1 and is_active order by id`,
    [customerId]
  ).catch(() => ({ rows: [] }));
  return rows;
}

/* ---------------------------------------------------------------------------
   Building
   --------------------------------------------------------------------------- */

/** Which currencies a customer has activity in, so a choice can be presented. */
export async function statementCurrencies(db, customerId) {
  await loadCustomer(db, customerId);
  return currenciesFor(await loadMovements(db, customerId));
}

/**
 * Builds a statement. Pure with respect to the database — it reads, it does
 * not write. Generating a preview must not create a record.
 */
export async function buildStatementFor(db, customerId, { from, to, currency, generatedAt, brand = null }) {
  const period = parsePeriod(from, to);
  if (!period.ok) throw new StatementError(400, { error: period.error, code: 'BAD_PERIOD' });

  const customer = await loadCustomer(db, customerId);
  const movements = await loadMovements(db, customerId);

  const available = currenciesFor(movements);
  let cur = String(currency || '').toUpperCase();
  if (cur === '') cur = available[0]?.currency || 'USD';

  return buildStatement({
    customer,
    currency: cur,
    from: period.from,
    to: period.to,
    openingMinor: openingBalanceMinor(movements, { before: period.from, currency: cur }),
    movements,
    generatedAt,
    brand: brand || brandConfig(),
  });
}

export async function renderStatementDocument(db, customerId, options) {
  const statement = await buildStatementFor(db, customerId, options);
  return {
    statement,
    bytes: await renderStatementPdf(statement),
    filename: statementFilename(statement.customer.customer_number, statement.period.from, statement.period.to),
  };
}

/* ---------------------------------------------------------------------------
   Recipient
   --------------------------------------------------------------------------- */

/** Where a statement WOULD go, without sending it. The screen shows this
 *  before the operator commits, so the address is never a surprise. */
export async function proposedRecipient(db, customerId, { override = '' } = {}) {
  const customer = await loadCustomer(db, customerId);
  const contacts = await loadContacts(db, customerId);
  const choice = chooseRecipient({ contacts, customer, override });
  if (!choice.ok) return { ok: false, code: choice.code, error: choice.error };
  return {
    ok: true,
    address: choice.address,
    contactId: choice.contactId,
    reason: choice.reason,
    reasonLabel: RECIPIENT_LABELS[choice.reason] || choice.reason,
    name: choice.name,
  };
}

/* ---------------------------------------------------------------------------
   Sending
   --------------------------------------------------------------------------- */

/**
 * Records the statement and queues it for delivery.
 *
 * The statement row and its outbox notification are written in ONE
 * transaction, so a statement can never exist claiming to have been queued
 * while no notification carries it, nor the reverse.
 *
 * The status set here is `queued`, never `sent`. A statement becomes `sent`
 * only when the outbox confirms delivery against a provider reference — which
 * is the whole reason the outbox exists.
 */
export async function sendStatement(db, customerId, body, actor, { now = new Date() } = {}) {
  const period = parsePeriod(body?.from, body?.to);
  if (!period.ok) throw new StatementError(400, { error: period.error, code: 'BAD_PERIOD' });

  const recipient = await proposedRecipient(db, customerId, { override: body?.recipientOverride });
  if (!recipient.ok) throw new StatementError(422, { error: recipient.error, code: recipient.code });

  const statement = await buildStatementFor(db, customerId, {
    from: period.from, to: period.to, currency: body?.currency, generatedAt: now,
  });

  const generatedOn = now.toISOString().slice(0, 10);
  const key = statementIdempotencyKey({
    customerId, from: period.from, to: period.to,
    currency: statement.currency, generatedOn,
  });

  const outcome = await db.tx(async (c) => {
    const { rows: created } = await c.query(
      `insert into account_statements
         (customer_id, period_from, period_to, currency, opening_minor, closing_minor,
          line_count, generated_by, status, recipient_contact_id, recipient_address,
          recipient_reason, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12)
       on conflict (idempotency_key) do nothing
       returning id, customer_id, period_from, period_to, currency, opening_minor,
                 closing_minor, line_count, status, recipient_address, recipient_reason,
                 generated_at, sent_at, notification_id, last_error`,
      [customerId, period.from, period.to, statement.currency,
       statement.openingMinor, statement.closingMinor, statement.lines.length,
       actor?.id ?? null, recipient.contactId, recipient.address, recipient.reason, key]
    );

    if (!created[0]) {
      /* The same period, currency and day has already been sent. Refused
         rather than sent again: a customer receiving the same statement twice
         in a morning reads it as a system with a fault. */
      throw new StatementError(409, {
        error: 'This statement has already been sent today. Change the period, or send again tomorrow.',
        code: 'ALREADY_SENT_TODAY',
      });
    }
    const row = created[0];

    /* Queued in the SAME transaction. If the enqueue fails, the statement row
       rolls back with it — there is never a statement claiming to be queued
       with nothing carrying it. */
    const notification = await enqueue(c, {
      notificationType: 'statement_delivery',
      sourceType: 'account_statement',
      sourceId: row.id,
      recipientAddress: recipient.address,
      recipientName: recipient.name || statement.customer.business || '',
      templateKey: 'statement_delivery',
      templateData: buildStatementTemplateData({
        customerName: statement.customer.business || '',
        periodLabel: periodLabel(period.from, period.to),
        closingBalance: serializeStatement(statement).closing,
        currency: statement.currency,
        adminUrl: adminLink('/#/statements'),
      }),
    });

    if (notification) {
      await c.query(`update account_statements set notification_id = $2 where id = $1`,
        [row.id, notification.id]);
      row.notification_id = notification.id;
    }

    return { row, notification };
  });

  /* Audited after commit, so the log cannot claim a queued statement that
     rolled back. It records that the statement was QUEUED — not sent, which is
     the outbox's word to give. */
  await audit(
    { id: actor?.id, name: actor?.business || actor?.email, role: actor?.role },
    'statement.queued',
    `customer:${customerId}`,
    `${period.from}..${period.to} ${statement.currency}, ${statement.lines.length} lines, `
      + `to the ${RECIPIENT_LABELS[recipient.reason] || recipient.reason}`
  ).catch(() => {});

  return serializeStatementRow(outcome.row, {
    notification: outcome.notification ? serializeNotification(outcome.notification) : null,
  });
}

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

const ROW_COLUMNS = `id, customer_id, period_from, period_to, currency, opening_minor,
  closing_minor, line_count, status, recipient_address, recipient_reason,
  generated_at, sent_at, notification_id, last_error`;

export function serializeStatementRow(row, { notification = null } = {}) {
  const iso = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
  return {
    id: String(row?.id ?? ''),
    customerId: String(row?.customer_id ?? ''),
    periodFrom: String(row?.period_from ?? '').slice(0, 10),
    periodTo: String(row?.period_to ?? '').slice(0, 10),
    currency: String(row?.currency ?? ''),
    openingMinor: Number(row?.opening_minor ?? 0),
    closingMinor: Number(row?.closing_minor ?? 0),
    lineCount: Number(row?.line_count ?? 0),
    status: String(row?.status ?? 'draft'),
    /* The address is shown to STAFF only, and only masked in the notification
       view — here the operator needs to see where their own statement went. */
    recipientAddress: String(row?.recipient_address ?? ''),
    recipientReason: String(row?.recipient_reason ?? ''),
    recipientReasonLabel: RECIPIENT_LABELS[row?.recipient_reason] || '',
    generatedAt: iso(row?.generated_at),
    sentAt: iso(row?.sent_at),
    lastError: String(row?.last_error ?? ''),
    /* Delivery state comes from the OUTBOX, not from a duplicate column here —
       two answers to "was it sent?" is one too many. */
    delivery: notification,
  };
}

/** Statements previously sent to one customer, newest first, each carrying its
 *  live delivery state from the outbox. */
export async function statementHistory(db, customerId, { limit = 25 } = {}) {
  const { rows } = await db.query(
    `select ${ROW_COLUMNS} from account_statements
      where customer_id = $1 order by generated_at desc, id desc limit $2`,
    [customerId, Math.min(Math.max(Number(limit) || 25, 1), 100)]
  );

  const out = [];
  for (const row of rows) {
    const notifications = await findBySource(db, 'account_statement', row.id).catch(() => []);
    out.push(serializeStatementRow(row, {
      notification: notifications[0] ? serializeNotification(notifications[0]) : null,
    }));
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Router
   --------------------------------------------------------------------------- */

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

const r = Router();
r.use(requireAuth());

const canView = () => requirePermission(STATEMENT_CAPABILITIES.view);
const canSend = () => requirePermission(STATEMENT_CAPABILITIES.send);

function send(res, next, promise, shape = (v) => v) {
  promise
    .then((value) => res.json(shape(value)))
    .catch((err) => {
      if (err instanceof StatementError) return res.status(err.status).json(err.body);
      next(err);
    });
}

r.get('/capabilities', (req, res, next) =>
  send(res, next, getStatementCapabilities(liveDb, req.user?.id), (capabilities) => ({ capabilities }))
);

r.get('/:customerId/currencies', canView(), (req, res, next) =>
  send(res, next, statementCurrencies(liveDb, req.params.customerId), (currencies) => ({ currencies }))
);

r.get('/:customerId/recipient', canView(), (req, res, next) =>
  send(res, next, proposedRecipient(liveDb, req.params.customerId, {
    override: typeof req.query.override === 'string' ? req.query.override : '',
  }), (recipient) => ({ recipient }))
);

r.get('/:customerId/history', canView(), (req, res, next) =>
  send(res, next, statementHistory(liveDb, req.params.customerId), (statements) => ({ statements }))
);

/* The PREVIEW. Reads only — generating a preview must not create a record, or
   an operator checking a figure would litter the history. */
r.get('/:customerId/preview', canView(), (req, res, next) =>
  send(res, next,
    buildStatementFor(liveDb, req.params.customerId, {
      from: req.query.from, to: req.query.to, currency: req.query.currency,
      generatedAt: new Date(),
    }),
    (statement) => ({ statement: serializeStatement(statement) }))
);

/* The DOCUMENT, for staff to check before sending or to keep. */
r.get('/:customerId/pdf', canView(), (req, res, next) => {
  renderStatementDocument(liveDb, req.params.customerId, {
    from: req.query.from, to: req.query.to, currency: req.query.currency,
    generatedAt: new Date(),
  })
    .then(({ bytes, filename }) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(bytes);
    })
    .catch((err) => {
      if (err instanceof StatementError) return res.status(err.status).json(err.body);
      next(err);
    });
});

r.post('/:customerId/send', canSend(), (req, res, next) =>
  send(res, next, sendStatement(liveDb, req.params.customerId, req.body, req.user),
    (statement) => ({ statement }))
);

/* No route sets `sent`, deliberately. Only the outbox's confirmed delivery
   does — see src/notifications/worker.js. */

export default r;
