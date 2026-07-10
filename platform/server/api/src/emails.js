/* Branded HTML email templates (table-based, inline styles for client compat).
   Mirrors the old veyora.com transactional look: dark header, light body,
   gift/details cards, rounded CTA, dark footer. */

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

export function orderConfirmation({ name, email, order, hidePrices }) {
  const rows = (order.items || []).map(i => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px">${esc(i.name || i.sku)}${i.color ? ` <span style="color:${MUTED}">· ${esc(i.color)}</span>` : ''}<br><span style="color:${MUTED};font-size:12px">${esc(i.sku)}</span></td>
      <td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px;text-align:center">×${i.qty}</td>
      ${hidePrices ? '' : `<td style="padding:8px 0;border-bottom:1px solid #f0ede9;font-size:13px;text-align:right">$${(i.qty * i.price).toFixed(2)}</td>`}
    </tr>`).join('');
  const inner =
    p(`Dear ${esc(name || 'there')},`) +
    p(`Thank you for your order <b>${esc(order.number)}</b>. We've received it and will let you know when it ships.`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0">
       <tr><td style="color:${MUTED};font-size:11px;text-transform:uppercase;letter-spacing:1px;padding-bottom:6px">Order summary</td></tr></table>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
       ${hidePrices ? '' : `<tr><td style="padding:12px 0 0;font-weight:700">Total</td><td></td><td style="padding:12px 0 0;text-align:right;font-weight:700">$${Number(order.total).toFixed(2)}</td></tr>`}
     </table>` +
    `<div style="text-align:center;margin-top:22px">${button('View Order', `${PUBLIC()}/#/order/${order.id}`)}</div>` +
    p(`<span style="color:${MUTED}">Out-of-stock items, if any, are saved as a backorder and fulfilled automatically when stock arrives.</span>`);
  return { subject: `Veyora order ${order.number} received`, html: shell('Order Confirmed', inner, email) };
}
