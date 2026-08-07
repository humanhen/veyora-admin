/* Invoice PDF delivery (Final Handover, Phase 5).
 *
 * Two entry points onto ONE generator:
 *
 *   GET /admin/invoices/:invoiceId/pdf   staff, gated on `payments.view`
 *   GET /user/invoices/:invoiceId/pdf    the customer, THEIR OWN invoice only
 *
 * WHAT MAKES ACCESS SAFE
 *
 * There is no route that takes an invoice id and returns a document without
 * first proving the caller is entitled to it. The customer route reads the
 * invoice WITH a `customer_id = $2` predicate, so another customer's id is a
 * 404 rather than a 403 — distinguishing them would confirm the invoice exists
 * to anyone enumerating ids. The staff route is capability-gated, with no role
 * fallback.
 *
 * EVERY FIGURE COMES FROM THE SERVER
 *
 * The request body is empty and the query string is ignored. Amounts, totals,
 * tax, the settlement state and the due date are read or derived from stored
 * rows. Nothing a browser sends can influence what the document says.
 *
 * CACHING
 *
 * `private, no-store`. An invoice is a customer's financial document; a shared
 * cache holding one is a disclosure, and a browser cache holding a *stale* one
 * would show a "DUE" stamp on an invoice that has since been paid.
 */

import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../authmw.js';
import { requirePermission } from '../permissions.js';
import { brandConfig } from '../documents/brand-config.js';
import { assembleInvoiceData, invoiceFilename, renderInvoicePdf } from '../documents/invoice-pdf.js';

export class DocumentError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'document error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

const INVOICE_COLUMNS = `id, number, order_id, order_number, customer_id, amount, provider,
  status, issued_on, settlement_state, settlement_currency, amount_settled_minor,
  amount_refunded_minor, settled_at, settlement_reference`;

/**
 * Reads everything one invoice document needs.
 *
 * @param customerId when given, the invoice MUST belong to it. This is the
 *   ownership check, applied in SQL rather than compared afterwards, so there
 *   is no branch in which a row is loaded and then rejected.
 */
export async function loadInvoiceDocument(db, invoiceRef, { customerId = null } = {}) {
  const params = [invoiceRef];
  let ownership = '';
  if (customerId) { params.push(customerId); ownership = 'and customer_id = $2'; }

  const { rows } = await db.query(
    `select ${INVOICE_COLUMNS} from invoices
      where (id = $1 or number = $1) ${ownership} limit 1`,
    params
  );
  const invoice = rows[0];
  if (!invoice) throw new DocumentError(404, { error: 'That invoice could not be found.' });

  const { rows: customers } = await db.query(
    `select id, business, first_name, last_name, email, tax_id, address, city, state, zip,
            country, payment_terms
       from users where id = $1 limit 1`,
    [invoice.customer_id]
  );

  const { rows: orders } = await db.query(
    `select id, number, currency, fx_rate, discount, total, items
       from orders where id = $1 limit 1`,
    [invoice.order_id]
  );
  const order = orders[0] || null;

  /* The order's stored lines. `items` is jsonb written by the ordering path;
     it is the record of what was sold at the prices that applied, which is
     exactly what an invoice must reproduce. */
  let orderLines = [];
  if (order && Array.isArray(order.items)) orderLines = order.items;
  else if (order && typeof order.items === 'string') {
    try { orderLines = JSON.parse(order.items) || []; } catch { orderLines = []; }
  }

  /* The accounts-payable contact if the store has one, else the primary. This
     is the person who actually has to pay it, and naming them is the
     difference between an invoice that reaches a desk and one that circulates.
     A store with no contacts is normal and the block is simply omitted. */
  const { rows: contacts } = await db.query(
    `select first_name, last_name, email, responsibilities, is_primary
       from customer_contacts
      where customer_id = $1 and is_active
      order by ('accounts_payable' = any(responsibilities)) desc, is_primary desc, id
      limit 1`,
    [invoice.customer_id]
  ).catch(() => ({ rows: [] }));

  /* A live hosted payment link, where one is open. Printed on the document so
     a customer can pay from the invoice itself. */
  const { rows: sessions } = await db.query(
    `select id, status, hosted_url from payment_sessions
      where invoice_id = $1 and status = 'open'
      order by created_at desc limit 1`,
    [invoice.id]
  ).catch(() => ({ rows: [] }));

  return {
    invoice,
    customer: customers[0] || null,
    order,
    orderLines,
    contact: contacts[0] || null,
    session: sessions[0] || null,
  };
}

/** Builds the PDF for one invoice. Injected `asOf` decides "overdue". */
export async function buildInvoicePdf(db, invoiceRef, { customerId = null, asOf = new Date(), brand = null } = {}) {
  const loaded = await loadInvoiceDocument(db, invoiceRef, { customerId });
  const data = assembleInvoiceData({
    brand: brand || brandConfig(),
    invoice: loaded.invoice,
    order: loaded.order,
    orderLines: loaded.orderLines,
    customer: loaded.customer,
    contact: loaded.contact,
    session: loaded.session,
    asOf,
  });
  return {
    bytes: await renderInvoicePdf(data),
    filename: invoiceFilename(loaded.invoice.number),
    data,
  };
}

/* ---------------------------------------------------------------------------
   Response
   --------------------------------------------------------------------------- */

function sendPdf(res, { bytes, filename }) {
  res.setHeader('Content-Type', 'application/pdf');
  /* `inline` so a browser shows it, with a stable filename for the download
     the customer then chooses. The name is already restricted to filesystem-
     and header-safe characters by `invoiceFilename`. */
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Content-Length', String(bytes.length));
  /* An invoice is a customer's financial document. `private` keeps it out of
     any shared cache; `no-store` keeps a stale "DUE" stamp from being shown
     on an invoice that has since been paid. */
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(bytes);
}

function handle(res, next, promise) {
  promise
    .then((result) => sendPdf(res, result))
    .catch((err) => {
      if (err instanceof DocumentError) return res.status(err.status).json(err.body);
      next(err);
    });
}

const liveDb = { query: (sql, params) => pool.query(sql, params) };

/* ---------------------------------------------------------------------------
   Staff
   --------------------------------------------------------------------------- */

export const adminInvoiceDocumentRoutes = Router();
adminInvoiceDocumentRoutes.use(requireAuth());

/* `payments.view` rather than a new capability: reading an invoice document is
   reading the payment state of an invoice, which is exactly what that
   capability describes. Inventing a `documents.view` key would mean two grants
   for one authority. */
adminInvoiceDocumentRoutes.get('/:invoiceId/pdf', requirePermission('payments.view'), (req, res, next) =>
  handle(res, next, buildInvoicePdf(liveDb, req.params.invoiceId))
);

/* ---------------------------------------------------------------------------
   Customer
   --------------------------------------------------------------------------- */

export const customerInvoiceDocumentRoutes = Router();
customerInvoiceDocumentRoutes.use(requireAuth());

customerInvoiceDocumentRoutes.get('/invoices/:invoiceId/pdf', (req, res, next) =>
  handle(res, next, buildInvoicePdf(liveDb, req.params.invoiceId, { customerId: req.user?.id }))
);

export default adminInvoiceDocumentRoutes;
