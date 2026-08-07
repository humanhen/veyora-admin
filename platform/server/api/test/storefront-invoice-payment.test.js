/* The storefront's "Pay securely" control, tested against the REAL shipped
   source. `pages_account.js` is a plain browser script, so it is loaded into a
   vm sandbox with the globals it touches and the actual functions are CALLED —
   nothing here is a re-implementation.

   The property that matters is the one the whole payment design rests on:
   THE STOREFRONT NEVER ASSERTS THAT MONEY MOVED. It can ask for a payment
   link and it can report the state the server gave it. Only a signed webhook
   settles an invoice, and no amount of clicking in this file can change that. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const STOREFRONT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'storefront');
const readSf = p => fs.readFileSync(path.join(STOREFRONT, p), 'utf8');
/* Copy assertions read RENDERED text, not the comments explaining it —
   otherwise a comment saying "never claim a payment" trips the check that
   forbids claiming a payment. */
const code = readSf('js/pages_account.js')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** Load the real pages_account.js with stub globals. */
function load({ post = () => Promise.resolve({}) } = {}) {
  const noop = () => {};
  const toasts = [];
  const ctx = {
    Routes: {},
    Store: { session: { user: {} }, fx: { currency: 'USD', rate: 1, symbol: '$' } },
    API: { get: () => Promise.resolve({}), post, del: () => Promise.resolve({}) },
    esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    money: v => `$${Number(v).toFixed(2)}`,
    fmtDate: v => String(v ?? ''),
    toast: (msg, isErr) => toasts.push({ msg, isErr }),
    route: noop,
    document: { getElementById: () => null },
    location: {},          // `window.location.href = …` is the redirect under test
    window: {},
    console,
    setTimeout,
    toasts,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSf('js/pages_account.js'), ctx, { filename: 'pages_account.js' });
  return ctx;
}

const invoice = (settlementState) => ({
  id: 'inv_1', number: 'VEY-1001', amount: '480.00', issuedOn: '2026-07-01', settlementState,
});

/* ============ which invoices offer to be paid ============ */

test('only an outstanding invoice offers a payment button', () => {
  const sf = load();
  assert.match(sf.payButton(invoice('on_terms')), /data-pay="inv_1"/,
    'an invoice on terms may be paid by card');
  for (const state of ['processing', 'paid', 'refunded', 'void']) {
    assert.equal(sf.payButton(invoice(state)), '',
      `a ${state} invoice must not offer to be paid again`);
  }
});

test('an unknown settlement state does not produce a pay button', () => {
  /* Fail closed. A state this build has never heard of is not an invitation
     to take money for it. */
  const sf = load();
  assert.equal(sf.payButton(invoice('some_future_state')), '');
  assert.equal(sf.payButton({ id: 'inv_1' }), '', 'nor does a missing state');
});

test('every non-payable state explains itself instead of going silent', () => {
  const sf = load();
  const notes = {
    processing: 'payment confirming',
    paid: 'paid',
    refunded: 'refunded',
    void: 'cancelled',
  };
  for (const [state, words] of Object.entries(notes)) {
    assert.match(sf.invoiceStateNote(invoice(state)), new RegExp(words),
      `a ${state} invoice says so`);
  }
  assert.equal(sf.invoiceStateNote(invoice('on_terms')), '',
    'the normal state needs no annotation — it is not an exception');
});

test('"confirming" is never rendered as "paid"', () => {
  /* The distinction the whole webhook design exists to preserve. */
  const sf = load();
  const note = sf.invoiceStateNote(invoice('processing'));
  assert.match(note, /confirming/);
  assert.ok(!/\bpaid\b/.test(note), 'a completed checkout is not a settled invoice');
});

test('the invoice id is escaped into the button', () => {
  const sf = load();
  const html = sf.payButton({ id: 'a"><script>x</script>', settlementState: 'on_terms' });
  assert.ok(!html.includes('<script>'), 'no markup may break out of the attribute');
});

/* ============ starting a payment ============ */

const button = () => ({ dataset: {}, disabled: false, textContent: 'Pay securely' });

test('the customer is sent to the hosted page the server returned', async () => {
  let asked = null;
  const sf = load({
    post: (p) => { asked = p; return Promise.resolve({ payment: { session: { hostedUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' } } }); },
  });
  const b = button();
  await sf.startInvoicePayment(b, 'inv_1');
  assert.equal(asked, '/user/invoices/inv_1/pay', 'it asks for its own invoice');
  assert.equal(sf.location.href, 'https://checkout.stripe.com/c/pay/cs_test_1');
});

test('the invoice id is URL-encoded into the path', async () => {
  let asked = null;
  const sf = load({ post: (p) => { asked = p; return Promise.resolve({}); } });
  await sf.startInvoicePayment(button(), 'inv/../admin');
  assert.equal(asked, '/user/invoices/inv%2F..%2Fadmin/pay',
    'a crafted id cannot climb out of the route');
});

test('a second click is refused while the first is still running', async () => {
  let calls = 0;
  const sf = load({
    post: () => { calls += 1; return new Promise(() => {}); },   // never settles
  });
  const b = button();
  sf.startInvoicePayment(b, 'inv_1');
  await sf.startInvoicePayment(b, 'inv_1');
  assert.equal(calls, 1, 'one click, one payment session');
  assert.equal(b.disabled, true, 'and the control says so');
});

test('a failure restores the button and never claims a charge', async () => {
  const sf = load({
    post: () => Promise.reject(new Error('Online payment is switched off. '
      + 'This invoice is payable on your usual account terms.')),
  });
  const b = button();
  await sf.startInvoicePayment(b, 'inv_1');
  assert.equal(b.disabled, false, 'the customer can try again');
  assert.equal(b.textContent, 'Pay securely', 'the label is restored');
  assert.equal(b.dataset.busy, '0', 'and the guard is released');
  const [t] = sf.toasts;
  assert.equal(t.isErr, true);
  assert.match(t.msg, /payable on your usual account terms/,
    "the server's own sentence is shown — it is the one that tells the "
    + 'customer what to do next');
});

test('a response with no payment URL is treated as a failure, not a success', async () => {
  const sf = load({ post: () => Promise.resolve({ payment: { session: {} } }) });
  const b = button();
  await sf.startInvoicePayment(b, 'inv_1');
  assert.equal(sf.location.href, undefined, 'nobody is redirected anywhere');
  assert.equal(b.disabled, false);
  assert.equal(sf.toasts.length, 1, 'and the customer is told');
});

/* ============ the standing promise about account terms ============ */

test('the page states that card payment changes nothing about account terms', () => {
  assert.match(code, /payable on your usual account\s+terms/,
    'the invoice list carries the standing note');
  assert.match(code, /optional and changes nothing about those terms/);
});

test('nothing in this page can mark an invoice paid', () => {
  /* The storefront may REQUEST a payment. It may not report one. */
  assert.ok(!/settlement_state\s*=/.test(code), 'no settlement write');
  assert.ok(!/settlementState\s*=[^=]/.test(code), 'not even client-side');
  for (const forbidden of [/\/settle/, /markPaid/, /\bPUT\b/]) {
    assert.ok(!forbidden.test(code), `no ${forbidden} path exists here`);
  }
});
