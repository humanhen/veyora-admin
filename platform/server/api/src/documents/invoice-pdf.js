/* The Veyora invoice document (Final Handover, Phase 5).
 *
 * Replaces the admin panel's "Download PDF" button, which produced a toast
 * saying no document existed.
 *
 * THE VISUAL SOURCE OF TRUTH IS ABSENT
 *
 * `source-assets/invoice-reference/approved-invoice-reference.pdf` does not
 * exist and there is no `source-assets/` directory. So this is a clean,
 * neutral Veyora template with every FUNCTIONAL behaviour complete, and final
 * visual matching against the historical invoice is recorded as the single
 * unresolved invoice-design item. It is a visual acceptance dependency, not
 * permission to leave generation unfinished.
 *
 * NOTHING IS INVENTED
 *
 * Every legal and business fact comes from `brand-config.js`, where each is an
 * environment variable with a visibly-unset default. An unset field is OMITTED
 * rather than printed as a placeholder: an invoice with no VAT line is a normal
 * invoice, while one carrying «NOT CONFIGURED» is a document nobody should
 * send. The gaps are reported to STAFF, never to a customer.
 *
 * EVERY FIGURE IS COMPUTED ON THE SERVER
 *
 * The document is built from the order's stored lines and the invoice's stored
 * amount. Nothing is passed in from a browser and nothing is recomputed in one
 * — a total that a page calculated is a total nobody can reconcile.
 *
 * DETERMINISM
 *
 * No clock is read. The PDF's creation date comes from the invoice's own
 * `issued_on`, so regenerating an unchanged invoice produces byte-identical
 * output — asserted in the tests.
 */

import fs from 'node:fs';
import {
  COLOR, MARGIN, PAGE, createCanvas, createDocument, drawTable, finish, sanitize,
} from './pdf-layout.js';
import { addressLines, bankBlock, configurationGaps } from './brand-config.js';
import { fromMinorUnits, toMinorUnits } from '../payments/invoice-payments.js';

/* ---------------------------------------------------------------------------
   Presentation of the settlement state
   --------------------------------------------------------------------------- */

/* An invoice outstanding on agreed account terms is NOT delinquent, so it is
   never stamped "UNPAID" — that word belongs to something overdue. "Overdue"
   is derived from the due date, not stored, so it cannot drift. */
const STATE_STAMPS = Object.freeze({
  on_terms: { label: 'DUE', color: COLOR.muted },
  overdue: { label: 'OVERDUE', color: COLOR.warning },
  processing: { label: 'PAYMENT CONFIRMING', color: COLOR.muted },
  paid: { label: 'PAID', color: COLOR.positive },
  part_refunded: { label: 'PARTLY REFUNDED', color: COLOR.warning },
  refunded: { label: 'REFUNDED', color: COLOR.negative },
  void: { label: 'CANCELLED', color: COLOR.negative },
});

/**
 * Which stamp an invoice carries.
 *
 * `asOf` is injected, so "overdue" is decided by the caller's clock rather
 * than by a clock inside a document generator — which is what makes the output
 * deterministic for a given input.
 */
export function stampFor(invoice, { asOf = null } = {}) {
  const state = String(invoice?.settlement_state || 'on_terms');
  if (state === 'paid') return STATE_STAMPS.paid;
  if (state === 'void') return STATE_STAMPS.void;
  if (state === 'processing') return STATE_STAMPS.processing;
  if (state === 'refunded') {
    const settled = Number(invoice.amount_settled_minor || 0);
    const refunded = Number(invoice.amount_refunded_minor || 0);
    return refunded > 0 && refunded < settled ? STATE_STAMPS.part_refunded : STATE_STAMPS.refunded;
  }
  const due = invoice?.due_on ? new Date(invoice.due_on) : null;
  if (due && asOf && due.getTime() < new Date(asOf).getTime()) return STATE_STAMPS.overdue;
  return STATE_STAMPS.on_terms;
}

/** The due date, derived from the issue date and the customer's terms. Never
 *  stored, so it cannot disagree with the terms actually on the account. */
export function dueDateFor(issuedOn, paymentTermsDays) {
  if (!issuedOn) return null;
  const d = new Date(issuedOn);
  if (Number.isNaN(d.getTime())) return null;
  const days = Number.isFinite(Number(paymentTermsDays)) ? Number(paymentTermsDays) : 30;
  return new Date(d.getTime() + days * 86_400_000);
}

/* ISO dates only. A locale-dependent format on an international invoice is a
   genuine ambiguity: 03/04/2026 is two different days. */
const isoDate = (value) => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

const moneyText = (minor, currency) => `${fromMinorUnits(minor, currency)} ${currency}`;

/* ---------------------------------------------------------------------------
   The document
   --------------------------------------------------------------------------- */

/**
 * Builds one invoice PDF.
 *
 * @param data the SERVER-ASSEMBLED invoice (see `assembleInvoiceData`).
 * @returns a Buffer.
 */
export async function renderInvoicePdf(data) {
  const { brand, invoice, customer, lines, totals, payment } = data;
  const currency = totals.currency;

  const doc = await createDocument({
    title: `Veyora invoice ${invoice.number}`,
    author: brand.legalName || 'Veyora',
    subject: `Invoice ${invoice.number}`,
    /* The invoice's own issue date, not now(). This is what makes regeneration
       byte-identical. */
    creationDate: new Date(`${isoDate(invoice.issuedOn) || '2000-01-01'}T00:00:00.000Z`),
  });

  const stamp = data.stamp;

  /* The logo is embedded HERE because embedding is async and drawing is not.
     A missing, unreadable or unsupported file falls back to the wordmark: an
     invoice must never fail over a decorative asset. */
  const logo = await embedLogo(doc, brand.logoPath);

  const canvas = createCanvas(doc, {
    onNewPage(c, pageNumber) {
      /* A running header from page two, so a page that arrives on its own is
         still identifiable. Page one carries the full masthead instead. */
      if (pageNumber > 1) {
        c.text(`Invoice ${invoice.number}`, { size: 9, font: doc.fonts.bold, color: COLOR.muted });
        c.rule({ gap: 2 });
        c.move(8);
      }
    },
  });

  canvas.newPage();
  masthead(canvas, doc, brand, invoice, stamp, logo);
  parties(canvas, doc, brand, customer, invoice);
  itemTable(canvas, doc, lines, currency);
  totalsBlock(canvas, doc, totals, currency);
  paymentBlock(canvas, doc, brand, payment, totals, currency);
  footer(canvas, doc, brand, invoice);

  /* Page numbering is stamped last, because "of N" is not knowable until every
     page exists. */
  stampPageNumbers(doc);

  return finish(doc);
}

/**
 * Embeds the configured logo, or returns null.
 *
 * Every failure path returns null rather than throwing: an absent file, an
 * unreadable one, a format pdf-lib cannot embed, or a corrupt image. A
 * decorative asset must never be able to stop a customer downloading their
 * invoice.
 */
async function embedLogo(doc, logoPath) {
  if (!logoPath) return null;
  try {
    const bytes = fs.readFileSync(logoPath);
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (isPng) return await doc.pdf.embedPng(bytes);
    if (isJpg) return await doc.pdf.embedJpg(bytes);
    return null;
  } catch {
    return null;
  }
}

function masthead(canvas, doc, brand, invoice, stamp, logo) {
  const startY = canvas.y;

  let drewLogo = false;
  if (logo) {
    const scaled = logo.scaleToFit(140, 44);
    canvas.page.drawImage(logo, {
      x: MARGIN.left, y: startY - scaled.height, width: scaled.width, height: scaled.height,
    });
    drewLogo = true;
  }
  if (!drewLogo) {
    canvas.page.drawText('VEYORA', {
      x: MARGIN.left, y: startY - 18, size: 18, font: doc.fonts.bold, color: COLOR.accent,
    });
    if (brand.tradingName && brand.tradingName !== brand.legalName) {
      canvas.page.drawText(sanitize(brand.tradingName), {
        x: MARGIN.left, y: startY - 31, size: 8, font: doc.fonts.regular, color: COLOR.muted,
      });
    }
  }

  /* Right column: the document's identity. */
  const rightX = MARGIN.left + canvas.contentWidth / 2;
  const rightWidth = canvas.contentWidth / 2;
  let ry = startY - 4;
  const rightLine = (label, value, { font = doc.fonts.regular, size = 9, color = COLOR.ink } = {}) => {
    if (!value) return;
    canvas.absolute(label, { x: rightX, yPos: ry - size, size: 7.5, color: COLOR.muted });
    canvas.absolute(value, { x: rightX, yPos: ry - size, size, font, color, align: 'right', width: rightWidth });
    ry -= size + 5;
  };

  canvas.absolute('INVOICE', {
    x: rightX, yPos: ry - 13, size: 13, font: doc.fonts.bold, color: COLOR.accent,
    align: 'right', width: rightWidth,
  });
  ry -= 22;

  rightLine('Number', invoice.number, { font: doc.fonts.bold, size: 10 });
  rightLine('Issued', isoDate(invoice.issuedOn));
  rightLine('Due', isoDate(invoice.dueOn));
  rightLine('Terms', invoice.termsLabel);
  rightLine('Order', invoice.orderNumber);
  rightLine('Your reference', invoice.customerReference);

  /* The status stamp, right-aligned under the identity block. */
  canvas.absolute(stamp.label, {
    x: rightX, yPos: ry - 11, size: 11, font: doc.fonts.bold, color: stamp.color,
    align: 'right', width: rightWidth,
  });
  ry -= 20;

  canvas.y = Math.min(startY - 62, ry) - 6;
  canvas.rule({ gap: 4 });
  canvas.move(12);
}

function parties(canvas, doc, brand, customer, invoice) {
  const colWidth = canvas.contentWidth / 2 - 10;
  const top = canvas.y;

  const block = (x, heading, lines) => {
    let ly = top;
    canvas.absolute(heading, { x, yPos: ly - 7.5, size: 7.5, font: doc.fonts.bold, color: COLOR.muted });
    ly -= 15;
    for (const line of lines) {
      if (!line) continue;
      canvas.absolute(line, { x, yPos: ly - 9, size: 9, color: COLOR.ink });
      ly -= 12.5;
    }
    return ly;
  };

  const issuer = [
    brand.legalName,
    ...addressLines(brand),
    brand.companyNumber ? `Company no. ${brand.companyNumber}` : null,
    brand.taxNumber ? `VAT / tax no. ${brand.taxNumber}` : null,
    brand.contactEmail,
    brand.contactPhone,
  ].filter(Boolean);

  const billTo = [
    customer.business || customer.name,
    ...customer.addressLines,
    customer.taxId ? `VAT / tax no. ${customer.taxId}` : null,
    /* The accounts-payable contact where one is recorded, else the primary.
       This is the person who actually has to pay it. */
    customer.billingContact ? `Attn: ${customer.billingContact}` : null,
    customer.billingContactEmail,
  ].filter(Boolean);

  const leftEnd = block(MARGIN.left, 'FROM', issuer);
  const rightEnd = block(MARGIN.left + canvas.contentWidth / 2 + 10, 'INVOICE TO', billTo);

  canvas.y = Math.min(leftEnd, rightEnd) - 6;
  canvas.move(6);
}

function itemTable(canvas, doc, lines, currency) {
  /* Column widths sum to the content width exactly. The layout layer refuses a
     table wider than the page rather than letting one silently overflow. */
  const w = canvas.contentWidth;
  const columns = [
    { key: 'sku', label: 'SKU / MODEL', width: w * 0.16 },
    { key: 'description', label: 'DESCRIPTION', width: w * 0.36 },
    { key: 'qty', label: 'QTY', width: w * 0.09, align: 'right' },
    { key: 'unit', label: 'UNIT', width: w * 0.13, align: 'right' },
    { key: 'discount', label: 'DISCOUNT', width: w * 0.13, align: 'right' },
    { key: 'total', label: 'AMOUNT', width: w * 0.13, align: 'right' },
  ];

  drawTable(canvas, {
    columns,
    rows: lines.map((line) => ({
      sku: line.sku,
      description: [line.name, line.colour].filter(Boolean).join(' — '),
      qty: String(line.qty),
      unit: fromMinorUnits(line.unitMinor, currency),
      discount: line.discountMinor ? `-${fromMinorUnits(line.discountMinor, currency)}` : '—',
      total: fromMinorUnits(line.totalMinor, currency),
    })),
  });
  canvas.move(6);
}

function totalsBlock(canvas, doc, totals, currency) {
  const labelWidth = canvas.contentWidth * 0.62;
  const valueWidth = canvas.contentWidth - labelWidth;
  const x = MARGIN.left;

  const line = (label, minor, { bold = false, color = COLOR.ink, size = 9.5, sign = '' } = {}) => {
    canvas.ensure(size + 6);
    const font = bold ? doc.fonts.bold : doc.fonts.regular;
    canvas.absolute(label, { x: x + labelWidth - 140, yPos: canvas.y - size, size, font, color, align: 'right', width: 140 });
    canvas.absolute(`${sign}${moneyText(minor, currency)}`, {
      x: x + labelWidth, yPos: canvas.y - size, size, font, color, align: 'right', width: valueWidth,
    });
    canvas.y -= size + 6;
  };

  line('Subtotal', totals.subtotalMinor);
  if (totals.discountMinor) line('Discount', totals.discountMinor, { sign: '-' });
  if (totals.shippingMinor) line('Shipping', totals.shippingMinor);
  /* Zero tax is PRINTED, not omitted. "Tax 0.00" and no tax line mean
     different things to a customer's bookkeeper, and the first is what is
     true when tax was calculated and came to nothing. */
  line(totals.taxLabel, totals.taxMinor);

  canvas.rule({ x: MARGIN.left + labelWidth - 140, width: canvas.contentWidth - labelWidth + 140, gap: 2 });
  canvas.move(4);
  line('Total', totals.totalMinor, { bold: true, size: 11 });

  if (totals.settledMinor > 0) {
    line('Paid', totals.settledMinor, { sign: '-', color: COLOR.positive });
    if (totals.refundedMinor > 0) line('Refunded', totals.refundedMinor, { color: COLOR.warning });
    line('Balance due', totals.balanceDueMinor, { bold: true, size: 11 });
  }

  if (totals.fxNote) {
    canvas.move(4);
    canvas.paragraph(totals.fxNote, { size: 7.5, color: COLOR.muted });
  }
  canvas.move(8);
}

function paymentBlock(canvas, doc, brand, payment, totals, currency) {
  const parts = [];

  if (payment.reference) {
    parts.push(`Payment reference: ${payment.reference}`);
  }
  if (payment.hostedUrl) {
    /* The secure hosted link, where one is live. Printed as a URL rather than
       a QR code: a QR on a PDF that is often forwarded as an image is a link
       nobody can verify before following. */
    parts.push('Pay securely online:');
    parts.push(payment.hostedUrl);
  }

  const bank = bankBlock(brand);
  const hasBank = Array.isArray(bank) && bank.length > 0;

  if (!parts.length && !hasBank) return;

  canvas.ensure(60);
  canvas.text('PAYMENT', { size: 7.5, font: doc.fonts.bold, color: COLOR.muted, lineGap: 6 });

  for (const part of parts) canvas.paragraph(part, { size: 8.5, color: COLOR.ink });

  if (hasBank) {
    canvas.move(2);
    for (const bankLine of bank) canvas.paragraph(bankLine, { size: 8.5, color: COLOR.ink });
    canvas.paragraph('Please quote the invoice number with any transfer.', { size: 8, color: COLOR.muted });
  }
  canvas.move(6);
}

function footer(canvas, doc, brand, invoice) {
  if (!brand.footerText && !brand.websiteUrl) return;
  canvas.rule({ gap: 8 });
  canvas.move(6);
  if (brand.footerText) canvas.paragraph(brand.footerText, { size: 7.5, color: COLOR.muted });
  if (brand.websiteUrl) canvas.paragraph(brand.websiteUrl, { size: 7.5, color: COLOR.muted });
}

/* "Page 1 of 3" can only be written once every page exists. */
function stampPageNumbers(doc) {
  const total = doc.pages.length;
  doc.pages.forEach((page, index) => {
    const label = `Page ${index + 1} of ${total}`;
    const width = doc.fonts.regular.widthOfTextAtSize(label, 7.5);
    page.drawText(label, {
      x: PAGE.width - MARGIN.right - width, y: MARGIN.bottom - 22,
      size: 7.5, font: doc.fonts.regular, color: COLOR.muted,
    });
  });
}

/* ---------------------------------------------------------------------------
   Assembling the data — the server's own numbers, nobody else's
   --------------------------------------------------------------------------- */

/**
 * Turns database rows into the document's input.
 *
 * Every monetary figure is derived here from stored values in MINOR UNITS. The
 * browser supplies nothing but an invoice id, and no total is recomputed on
 * the client — a figure a page calculated is a figure nobody can reconcile
 * against the ledger.
 */
export function assembleInvoiceData({
  brand, invoice, order, orderLines = [], customer, contact = null,
  session = null, asOf = null,
}) {
  const currency = String(invoice.settlement_currency || 'USD').toUpperCase();
  const toMinor = (value) => {
    const parsed = toMinorUnits(value ?? 0, currency);
    return parsed.ok ? parsed.minor : 0;
  };

  const lines = orderLines.map((line) => {
    const qty = Number(line.qty) || 0;
    const unitMinor = toMinor(line.price);
    const discountMinor = toMinor(line.discount || 0);
    return {
      sku: String(line.sku || line.model || ''),
      name: String(line.name || ''),
      colour: String(line.colour || line.color || ''),
      qty,
      unitMinor,
      discountMinor,
      totalMinor: qty * unitMinor - discountMinor,
    };
  });

  const subtotalMinor = lines.reduce((sum, l) => sum + l.qty * l.unitMinor, 0);
  const lineDiscountMinor = lines.reduce((sum, l) => sum + l.discountMinor, 0);
  const orderDiscountMinor = toMinor(order?.discount || 0);
  const discountMinor = lineDiscountMinor + orderDiscountMinor;
  const shippingMinor = toMinor(order?.shipping_total ?? order?.shipping ?? 0);
  const taxMinor = toMinor(order?.tax_total ?? order?.tax ?? 0);

  /* The invoice's OWN amount is authoritative for the total. The line sum is
     printed for the customer's benefit; if the two ever disagree, the invoice
     is what was issued and what the ledger moved. */
  const totalMinor = toMinor(invoice.amount);

  const settledMinor = Number(invoice.amount_settled_minor || 0);
  const refundedMinor = Number(invoice.amount_refunded_minor || 0);

  const termsDays = Number.isFinite(Number(customer?.payment_terms)) ? Number(customer.payment_terms) : 30;
  const dueOn = dueDateFor(invoice.issued_on, termsDays);

  /* A stamped FX rate is shown only when the order was actually placed in a
     currency other than the invoice's. Printing "rate 1.0000" on a
     same-currency invoice is noise that invites a question. */
  const orderCurrency = String(order?.currency || currency).toUpperCase();
  const fxRate = Number(order?.fx_rate);
  const fxNote = (orderCurrency !== currency && Number.isFinite(fxRate) && fxRate > 0)
    ? `Order placed in ${orderCurrency}; invoiced in ${currency} at the rate stamped on the order (${fxRate}).`
    : '';

  const customerAddress = [
    customer?.address, customer?.city,
    [customer?.state, customer?.zip].filter(Boolean).join(' ') || null,
    customer?.country,
  ].filter((v) => v != null && String(v).trim() !== '');

  const data = {
    brand,
    invoice: {
      id: String(invoice.id),
      number: String(invoice.number || ''),
      issuedOn: invoice.issued_on || null,
      dueOn,
      termsLabel: `Net ${termsDays}`,
      orderNumber: String(invoice.order_number || order?.number || ''),
      /* The customer's own purchase-order reference where they gave one. */
      customerReference: String(order?.customer_reference || order?.po_reference || ''),
      settlementState: String(invoice.settlement_state || 'on_terms'),
    },
    customer: {
      business: String(customer?.business || ''),
      name: `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim(),
      addressLines: customerAddress.map(String),
      taxId: String(customer?.tax_id || ''),
      billingContact: contact ? `${contact.first_name || ''} ${contact.last_name || ''}`.trim() : '',
      billingContactEmail: contact ? String(contact.email || '') : '',
    },
    lines,
    totals: {
      currency,
      subtotalMinor,
      discountMinor,
      shippingMinor,
      taxMinor,
      /* Always labelled, even at zero — see the comment in `totalsBlock`. */
      taxLabel: 'Tax',
      totalMinor,
      settledMinor,
      refundedMinor,
      balanceDueMinor: Math.max(0, totalMinor - settledMinor + refundedMinor),
      fxNote,
    },
    payment: {
      reference: String(invoice.settlement_reference || ''),
      hostedUrl: session && session.status === 'open' ? String(session.hosted_url || '') : '',
    },
    configurationGaps: configurationGaps(brand),
  };

  data.stamp = stampFor({ ...invoice, due_on: dueOn }, { asOf });
  return data;
}

/**
 * The download filename.
 *
 * STABLE for a given invoice: the same invoice always produces the same name,
 * so a customer's folder does not fill with `invoice(3).pdf`. Restricted to
 * characters that survive every filesystem and Content-Disposition header.
 */
export function invoiceFilename(invoiceNumber) {
  /* One fallback, not two. An earlier version substituted 'invoice' first and
     then 'document' if the result was empty, which made the second branch
     unreachable and the behaviour hard to state. */
  const safe = String(invoiceNumber ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  return `Veyora-Invoice-${safe || 'document'}.pdf`;
}
