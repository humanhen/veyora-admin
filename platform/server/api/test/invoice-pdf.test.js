/* Generated invoice documents (Final Handover, Phase 5).

   Builds REAL PDFs and inspects the bytes. Every invoice here is invented and
   uses example.test data; no real customer, amount or company detail appears.

   The reference invoice from the previous Veyora system is ABSENT, so these
   assert FUNCTION — content, pagination, currency, states, determinism and
   leakage — rather than pixel placement. Final visual matching is the single
   recorded design item. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
  BRAND_FIELDS, addressLines, bankBlock, configurationGaps, optionalGaps,
  isBrandComplete, resolveBrand,
} from '../src/documents/brand-config.js';
import {
  COLOR, MARGIN, PAGE, createCanvas, createDocument, drawTable, finish,
  measure, sanitize, truncate, wrap,
} from '../src/documents/pdf-layout.js';
import {
  assembleInvoiceData, dueDateFor, invoiceFilename, renderInvoicePdf, stampFor,
} from '../src/documents/invoice-pdf.js';
import {
  DocumentError, buildInvoicePdf, loadInvoiceDocument,
} from '../src/routes/invoice-documents.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const routeSrc = code('routes', 'invoice-documents.js');
const pdfSrc = code('documents', 'invoice-pdf.js');

/* A configured brand. Every value is an example.test placeholder — the point
   of the test is that CONFIGURED values are printed, not what they are. */
const BRAND = resolveBrand({
  VEYORA_LEGAL_NAME: 'Veyora Example Ltd',
  VEYORA_COMPANY_NUMBER: 'EX-000000',
  VEYORA_TAX_NUMBER: 'VATEX000000',
  VEYORA_ADDRESS_LINE1: '1 Example Way',
  VEYORA_ADDRESS_CITY: 'Exampleton',
  VEYORA_ADDRESS_POSTCODE: 'EX1 1EX',
  VEYORA_ADDRESS_COUNTRY: 'Exampleland',
  VEYORA_CONTACT_EMAIL: 'billing@example.test',
  VEYORA_BANK_NAME: 'Example Bank',
  VEYORA_BANK_IBAN: 'EX00 0000 0000 0000',
  VEYORA_INVOICE_FOOTER: 'Goods remain the property of the seller until paid in full.',
});

const T0 = new Date('2026-08-07T00:00:00.000Z');

const invoiceRow = (over = {}) => ({
  id: 'in_1', number: 'IN1001', order_id: 'o_1', order_number: 'SO1188',
  customer_id: 'u_cust1', amount: '1250.00', provider: 'Green Invoice', status: 'paid',
  issued_on: '2026-08-01', settlement_state: 'on_terms', settlement_currency: 'USD',
  amount_settled_minor: 0, amount_refunded_minor: 0, settled_at: null,
  settlement_reference: '', ...over,
});

const customerRow = (over = {}) => ({
  id: 'u_cust1', business: 'Example Optics', first_name: 'Sam', last_name: 'Example',
  email: 'sam@example.test', tax_id: 'VATCUST0001', address: '2 Example Street',
  city: 'Exampleburg', state: 'EX', zip: 'EX2 2EX', country: 'Exampleland',
  payment_terms: 30, ...over,
});

const line = (n, over = {}) => ({
  sku: `SKU-${String(n).padStart(4, '0')}`, name: `Example frame ${n}`,
  colour: 'Matte black', qty: 2, price: '25.00', discount: '0', ...over,
});

const orderRow = (over = {}) => ({
  id: 'o_1', number: 'SO1188', currency: 'USD', fx_rate: 1,
  discount: '0', total: '1250.00', tax_total: '0', shipping_total: '0',
  items: [line(1), line(2)], ...over,
});

/** Extracts every text string a PDF draws, so assertions are about what a
 *  READER SEES rather than about the source that produced it.
 *
 *  Content streams are Flate-compressed, so they are inflated first — the same
 *  thing any PDF viewer does. Reading the compressed bytes would test nothing:
 *  the first version of this helper found no text at all and every content
 *  assertion "passed" against an empty string. */
function textOf(bytes) {
  const raw = bytes.toString('latin1');
  const out = [];
  const streamRe = /stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    const slice = Buffer.from(raw.slice(start, end), 'latin1');
    let content;
    try {
      content = zlib.inflateSync(slice).toString('latin1');
    } catch {
      content = slice.toString('latin1'); // an uncompressed stream, or not text
    }
    /* pdf-lib emits HEX strings — `<5665796F7261> Tj` — not literal `(…)`
       ones. Both forms are valid PDF and a viewer reads either, so this does
       too; missing the hex form is why the first version of this helper
       extracted nothing. */
    for (const t of content.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)) {
      out.push(decodeHexString(t[1]));
    }
    for (const t of content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) {
      out.push(decodePdfString(t[1]));
    }
    /* `[(a) -20 (b)] TJ` — kerned runs. pdf-lib does not currently emit these
       for drawText, but a viewer handles both and so does this. */
    for (const t of content.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
      const parts = [
        ...[...t[1].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((p) => decodeHexString(p[1])),
        ...[...t[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)].map((p) => decodePdfString(p[1])),
      ];
      if (parts.length) out.push(parts.join(''));
    }
  }
  return out;
}

function decodeHexString(value) {
  const hex = value.replace(/\s+/g, '');
  const even = hex.length % 2 ? `${hex}0` : hex;
  let out = '';
  for (let i = 0; i < even.length; i += 2) out += String.fromCharCode(parseInt(even.slice(i, i + 2), 16));
  return out;
}

const PDF_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
function decodePdfString(value) {
  return value.replace(/\\(\d{1,3}|.)/g, (whole, ch) => {
    if (/^\d+$/.test(ch)) return String.fromCharCode(parseInt(ch, 8));
    return PDF_ESCAPES[ch] ?? ch;
  });
}

const allText = (bytes) => textOf(bytes).join('\n');

function pageCount(bytes) {
  const m = bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

async function build(over = {}) {
  const data = assembleInvoiceData({
    brand: BRAND,
    invoice: invoiceRow(over.invoice),
    order: orderRow(over.order),
    orderLines: over.lines || orderRow(over.order).items,
    customer: customerRow(over.customer),
    contact: over.contact ?? null,
    session: over.session ?? null,
    asOf: over.asOf || T0,
  });
  return { data, bytes: await renderInvoicePdf(data) };
}

// ===========================================================================
// 1-12 — configuration: nothing is invented
// ===========================================================================

test('1 — an unconfigured deployment reports every required gap and invents nothing', () => {
  const empty = resolveBrand({});
  const gaps = configurationGaps(empty);
  assert.ok(gaps.length >= 8, 'every required field must be reported');
  for (const gap of gaps) {
    assert.match(gap.env, /^VEYORA_/);
    assert.ok(gap.label.length > 3);
  }
  assert.equal(isBrandComplete(empty), false);
  /* And nothing plausible was substituted. */
  for (const field of BRAND_FIELDS) {
    assert.equal(empty[field.key], null, `${field.key} must be unset, not guessed`);
  }
});

test('2 — required and optional gaps are reported separately', () => {
  const empty = resolveBrand({});
  const required = configurationGaps(empty).map((g) => g.key);
  const optional = optionalGaps(empty).map((g) => g.key);
  assert.ok(required.includes('legalName'));
  assert.ok(required.includes('taxNumber'));
  assert.ok(optional.includes('bankIban'), 'a bank block is optional — an invoice without one is normal');
  assert.equal(required.filter((k) => optional.includes(k)).length, 0);
});

test('3 — an unset field is OMITTED from the document, never printed as a placeholder', async () => {
  const bare = resolveBrand({ VEYORA_LEGAL_NAME: 'Veyora Example Ltd' });
  const data = assembleInvoiceData({
    brand: bare, invoice: invoiceRow(), order: orderRow(),
    orderLines: orderRow().items, customer: customerRow(), asOf: T0,
  });
  const text = allText(await renderInvoicePdf(data));
  for (const placeholder of ['NOT CONFIGURED', 'TODO', 'PLACEHOLDER', 'undefined', 'null', 'XXX']) {
    assert.ok(!text.includes(placeholder), `the document printed ${placeholder}`);
  }
  /* The label DOES appear — the customer has a tax number and that is
     correct. What must not appear is the issuer's, which is unset. */
  assert.ok(!text.includes('VATEX000000'), 'an unset issuer tax number must not be printed');
  assert.ok(!text.includes('EX-000000'), 'nor an unset company number');
  assert.ok(!text.includes('Example Bank'), 'nor an unset bank block');
});

test('4 — a configured brand IS printed', async () => {
  const { bytes } = await build();
  const text = allText(bytes);
  assert.match(text, /Veyora Example Ltd/);
  assert.match(text, /EX-000000/);
  assert.match(text, /VATEX000000/);
  assert.match(text, /1 Example Way/);
  assert.match(text, /billing@example\.test/);
});

test('5 — the bank block appears only when bank details are configured', async () => {
  const withBank = allText((await build()).bytes);
  assert.match(withBank, /Example Bank/);
  assert.match(withBank, /EX00 0000 0000 0000/);

  const noBank = resolveBrand({ VEYORA_LEGAL_NAME: 'Veyora Example Ltd' });
  assert.equal(bankBlock(noBank), null, 'no half a bank block');
});

test('6 — the address prints only the lines that are set', () => {
  assert.deepEqual(addressLines(resolveBrand({ VEYORA_ADDRESS_LINE1: 'A', VEYORA_ADDRESS_COUNTRY: 'B' })),
    ['A', 'B']);
});

test('7 — the footer is the client’s wording, not invented legal text', async () => {
  const text = allText((await build()).bytes);
  assert.match(text, /Goods remain the property of the seller/);
  const bare = resolveBrand({ VEYORA_LEGAL_NAME: 'X' });
  assert.equal(bare.footerText, null, 'no default legal wording is supplied');
});

// ===========================================================================
// 8-20 — the document is a real PDF with the right content
// ===========================================================================

test('8 — the output is a real PDF', async () => {
  const { bytes } = await build();
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.slice(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 1500, 'a real document, not a stub');
  assert.match(bytes.toString('latin1').slice(-1024), /%%EOF/);
});

test('9 — the invoice number, dates, terms and order number are all present', async () => {
  const { bytes } = await build();
  const text = allText(bytes);
  assert.match(text, /IN1001/);
  assert.match(text, /2026-08-01/, 'the issue date');
  assert.match(text, /2026-08-31/, 'the due date, derived from Net 30');
  assert.match(text, /Net 30/);
  assert.match(text, /SO1188/);
});

test('10 — the due date is DERIVED from the terms, never stored', () => {
  assert.equal(dueDateFor('2026-08-01', 30).toISOString().slice(0, 10), '2026-08-31');
  assert.equal(dueDateFor('2026-08-01', 45).toISOString().slice(0, 10), '2026-09-15');
  assert.equal(dueDateFor('2026-08-01', 0).toISOString().slice(0, 10), '2026-08-01');
  assert.equal(dueDateFor(null, 30), null);
  /* And no stored column is read: `due_on` appears nowhere in the document
     queries, so the printed date cannot disagree with the terms on the
     account. The generator's internal `due_on` key carries the DERIVED
     value into the stamp check. */
  assert.ok(!/due_on/.test(routeSrc), 'no query may select a stored due date');
  assert.match(pdfSrc, /due_on: dueOn/, 'the stamp reads the derived value');
});

test('11 — the customer’s business, address and tax number are printed', async () => {
  const { bytes } = await build();
  const text = allText(bytes);
  assert.match(text, /Example Optics/);
  assert.match(text, /2 Example Street/);
  assert.match(text, /VATCUST0001/);
});

test('12 — the accounts-payable contact is named where one exists', async () => {
  const { bytes } = await build({
    contact: { first_name: 'Ada', last_name: 'Sterling', email: 'ap@example.test' },
  });
  const text = allText(bytes);
  assert.match(text, /Attn: Ada Sterling/);
  assert.match(text, /ap@example\.test/);
});

test('13 — a store with no contacts simply omits the block', async () => {
  const text = allText((await build({ contact: null })).bytes);
  assert.ok(!text.includes('Attn:'));
});

test('14 — every line prints SKU, description, colour, quantity and unit price', async () => {
  const { bytes } = await build();
  const text = allText(bytes);
  assert.match(text, /SKU-0001/);
  assert.match(text, /Example frame 1/);
  assert.match(text, /Matte black/);
  assert.match(text, /25\.00/);
});

test('15 — a customer purchase-order reference is printed when present', async () => {
  const { bytes } = await build({ order: { customer_reference: 'PO-778812' } });
  assert.match(allText(bytes), /PO-778812/);
});

test('16 — the filename is stable and safe', () => {
  assert.equal(invoiceFilename('IN1001'), 'Veyora-Invoice-IN1001.pdf');
  assert.equal(invoiceFilename('IN1001'), invoiceFilename('IN1001'), 'stable for a given invoice');
  /* Path traversal, quotes and separators cannot reach a header or a
     filesystem through the number. */
  assert.equal(invoiceFilename('../../etc/passwd'), 'Veyora-Invoice-....etcpasswd.pdf');
  assert.equal(invoiceFilename('a"b;c'), 'Veyora-Invoice-abc.pdf');
  assert.equal(invoiceFilename(''), 'Veyora-Invoice-document.pdf');
  assert.equal(invoiceFilename(null), 'Veyora-Invoice-document.pdf');
  assert.equal(invoiceFilename('///'), 'Veyora-Invoice-document.pdf');
});

// ===========================================================================
// 17-26 — money, currency, discounts, shipping, tax
// ===========================================================================

test('17 — totals are computed on the SERVER from stored lines', async () => {
  const { data } = await build();
  assert.equal(data.totals.subtotalMinor, 10000, '2 x 25.00 x 2 lines');
  assert.equal(data.totals.totalMinor, 125000, 'the invoice amount is authoritative');
  /* Nothing in the generator accepts a total from a caller. */
  assert.ok(!/body\.(total|subtotal|amount)/.test(pdfSrc));
});

test('18 — every supported currency renders with its own code', async () => {
  for (const currency of ['USD', 'CAD', 'EUR']) {
    const { bytes } = await build({ invoice: { settlement_currency: currency } });
    const text = allText(bytes);
    assert.match(text, new RegExp(`1250\\.00 ${currency}`), currency);
  }
});

test('19 — a discount is shown as a deduction', async () => {
  const { bytes, data } = await build({ order: { discount: '75.00' } });
  assert.equal(data.totals.discountMinor, 7500);
  const text = allText(bytes);
  assert.match(text, /Discount/);
  assert.match(text, /-75\.00 USD/);
});

test('20 — a per-line discount is shown on the line and in the total', async () => {
  const { bytes, data } = await build({ lines: [line(1, { discount: '10.00' }), line(2)] });
  assert.equal(data.totals.discountMinor, 1000);
  assert.match(allText(bytes), /-10\.00/);
});

test('21 — shipping is a separate line when charged', async () => {
  const { bytes } = await build({ order: { shipping_total: '18.50' } });
  const text = allText(bytes);
  assert.match(text, /Shipping/);
  assert.match(text, /18\.50 USD/);
});

test('22 — ZERO tax is printed, not omitted', async () => {
  /* "Tax 0.00" and no tax line mean different things to a bookkeeper, and the
     first is what is true when tax was calculated and came to nothing. */
  const { bytes } = await build({ order: { tax_total: '0' } });
  const text = allText(bytes);
  assert.match(text, /Tax/);
  assert.match(text, /0\.00 USD/);
});

test('23 — non-zero tax is printed with its amount', async () => {
  const { bytes } = await build({ order: { tax_total: '212.50' } });
  assert.match(allText(bytes), /212\.50 USD/);
});

test('24 — a stamped FX rate is shown only when the order currency differs', async () => {
  const same = await build({ order: { currency: 'USD', fx_rate: 1 } });
  assert.equal(same.data.totals.fxNote, '', 'no noise on a same-currency invoice');

  const differs = await build({ order: { currency: 'EUR', fx_rate: 0.92 } });
  assert.match(differs.data.totals.fxNote, /placed in EUR/);
  assert.match(allText(differs.bytes), /0\.92/);
});

test('25 — money is never computed with floating point multiplication', async () => {
  /* 29.97 * 100 is 2996.9999999999995. Amounts go through toMinorUnits, which
     parses the decimal string. */
  const { data } = await build({ lines: [line(1, { qty: 1, price: '29.97' })] });
  assert.equal(data.lines[0].unitMinor, 2997);
  assert.equal(data.totals.subtotalMinor, 2997);
});

test('26 — settled and refunded amounts appear with a balance due', async () => {
  const { bytes, data } = await build({ invoice: {
    settlement_state: 'refunded', amount_settled_minor: 125000,
    amount_refunded_minor: 25000, settled_at: '2026-08-05', settlement_reference: 'pi_test_1' } });
  assert.equal(data.totals.balanceDueMinor, 25000);
  const text = allText(bytes);
  assert.match(text, /Paid/);
  assert.match(text, /Refunded/);
  assert.match(text, /Balance due/);
});

// ===========================================================================
// 27-34 — payment states
// ===========================================================================

test('27 — an invoice on terms is stamped DUE, never UNPAID', async () => {
  /* An invoice outstanding on agreed account terms is not delinquent. */
  const { bytes } = await build();
  const text = allText(bytes);
  assert.match(text, /\bDUE\b/);
  assert.ok(!text.includes('UNPAID'));
});

test('28 — an invoice past its due date is stamped OVERDUE', async () => {
  const { bytes } = await build({ asOf: new Date('2026-09-15T00:00:00.000Z') });
  assert.match(allText(bytes), /OVERDUE/);
});

test('29 — a paid invoice is stamped PAID and shows the provider reference', async () => {
  const { bytes } = await build({ invoice: {
    settlement_state: 'paid', amount_settled_minor: 125000,
    settled_at: '2026-08-05', settlement_reference: 'pi_test_1' } });
  const text = allText(bytes);
  assert.match(text, /PAID/);
  assert.match(text, /pi_test_1/);
  assert.ok(!text.includes('OVERDUE'), 'a paid invoice is never overdue');
});

test('30 — a paid invoice past its due date is still PAID', async () => {
  const { bytes } = await build({
    invoice: { settlement_state: 'paid', amount_settled_minor: 125000,
      settled_at: '2026-08-05', settlement_reference: 'pi_1' },
    asOf: new Date('2027-01-01T00:00:00.000Z'),
  });
  assert.match(allText(bytes), /PAID/);
});

test('31 — partial and full refunds are stamped differently', () => {
  assert.equal(stampFor({ settlement_state: 'refunded',
    amount_settled_minor: 1000, amount_refunded_minor: 400 }).label, 'PARTLY REFUNDED');
  assert.equal(stampFor({ settlement_state: 'refunded',
    amount_settled_minor: 1000, amount_refunded_minor: 1000 }).label, 'REFUNDED');
});

test('32 — a confirming payment is stamped as such, not as paid', async () => {
  const { bytes } = await build({ invoice: { settlement_state: 'processing' } });
  const text = allText(bytes);
  assert.match(text, /PAYMENT CONFIRMING/);
  assert.ok(!/\bPAID\b/.test(text.replace(/PARTLY REFUNDED/g, '')));
});

test('33 — a void invoice is stamped CANCELLED', async () => {
  assert.match(allText((await build({ invoice: { settlement_state: 'void' } })).bytes), /CANCELLED/);
});

test('34 — a live hosted payment link is printed; a closed one is not', async () => {
  const open = await build({ session: { status: 'open', hosted_url: 'https://checkout.stripe.test/cs_1' } });
  assert.match(allText(open.bytes), /checkout\.stripe\.test\/cs_1/);

  const expired = await build({ session: { status: 'expired', hosted_url: 'https://checkout.stripe.test/cs_1' } });
  assert.ok(!allText(expired.bytes).includes('cs_1'), 'a dead link must not be printed');
});

// ===========================================================================
// 35-42 — layout: pagination, long values, determinism
// ===========================================================================

test('35 — a short invoice is one page', async () => {
  const { bytes } = await build();
  assert.equal(pageCount(bytes), 1);
});

test('36 — many items paginate, and every line still appears', async () => {
  const lines = Array.from({ length: 80 }, (_, i) => line(i + 1));
  const { bytes } = await build({ lines });
  assert.ok(pageCount(bytes) >= 2, 'eighty lines must not fit on one page');
  const text = allText(bytes);
  assert.match(text, /SKU-0001/);
  assert.match(text, /SKU-0080/, 'the last line must survive pagination');
});

test('37 — the table header repeats on every page', async () => {
  const { bytes } = await build({ lines: Array.from({ length: 80 }, (_, i) => line(i + 1)) });
  const headers = textOf(bytes).filter((t) => t === 'DESCRIPTION').length;
  assert.ok(headers >= 2, 'a continued table must carry its header');
});

test('38 — every page is numbered "n of N"', async () => {
  const { bytes } = await build({ lines: Array.from({ length: 80 }, (_, i) => line(i + 1)) });
  const total = pageCount(bytes);
  const text = allText(bytes);
  for (let i = 1; i <= total; i += 1) {
    assert.match(text, new RegExp(`Page ${i} of ${total}`), `page ${i}`);
  }
});

test('39 — a continued page carries the invoice number', async () => {
  const { bytes } = await build({ lines: Array.from({ length: 80 }, (_, i) => line(i + 1)) });
  const occurrences = textOf(bytes).filter((t) => t.includes('IN1001')).length;
  assert.ok(occurrences >= 2, 'a page arriving on its own must be identifiable');
});

test('40 — a very long company name or address does not overflow the page', async () => {
  const longName = 'Extremely Long Example Optical Distribution And Wholesale Holdings International Limited';
  const { bytes } = await build({ customer: { business: longName, address: longName } });
  const text = allText(bytes);
  /* Truncated with an ellipsis rather than running into the next column, OR
     wrapped — either is fine; what must not happen is a throw or a blank. */
  assert.ok(text.includes('Extremely Long Example'), 'the name must still be readable');
  assert.equal(pageCount(bytes) >= 1, true);
});

test('41 — a long product description wraps inside its column', async () => {
  const longName = 'A very long product description that keeps going and going well past the width of the description column on any page';
  const { bytes } = await build({ lines: [line(1, { name: longName })] });
  const text = allText(bytes);
  assert.match(text, /A very long product/);
  /* Wrapped means the words appear across more than one drawn string. */
  const drawn = textOf(bytes).filter((t) => longName.includes(t) && t.length > 5);
  assert.ok(drawn.length >= 2, 'the description must wrap, not overflow');
});

test('42 — regenerating an unchanged invoice is byte-identical', async () => {
  /* No clock is read: the PDF's creation date comes from the invoice's own
     issue date. "Is this the same document I sent?" must be answerable by
     comparing files. */
  const a = await build();
  const b = await build();
  assert.ok(a.bytes.equals(b.bytes), 'the same input must produce the same bytes');
});

test('43 — a changed invoice produces different bytes', async () => {
  const a = await build();
  const b = await build({ invoice: { amount: '1300.00' } });
  assert.ok(!a.bytes.equals(b.bytes));
});

// ===========================================================================
// 44-52 — text safety and layout primitives
// ===========================================================================

test('44 — characters outside the font’s encoding are folded, never thrown on', () => {
  /* A customer's name is free text. A 500 on an invoice download is worse than
     a substituted character. */
  /* 'é' is 0xE9 and IS representable in WinAnsi, so it survives — folding it
     would corrupt a name the font can print perfectly well. Only the
     genuinely unrepresentable is substituted. */
  assert.equal(sanitize('Café — “quoted”'), 'Café - "quoted"');
  assert.equal(sanitize('emoji 🙂 here'), 'emoji ? here');
  assert.equal(sanitize('tab\there'), 'tab here');
});

test('45 — a name with unusual characters still renders', async () => {
  const { bytes } = await build({ customer: { business: 'Œil Optique — Ünïcode 🙂 Ltd' } });
  assert.ok(bytes.length > 1500);
  assert.match(allText(bytes), /Optique/);
});

test('46 — truncation is exact against real font metrics', async () => {
  const doc = await createDocument({ title: 't', creationDate: T0 });
  const font = doc.fonts.regular;
  const long = 'x'.repeat(200);
  const out = truncate(long, font, 9, 60);
  assert.ok(font.widthOfTextAtSize(out, 9) <= 60, 'the truncated string must fit');
  assert.match(out, /\.\.\.$/);
  assert.equal(truncate('short', font, 9, 200), 'short', 'a fitting string is untouched');
});

test('47 — wrapping breaks an over-long single word rather than overflowing', async () => {
  const doc = await createDocument({ title: 't', creationDate: T0 });
  const font = doc.fonts.regular;
  const lines = wrap('x'.repeat(300), font, 9, 80);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(font.widthOfTextAtSize(l, 9) <= 80);
});

test('48 — a table wider than the page is refused, not silently overflowed', async () => {
  const doc = await createDocument({ title: 't', creationDate: T0 });
  const canvas = createCanvas(doc);
  canvas.newPage();
  assert.throws(() => drawTable(canvas, {
    columns: [{ key: 'a', label: 'A', width: 900 }],
    rows: [{ a: 'x' }],
  }), /content width/);
});

test('49 — an empty invoice with no lines still produces a valid document', async () => {
  const { bytes } = await build({ lines: [] });
  assert.equal(bytes.slice(0, 5).toString(), '%PDF-');
  assert.match(allText(bytes), /IN1001/);
});

test('50 — an unreadable or missing logo falls back to the wordmark', async () => {
  const brand = resolveBrand({ VEYORA_LEGAL_NAME: 'X', VEYORA_INVOICE_LOGO: '/no/such/file.png' });
  const data = assembleInvoiceData({
    brand, invoice: invoiceRow(), order: orderRow(), orderLines: orderRow().items,
    customer: customerRow(), asOf: T0,
  });
  const bytes = await renderInvoicePdf(data);
  assert.match(allText(bytes), /VEYORA/, 'the wordmark stands in');
});

// ===========================================================================
// 51-60 — access control and leakage
// ===========================================================================

function makeDb({ invoices = [invoiceRow()], customers = [customerRow()],
  orders = [orderRow()], contacts = [], sessions = [] } = {}) {
  return {
    async query(sql, params = []) {
      if (/from invoices/is.test(sql)) {
        const owned = /and customer_id = \$2/.test(sql);
        const i = invoices.find((x) => (x.id === params[0] || x.number === params[0])
          && (!owned || x.customer_id === params[1]));
        return { rows: i ? [{ ...i }] : [] };
      }
      if (/from users where id/is.test(sql)) {
        const c = customers.find((x) => x.id === params[0]);
        return { rows: c ? [{ ...c }] : [] };
      }
      if (/from orders where id/is.test(sql)) {
        const o = orders.find((x) => x.id === params[0]);
        return { rows: o ? [{ ...o }] : [] };
      }
      if (/from customer_contacts/is.test(sql)) return { rows: contacts.map((c) => ({ ...c })) };
      if (/from payment_sessions/is.test(sql)) return { rows: sessions.map((s) => ({ ...s })) };
      return { rows: [] };
    },
  };
}

test('51 — a customer can download their OWN invoice', async () => {
  const db = makeDb();
  const result = await buildInvoicePdf(db, 'in_1', { customerId: 'u_cust1', brand: BRAND, asOf: T0 });
  assert.equal(result.bytes.slice(0, 5).toString(), '%PDF-');
  assert.equal(result.filename, 'Veyora-Invoice-IN1001.pdf');
});

test('52 — another customer’s invoice is a 404, not a 403', async () => {
  /* Distinguishing them would confirm the invoice exists to anyone
     enumerating ids. */
  const db = makeDb();
  await assert.rejects(
    () => buildInvoicePdf(db, 'in_1', { customerId: 'u_other', brand: BRAND, asOf: T0 }),
    (err) => err instanceof DocumentError && err.status === 404);
});

test('53 — ownership is a SQL predicate, not a comparison afterwards', () => {
  /* There must be no branch in which a row is loaded and then rejected — that
     shape is where a "forgot the check" bug lives. */
  assert.match(routeSrc, /and customer_id = \$2/);
  assert.ok(!/invoice\.customer_id !== customerId/.test(routeSrc));
});

test('54 — the staff route is capability-gated with no role fallback', () => {
  assert.match(routeSrc, /requirePermission\('payments\.view'\)/);
  assert.ok(!/req\.user\.role\s*===/.test(routeSrc), 'no role check may appear');
});

test('55 — an unknown invoice is a 404', async () => {
  await assert.rejects(() => buildInvoicePdf(makeDb(), 'in_nope', { brand: BRAND, asOf: T0 }),
    (err) => err.status === 404);
});

test('56 — the response headers are safe for a financial document', () => {
  assert.match(routeSrc, /Content-Type', 'application\/pdf'/);
  assert.match(routeSrc, /Cache-Control', 'private, no-store/);
  assert.match(routeSrc, /X-Content-Type-Options', 'nosniff'/);
  assert.match(routeSrc, /Content-Disposition/);
});

test('57 — no internal price, cost or secret leaks into the document', async () => {
  const db = makeDb({
    orders: [orderRow({ items: [
      { ...line(1), cost: '9.99', supplierCost: '8.50', margin: '0.62', wholesale: '12.00' },
    ] })],
  });
  const { bytes } = await buildInvoicePdf(db, 'in_1', { brand: BRAND, asOf: T0 });
  const text = allText(bytes);
  for (const leak of ['9.99', '8.50', '0.62', '12.00', 'cost', 'supplier', 'margin', 'wholesale']) {
    assert.ok(!text.toLowerCase().includes(String(leak).toLowerCase()), `the document leaked ${leak}`);
  }
});

test('58 — the assembler reads an ALLOWLIST of line fields, never the whole row', () => {
  /* This is what makes the leak test above hold for a field nobody has added
     yet: the line shape is built key by key from a fresh object literal. */
  assert.ok(!/\.\.\.line/.test(pdfSrc), 'a line row must never be spread');
  assert.match(pdfSrc, /sku: String\(line\.sku/);
});

test('59 — no Stripe key, session secret or webhook secret can reach a document', async () => {
  const db = makeDb({ sessions: [{ status: 'open', hosted_url: 'https://checkout.stripe.test/cs_1' }] });
  const { bytes } = await buildInvoicePdf(db, 'in_1', { brand: BRAND, asOf: T0 });
  const raw = bytes.toString('latin1');
  for (const shape of ['sk_test', 'sk_live', 'whsec_', 'pk_live', 'idempotency']) {
    assert.ok(!raw.includes(shape), `the document contains ${shape}`);
  }
});

test('60 — the customer’s balance and other customers never appear', async () => {
  const db = makeDb({ customers: [customerRow({ balance: '99999.00' })] });
  const { bytes } = await buildInvoicePdf(db, 'in_1', { brand: BRAND, asOf: T0 });
  const text = allText(bytes);
  assert.ok(!text.includes('99999'), 'an account balance is not invoice content');
});

test('61 — a document is never generated from a request body', () => {
  assert.ok(!/req\.body/.test(routeSrc), 'the routes read no body at all');
  assert.ok(!/req\.query/.test(routeSrc), 'and no query string');
});
