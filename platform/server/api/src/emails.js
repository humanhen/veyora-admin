/* Branded HTML email templates (table-based, inline styles for client compat).
   Mirrors the old veyora.com transactional look: dark header, light body,
   gift/details cards, rounded CTA, dark footer.

   Deliberately dependency-free: this module renders strings and must not reach
   for the database or any driver, so callers pass the currency + rate in.
   currency.js stays the source of truth for the supported currency list. */

const INK = '#221F20';
const MAROON = '#5c4a4a';
const BG = '#f4f2ef';
const CARD = '#ffffff';
const MUTED = '#8a857f';
const PUBLIC = () => process.env.PUBLIC_URL || 'https://veyora.design';

function shell(title, inner, toEmail) {
  const year = new Date().getFullYear();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:'Montserrat',Segoe UI,Arial,sans-serif;color:#2b2b2b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 12px">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${CARD};border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <tr><td style="background:${INK};padding:34px 24px;text-align:center">
      <div style="color:#bda0d3;font-size:11px;letter-spacing:4px;text-transform:uppercase;margin-bottom:8px">Veyora</div>
      <div style="color:#fff;font-size:24px;font-weight:300;letter-spacing:1px">${esc(title)}</div>
    </td></tr>
    <tr><td style="padding:32px 34px">${inner}</td></tr>
    <tr><td style="background:${INK};padding:22px 24px;text-align:center;color:#9a938c;font-size:12px;line-height:1.7">
      &copy; ${year} Veyora. All rights reserved.<br>
      ${toEmail ? `This message was sent to <a href="mailto:${esc(toEmail)}" style="color:#bda0d3;text-decoration:none">${esc(toEmail)}</a>` : ''}
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function button(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto"><tr>
    <td style="background:${MAROON};border-radius:26px">
      <a href="${esc(href)}" style="display:inline-block;padding:15px 34px;color:#fff;font-size:13px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none">${esc(label)}</a>
    </td></tr></table>`;
}

function detailsCard(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ece9e5;border-radius:10px;margin:22px 0">
    <tr><td style="padding:18px 20px">
      <div style="color:${MUTED};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px">Your account details</div>
      ${rows.map(([k, v]) => `<div style="margin:6px 0;font-size:14px"><span style="color:${MUTED};display:inline-block;width:90px;font-size:12px;text-transform:uppercase;letter-spacing:.5px">${esc(k)}</span> <b>${esc(v)}</b></div>`).join('')}
    </td></tr></table>`;
}

function giftCard() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ece9e5;border-radius:10px;margin:22px 0;background:#faf8f5">
    <tr><td style="padding:22px;text-align:center">
      <div style="font-size:15px;font-weight:700">🎁 Welcome Gift</div>
      <div style="font-size:14px;margin:6px 0 14px">Enjoy 10% off your first purchase</div>
      <div style="color:${MUTED};font-size:11px;letter-spacing:1.5px;text-transform:uppercase">Your coupon code</div>
      <div style="font-family:'Courier New',monospace;font-size:22px;font-weight:700;letter-spacing:2px;margin-top:4px">FIRST10</div>
    </td></tr></table>`;
}

function p(text) {
  return `<p style="font-size:14.5px;line-height:1.7;color:#3a3a3a;margin:0 0 16px">${text}</p>`;
}

/* ---------- templates ---------- */

export function welcomeActivation({ name, username, email, link }) {
  const inner =
    p(`Dear ${esc(name || username || 'there')},`) +
    p(`Your account has been created. You are now part of our exclusive community dedicated to exceptional eyewear craftsmanship and timeless design.`) +
    giftCard() +
    detailsCard([['Username', username || '—'], ['Email', email]]) +
    p(`To access your account and explore our collections, please set your password:`) +
    button('Set Password & Login', link) +
    `<p style="font-size:12px;color:${MUTED};line-height:1.6;margin-top:22px;text-align:center">
       If the button doesn't work, copy and paste this link into your browser:<br>
       <a href="${esc(link)}" style="color:${MAROON};word-break:break-all">${esc(link)}</a></p>` +
    p(`<span style="color:${MUTED}">Welcome to Veyora.</span>`);
  return { subject: 'Welcome to Veyora — Complete Your Account Setup',
           html: shell('Welcome to Veyora', inner, email) };
}

export function passwordReset({ name, email, link, code }) {
  const inner =
    p(`Dear ${esc(name || 'there')},`) +
    p(`We received a request to reset your Veyora password. ${link ? 'Click the button below to choose a new one:' : 'Use the code below to continue:'}`) +
    (link ? button('Reset Password', link)
          : `<div style="text-align:center;font-family:'Courier New',monospace;font-size:30px;font-weight:700;letter-spacing:6px;margin:8px 0 20px">${esc(code)}</div>`) +
    p(`<span style="color:${MUTED}">If you didn't request this, you can safely ignore this email — your password won't change.</span>`);
  return { subject: 'Reset your Veyora password', html: shell('Password Reset', inner, email) };
}

export function activationCode({ name, email, code }) {
  const inner =
    p(`Dear ${esc(name || 'there')},`) +
    p(`Use the code below to activate your Veyora account and set your password. It expires in 15 minutes.`) +
    `<div style="text-align:center;font-family:'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:6px;margin:12px 0 22px">${esc(code)}</div>` +
    giftCard() +
    p(`<span style="color:${MUTED}">Welcome to Veyora.</span>`);
  return { subject: 'Your Veyora activation code', html: shell('Activate Your Account', inner, email) };
}

/* ---------- order / backorder line rendering ----------
   Every customer- and staff-facing line carries the full product identity the
   business asked for: brand, model number (the PRODUCT sku — never the variation
   sku), colour, variation SKU and quantity. */

// Mirrors currency.js SYMBOLS; kept local so templates stay driver-free.
const CURRENCY_SYMBOLS = { USD: '$', CAD: 'CA$', EUR: '€' };

/* Amounts are stored in the base currency (USD); an order carries the currency
   it was struck in plus the rate used, so emails show what the customer
   actually owes instead of a hardcoded dollar figure. */
function fmtMoney(baseAmount, currency, rate) {
  const v = (Number(baseAmount) || 0) * (Number(rate) || 1);
  return `${CURRENCY_SYMBOLS[String(currency || 'USD').toUpperCase()] || '$'}${v.toFixed(2)}`;
}

function identityLine(i) {
  const bits = [];
  if (i.brand) bits.push(esc(i.brand));
  if (i.modelSku) bits.push(`Model ${esc(i.modelSku)}`);
  bits.push(`SKU ${esc(i.sku)}`);
  return bits.join(' · ');
}

/** One <tr> per item. `qtyOf` picks which quantity column to show. */
function itemRows(items, { hidePrices, currency, rate, qtyOf = i => i.qty }) {
  return (items || []).map(i => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px">${esc(i.name || i.sku)}${i.color ? ` <span style="color:${MUTED}">· ${esc(i.color)}</span>` : ''}<br><span style="color:${MUTED};font-size:12px">${identityLine(i)}</span></td>
      <td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px;text-align:center">×${qtyOf(i)}</td>
      ${hidePrices ? '' : `<td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px;text-align:right">${fmtMoney(qtyOf(i) * i.price, currency, rate)}</td>`}
    </tr>`).join('');
}

function sectionLabel(text) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0">
    <tr><td style="color:${MUTED};font-size:11px;text-transform:uppercase;letter-spacing:1px;padding-bottom:6px">${esc(text)}</td></tr></table>`;
}

/* ---------- plaintext ----------
   Built here, beside the HTML, from the same inputs. A plaintext fallback that
   drifts from the HTML is how hidden prices leak, so the two are never written
   in different places. Note the deliberate absence of esc(): this is plain
   text, not markup. */

function textIdentity(i) {
  const bits = [];
  if (i.brand) bits.push(i.brand);
  if (i.modelSku) bits.push(`Model ${i.modelSku}`);
  bits.push(`SKU ${i.sku}`);
  return bits.join(' · ');
}

/** Item lines as plaintext. Prices appear only when hidePrices is false. */
function textItems(items, { hidePrices, currency, rate, qtyOf = i => i.qty }) {
  return (items || []).map(i => {
    const head = `  - ${i.name || i.sku}${i.color ? ` · ${i.color}` : ''}`;
    const meta = `      ${textIdentity(i)} — ${qtyOf(i)} pcs`;
    return hidePrices
      ? `${head}\n${meta}`
      : `${head}\n${meta} — ${fmtMoney(qtyOf(i) * i.price, currency, rate)}`;
  }).join('\n');
}

/** "Label: $123.45 USD", or nothing at all when prices are hidden. */
function textMoneyLine(label, base, { hidePrices, currency, rate }) {
  // null, not '': joinLines keeps empty strings as deliberate blank lines.
  return hidePrices ? null : `${label}: ${fmtMoney(base, currency, rate)} ${currency}`;
}

/* Join plaintext parts, dropping only omitted sections (null/undefined/false)
   and keeping '' as an intentional blank line, so the body stays readable. */
const joinLines = (...parts) =>
  parts.flat().filter(x => x != null && x !== false).join('\n');

/** Value summary shared by HTML and text: allocated / backordered / requested. */
function valueRows(totals, { hidePrices, currency, rate }) {
  if (hidePrices || !totals) return [];
  const out = [];
  if (totals.allocatedValue != null) {
    out.push(['Allocated value', totals.allocatedValue]);
  }
  if (totals.backorderedValue) out.push(['Backordered value', totals.backorderedValue]);
  if (totals.requestedValue != null && totals.backorderedValue) {
    out.push(['Full requested value', totals.requestedValue]);
  }
  return out.map(([k, v]) => [k, fmtMoney(v, currency, rate)]);
}

function valueTableHtml(totals, opts) {
  const rows = valueRows(totals, opts);
  if (!rows.length) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0">
    ${rows.map(([k, v]) => `<tr>
      <td style="padding:3px 0;font-size:13px;color:${MUTED}">${esc(k)}</td>
      <td style="padding:3px 0;font-size:13px;text-align:right">${esc(v)}</td></tr>`).join('')}
  </table>`;
}

/* Order confirmation, in HTML and plaintext.

   `backorder` is optional: when the order was only partly fulfillable it
   carries the shortfall. Wording rule — an allocated quantity has been taken
   from stock, it has NOT shipped, and a backordered quantity is recorded for
   staff to process, not automatically dispatched. Neither is described as
   shipping until the order actually reaches a shipment state. */
export function orderConfirmation({ name, email, order, hidePrices, backorder,
                                    currency = 'USD', rate = 1, totals, intro }) {
  const opts = { hidePrices, currency, rate };
  const boItems = backorder?.items || [];
  const partial = boItems.length > 0;
  const allocatedLabel = partial ? 'Allocated from current stock' : 'Order summary';
  /* `intro` lets a backorder CONVERSION reuse this template while saying what
     actually happened — stock became available and was allocated to an order.
     It must not claim a shipment: conversion reserves stock and creates a
     pending order, nothing has left the warehouse. */
  const opening = intro
    || `Thank you for your order <b>${esc(order.number)}</b>. We've received it and will let you know when it ships.`;

  const inner =
    p(`Dear ${esc(name || 'there')},`) +
    p(opening) +
    sectionLabel(allocatedLabel) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${
      itemRows(order.items, opts)}
       ${hidePrices ? '' : `<tr><td style="padding:12px 0 0;font-weight:700">Order total</td><td></td><td style="padding:12px 0 0;text-align:right;font-weight:700">${fmtMoney(order.total, currency, rate)}</td></tr>`}
     </table>` +
    (partial ? (
      sectionLabel(`Recorded for staff processing — ${esc(backorder.number)}`) +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${
        itemRows(boItems, opts)}</table>` +
      p(`<span style="color:${MUTED}">These pieces were not in stock, so they are <b>not</b> part of the allocated quantities above. They are recorded on backorder <b>${esc(backorder.number)}</b> and our team will process them when stock becomes available.</span>`)
    ) : '') +
    valueTableHtml(totals, opts) +
    `<div style="text-align:center;margin-top:22px">${button('View Order', `${PUBLIC()}/#/order/${order.id}`)}</div>`;

  const text = joinLines(
    `Dear ${name || 'there'},`,
    '',
    // strip the markup the HTML opening carries, so the two stay in step
    opening.replace(/<[^>]+>/g, ''),
    '',
    `${allocatedLabel.toUpperCase()}:`,
    textItems(order.items, opts),
    textMoneyLine('Order total', order.total, opts),
    partial ? [
      '',
      `RECORDED FOR STAFF PROCESSING — ${backorder.number}:`,
      textItems(boItems, opts),
      '',
      `These pieces were not in stock, so they are NOT part of the allocated`,
      `quantities above. They are recorded on backorder ${backorder.number} and our`,
      `team will process them when stock becomes available.`,
    ] : [],
    valueRows(totals, opts).map(([k, v]) => `${k}: ${v} ${currency}`),
    '',
    `View your order: ${PUBLIC()}/#/order/${order.id}`);

  return { subject: `Veyora order ${order.number} received`,
           html: shell('Order Confirmed', inner, email), text };
}

/* Nothing in the basket was available: there is no order object at all, only a
   backorder. The customer still gets a confirmation — silence here reads as a
   failed checkout — and the copy promises recording, never dispatch. */
export function backorderConfirmation({ name, email, backorder, hidePrices,
                                        currency = 'USD', rate = 1, totals }) {
  const opts = { hidePrices, currency, rate };
  const inner =
    p(`Dear ${esc(name || 'there')},`) +
    p(`Thank you — we've received your request and recorded it as backorder <b>${esc(backorder.number)}</b>.`) +
    p(`None of these pieces are in stock at the moment, so <b>nothing is shipping yet</b>. The full quantity is recorded for our team to process when stock becomes available, and we'll be in touch.`) +
    sectionLabel('Recorded for staff processing') +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${
      itemRows(backorder.items, opts)}</table>` +
    valueTableHtml(totals, opts) +
    `<div style="text-align:center;margin-top:22px">${button('View Backorders', `${PUBLIC()}/#/backorders`)}</div>`;

  const text = joinLines(
    `Dear ${name || 'there'},`,
    '',
    `Thank you — we've received your request and recorded it as backorder ${backorder.number}.`,
    '',
    `None of these pieces are in stock at the moment, so NOTHING IS SHIPPING YET.`,
    `The full quantity is recorded for our team to process when stock becomes`,
    `available, and we'll be in touch.`,
    '',
    'RECORDED FOR STAFF PROCESSING:',
    textItems(backorder.items, opts),
    valueRows(totals, opts).map(([k, v]) => `${k}: ${v} ${currency}`),
    '',
    `View your backorders: ${PUBLIC()}/#/backorders`);

  return { subject: `Veyora backorder ${backorder.number} received`,
           html: shell('Backorder Received', inner, email), text };
}

/* Internal operations alert. Deliberately minimal: who ordered, what to pick,
   what is short. No credentials, no balances, no addresses. */
export function staffOrderAlert({ order, backorder, customer, agent, lines,
                                  currency = 'USD', rate = 1, totals, note }) {
  const ref = order?.number || backorder?.number || '—';
  const kind = order && backorder ? 'Order + backorder'
    : order ? 'New order' : 'New backorder';
  // Staff alerts always carry money: hide-prices is a customer-facing
  // preference, not an internal one, and the warehouse needs the values.
  const staffOpts = { hidePrices: false, currency, rate };
  const rows = (lines || []).map(l => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px">${esc(l.name || l.sku)}${l.color ? ` <span style="color:${MUTED}">· ${esc(l.color)}</span>` : ''}<br><span style="color:${MUTED};font-size:12px">${identityLine(l)}</span></td>
      <td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px;text-align:center">${l.requested}</td>
      <td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px;text-align:center"><b>${l.allocated}</b></td>
      <td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px;text-align:center;color:${l.backordered ? '#b45309' : MUTED}">${l.backordered}</td>
    </tr>`).join('');
  const meta = [
    ['Customer', customer?.business || customer?.email || '—'],
    ['Account', customer?.customerNumber ? `#${customer.customerNumber}` : '—'],
  ];
  if (order) meta.push(['Order', order.number]);
  if (backorder) meta.push(['Backorder', backorder.number]);
  if (agent) meta.push(['Placed by', agent.name || agent.email || '—']);
  if (order) meta.push(['Order total', fmtMoney(order.total, currency, rate) + ` ${currency}`]);
  for (const [k, v] of valueRows(totals, staffOpts)) meta.push([k, `${v} ${currency}`]);
  if (note) meta.push(['Customer note', note]);

  const inner =
    p(`<b>${esc(kind)} ${esc(ref)}</b>`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ece9e5;border-radius:10px;margin:18px 0">
      <tr><td style="padding:16px 18px">
        ${meta.map(([k, v]) => `<div style="margin:5px 0;font-size:14px"><span style="color:${MUTED};display:inline-block;width:110px;font-size:12px;text-transform:uppercase;letter-spacing:.5px">${esc(k)}</span> <b>${esc(v)}</b></div>`).join('')}
      </td></tr></table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:1px;padding-bottom:4px">Item</td>
        <td style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:1px;text-align:center;padding-bottom:4px">Req</td>
        <td style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:1px;text-align:center;padding-bottom:4px">Pick</td>
        <td style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:1px;text-align:center;padding-bottom:4px">B/O</td>
      </tr>${rows}</table>` +
    (order ? `<div style="text-align:center;margin-top:22px">${button('Open in Admin', `${PUBLIC()}/admin/#/orders`)}</div>` : '');

  const text = joinLines(
    `${kind} ${ref}`,
    '',
    meta.map(([k, v]) => `${k}: ${v}`),
    '',
    'Item — requested / allocated / backordered:',
    (lines || []).map(l => joinLines(
      `  - ${l.name || l.sku}${l.color ? ` · ${l.color}` : ''}`,
      `      ${textIdentity(l)}`,
      `      requested ${l.requested} · allocate ${l.allocated} · backorder ${l.backordered}`
        + ` — ${fmtMoney(l.requested * l.price, currency, rate)}`)),
    order ? ['', `Open in admin: ${PUBLIC()}/admin/#/orders`] : []);

  return { subject: `[Veyora] ${kind} ${ref} — ${customer?.business || customer?.email || 'customer'}`,
           html: shell(kind, inner, null), text };
}
