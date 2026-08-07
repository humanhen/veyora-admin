/* The Veyora account statement document (Final Handover, Phase 6).
 *
 * Built on the same layout primitives as the invoice, deliberately: a customer
 * receiving both should not be able to tell they came from different code.
 *
 * DETERMINISM, WITH ONE HONEST EXCEPTION
 *
 * A statement carries a GENERATED timestamp, which the brief requires. That
 * makes two generations at different times legitimately different documents —
 * unlike an invoice, where regeneration must be byte-identical. The timestamp
 * is INJECTED rather than read from a clock here, so a test can pin it and the
 * output is deterministic for a fixed input including that stamp.
 */

import {
  COLOR, MARGIN, PAGE, createCanvas, createDocument, drawTable, finish,
} from './pdf-layout.js';
import { addressLines, bankBlock } from './brand-config.js';
import { fromMinorUnits } from '../payments/invoice-payments.js';
import { RECIPIENT_LABELS, readableDate } from './statement.js';

const KIND_LABELS = Object.freeze({
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit note',
  refund: 'Refund',
});

const money = (minor, currency) => `${fromMinorUnits(minor, currency)} ${currency}`;

export async function renderStatementPdf(statement) {
  const { brand, customer, currency } = statement;

  const doc = await createDocument({
    title: `Veyora account statement — ${customer?.business || ''}`,
    author: brand?.legalName || 'Veyora',
    subject: `Account statement ${statement.period.from} to ${statement.period.to}`,
    creationDate: statement.generatedAt instanceof Date
      ? statement.generatedAt : new Date(statement.generatedAt || '2000-01-01T00:00:00.000Z'),
  });

  const canvas = createCanvas(doc, {
    onNewPage(c, pageNumber) {
      if (pageNumber > 1) {
        c.text(`Account statement — ${customer?.business || ''} — ${statement.period.label}`,
          { size: 8.5, font: doc.fonts.bold, color: COLOR.muted });
        c.rule({ gap: 2 });
        c.move(8);
      }
    },
  });

  canvas.newPage();
  masthead(canvas, doc, brand, statement);
  parties(canvas, doc, brand, customer);
  summary(canvas, doc, statement, currency);
  ledger(canvas, doc, statement, currency);
  ageing(canvas, doc, statement, currency);
  paymentNote(canvas, doc, brand, statement);
  footer(canvas, doc, brand);
  stampPageNumbers(doc);

  return finish(doc);
}

function masthead(canvas, doc, brand, statement) {
  const startY = canvas.y;

  canvas.page.drawText('VEYORA', {
    x: MARGIN.left, y: startY - 18, size: 18, font: doc.fonts.bold, color: COLOR.accent,
  });

  const rightX = MARGIN.left + canvas.contentWidth / 2;
  const rightWidth = canvas.contentWidth / 2;

  canvas.absolute('ACCOUNT STATEMENT', {
    x: rightX, yPos: startY - 15, size: 12, font: doc.fonts.bold, color: COLOR.accent,
    align: 'right', width: rightWidth,
  });
  canvas.absolute(statement.period.label, {
    x: rightX, yPos: startY - 29, size: 9, color: COLOR.ink, align: 'right', width: rightWidth,
  });
  canvas.absolute(`Currency: ${statement.currency}`, {
    x: rightX, yPos: startY - 42, size: 8.5, color: COLOR.muted, align: 'right', width: rightWidth,
  });
  /* The generated timestamp. A statement is a point-in-time view and saying
     when it was taken is the difference between a document and a claim. */
  const generated = statement.generatedAt instanceof Date
    ? statement.generatedAt.toISOString() : String(statement.generatedAt || '');
  canvas.absolute(`Generated ${generated.slice(0, 16).replace('T', ' ')} UTC`, {
    x: rightX, yPos: startY - 54, size: 7.5, color: COLOR.muted, align: 'right', width: rightWidth,
  });

  canvas.y = startY - 66;
  canvas.rule({ gap: 4 });
  canvas.move(12);
}

function parties(canvas, doc, brand, customer) {
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
    brand?.legalName,
    ...(brand ? addressLines(brand) : []),
    brand?.taxNumber ? `VAT / tax no. ${brand.taxNumber}` : null,
    brand?.contactEmail,
  ].filter(Boolean);

  const account = [
    customer?.business,
    customer?.customer_number ? `Customer ${customer.customer_number}` : null,
    ...[customer?.address, customer?.city,
      [customer?.state, customer?.zip].filter(Boolean).join(' ') || null,
      customer?.country].filter((v) => v != null && String(v).trim() !== ''),
  ].filter(Boolean);

  const leftEnd = block(MARGIN.left, 'FROM', issuer);
  const rightEnd = block(MARGIN.left + canvas.contentWidth / 2 + 10, 'ACCOUNT', account);

  canvas.y = Math.min(leftEnd, rightEnd) - 6;
  canvas.move(6);
}

function summary(canvas, doc, statement, currency) {
  const c = currency;
  const boxWidth = (canvas.contentWidth - 20) / 3;
  const top = canvas.y;

  const box = (index, label, value, { bold = true } = {}) => {
    const x = MARGIN.left + index * (boxWidth + 10);
    canvas.page.drawRectangle({
      x, y: top - 42, width: boxWidth, height: 42, color: COLOR.band,
    });
    canvas.absolute(label, { x: x + 10, yPos: top - 16, size: 7, font: doc.fonts.bold, color: COLOR.muted });
    canvas.absolute(value, {
      x: x + 10, yPos: top - 32, size: 11, font: bold ? doc.fonts.bold : doc.fonts.regular,
      color: COLOR.ink,
    });
  };

  box(0, 'OPENING BALANCE', money(statement.openingMinor, c));
  box(1, 'MOVEMENTS', `${statement.lines.length}`);
  box(2, 'CLOSING BALANCE', money(statement.closingMinor, c));

  canvas.y = top - 42;
  canvas.move(14);
}

function ledger(canvas, doc, statement, currency) {
  const c = currency;
  const w = canvas.contentWidth;
  const columns = [
    { key: 'date', label: 'DATE', width: w * 0.13 },
    { key: 'type', label: 'TYPE', width: w * 0.13 },
    { key: 'reference', label: 'REFERENCE', width: w * 0.17 },
    { key: 'description', label: 'DETAIL', width: w * 0.21 },
    { key: 'debit', label: 'DEBIT', width: w * 0.12, align: 'right' },
    { key: 'credit', label: 'CREDIT', width: w * 0.12, align: 'right' },
    { key: 'balance', label: 'BALANCE', width: w * 0.12, align: 'right' },
  ];

  const rows = [
    {
      date: statement.period.from, type: '', reference: '',
      description: 'Opening balance', debit: '', credit: '',
      balance: fromMinorUnits(statement.openingMinor, c),
    },
    ...statement.lines.map((l) => ({
      date: l.date,
      type: KIND_LABELS[l.kind] || l.kind,
      reference: l.reference,
      description: l.description,
      debit: l.debitMinor ? fromMinorUnits(l.debitMinor, c) : '',
      credit: l.creditMinor ? fromMinorUnits(l.creditMinor, c) : '',
      balance: fromMinorUnits(l.balanceMinor, c),
    })),
    {
      date: statement.period.to, type: '', reference: '',
      description: 'Closing balance',
      debit: fromMinorUnits(statement.totals.debitMinor, c),
      credit: fromMinorUnits(statement.totals.creditMinor, c),
      balance: fromMinorUnits(statement.closingMinor, c),
    },
  ];

  drawTable(canvas, { columns, rows, size: 8 });
  canvas.move(4);

  if (statement.lines.length === 0) {
    /* An empty period is a real and useful answer — "nothing happened" is
       what a customer chasing a discrepancy needs to be told plainly. */
    canvas.paragraph('There was no activity on this account during the period.',
      { size: 8.5, color: COLOR.muted });
    canvas.move(4);
  }
}

function ageing(canvas, doc, statement, currency) {
  const c = currency;
  const a = statement.ageing;
  if (!a || (a.current + a.days30 + a.days60 + a.days90plus) === 0) return;

  canvas.ensure(50);
  canvas.text('OUTSTANDING BY AGE', { size: 7.5, font: doc.fonts.bold, color: COLOR.muted, lineGap: 6 });

  const w = canvas.contentWidth;
  drawTable(canvas, {
    size: 8,
    columns: [
      { key: 'bucket', label: 'AGE', width: w * 0.4 },
      { key: 'amount', label: 'AMOUNT', width: w * 0.6, align: 'right' },
    ],
    rows: [
      { bucket: '0–30 days', amount: money(a.current, c) },
      { bucket: '31–60 days', amount: money(a.days30, c) },
      { bucket: '61–90 days', amount: money(a.days60, c) },
      { bucket: 'Over 90 days', amount: money(a.days90plus, c) },
    ],
  });
  canvas.move(6);
}

function paymentNote(canvas, doc, brand, statement) {
  const bank = brand ? bankBlock(brand) : null;
  if (!bank && statement.closingMinor <= 0) return;

  canvas.ensure(50);
  canvas.text('PAYMENT', { size: 7.5, font: doc.fonts.bold, color: COLOR.muted, lineGap: 6 });

  if (statement.closingMinor > 0) {
    canvas.paragraph(
      `The balance shown is payable on your usual account terms. Individual invoices can also be `
      + `paid securely online from your account area; each invoice carries its own payment link.`,
      { size: 8.5, color: COLOR.ink });
  } else if (statement.closingMinor < 0) {
    /* A credit balance is not a debt, and saying so avoids a call. */
    canvas.paragraph('Your account is in credit. This amount will be applied against future orders.',
      { size: 8.5, color: COLOR.ink });
  }

  if (bank) {
    canvas.move(2);
    for (const line of bank) canvas.paragraph(line, { size: 8.5, color: COLOR.ink });
    canvas.paragraph('Please quote your customer number with any transfer.',
      { size: 8, color: COLOR.muted });
  }
  canvas.move(6);
}

function footer(canvas, doc, brand) {
  if (!brand?.footerText && !brand?.websiteUrl) return;
  canvas.rule({ gap: 8 });
  canvas.move(6);
  if (brand.footerText) canvas.paragraph(brand.footerText, { size: 7.5, color: COLOR.muted });
  if (brand.websiteUrl) canvas.paragraph(brand.websiteUrl, { size: 7.5, color: COLOR.muted });
}

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

export { RECIPIENT_LABELS, readableDate };
