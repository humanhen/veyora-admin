/* The rendered Payments / Credit Notes screen (Final Handover Phase 4).

   Renders the REAL page handler registered by js/pages_finance.js and drives
   its finance controls the way an operator would. Assertions are on what was
   rendered and what was SENT.

   The property under test throughout: the browser no longer writes money. It
   posts to a governed endpoint and re-reads the result. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAdmin, ROOT } = require('./helpers/dom.js');

const FILES = ['js/util.js', 'js/data.js', 'js/app.js', 'js/pages_finance.js'];

const ALL_CAPS = { invoice: true, record: true, credit: true, reconcile: true };
const CONTRACT = {
  offlineMethods: ['transfer', 'check', 'credit_card', 'cash'],
  currencies: ['USD', 'CAD', 'EUR'],
};

const settle = () => new Promise(r => setTimeout(r, 0))
  .then(() => new Promise(r => setTimeout(r, 0)))
  .then(() => new Promise(r => setTimeout(r, 0)));

const words = (node) => String(node.textContent || '').replace(/\s+/g, ' ').trim();
const modalOf = (sandbox) => sandbox.document.getElementById('modal-root').children.slice(-1)[0];

async function renderPage(routes = {}, { caps = ALL_CAPS, payments = [], creditNotes = [] } = {}) {
  const sandbox = loadAdmin(FILES);
  const calls = [];
  const table = Object.assign({
    'GET /admin/finance/capabilities': async () => ({
      status: 200, body: { capabilities: caps, contract: CONTRACT },
    }),
  }, routes);

  sandbox.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const p = String(url).replace(/^\/api/, '');
    calls.push({ method, path: p, body: opts.body ? JSON.parse(opts.body) : null });
    const responder = table[`${method} ${p}`] || table[`${method} *`];
    const r = responder ? await responder() : { status: 404, body: { error: 'not found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };

  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u_ops', name: 'Ops', role: 'admin' }));
  await sandbox.App.loadCaps();
  Object.defineProperty(sandbox.DB, 'ready', { get: () => true, configurable: true });

  sandbox.DB.d.users.push({ id: 'u_cust1', role: 'customer', business: 'Example Optics',
    email: 'a@example.test', balance: 1000 });
  for (const p of payments) sandbox.DB.d.payments.push(p);
  for (const n of creditNotes) sandbox.DB.d.creditNotes.push(n);

  const el = sandbox.document.getElementById('content');
  sandbox.App.routes.payments(el);
  await settle();
  return { sandbox, el, calls };
}

const payment = (over = {}) => ({ id: 'pay_1', customerId: 'u_cust1', amount: 250,
  currency: 'USD', method: 'transfer', reference: 'BACS-99213',
  date: '2026-08-01', paidOn: '2026-08-01', voidedAt: null, ...over });

/* Fills a modal's inputs from a map of selector → value. */
function fill(modal, values) {
  for (const [selector, value] of Object.entries(values)) {
    const node = modal.querySelector(selector);
    assert.ok(node, `missing field ${selector}`);
    node.value = value;
  }
}

// ---------------------------------------------------------------------------
// the browser no longer writes money
// ---------------------------------------------------------------------------

test('the payments screen contains no direct write to a payment, credit note or balance', () => {
  /* Scoped to the payments/credit-notes screen. The COLLECTION screen further
     down the same file still syncs `collectionFlags` through the generic path,
     and correctly: a receivables chase note is workflow, not money, and it is
     deliberately absent from FINANCE_COLLECTIONS. */
  const whole = fs.readFileSync(path.join(ROOT, 'js', 'pages_finance.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const screen = whole.slice(whole.indexOf("App.register('payments'"),
    whole.indexOf("App.register('collection'"));
  assert.ok(screen.length > 500, 'the payments screen must be findable');
  for (const forbidden of [
    'DB.d.payments.unshift', 'DB.d.creditNotes.unshift',
    'u.balance=', 'u.balance =', 'DB.save()',
  ]) {
    assert.ok(!screen.includes(forbidden), `the payments screen still does: ${forbidden}`);
  }
});

test('recording a payment posts to the governed endpoint and sends no balance', async () => {
  const { el, sandbox, calls } = await renderPage({
    'POST /admin/finance/payments': async () => ({
      status: 200, body: { payment: { id: 'pay_9', customerId: 'u_cust1', amount: '250.00',
        currency: 'USD', method: 'transfer', reference: 'BACS-99213' } } }),
  });
  el.querySelector('#pay-new').onclick();
  const modal = modalOf(sandbox);
  fill(modal, { '#rp-amount': '250.00', '#rp-ref': 'BACS-99213' });
  modal.querySelector('[data-ok]').onclick();
  await settle();

  const post = calls.find(c => c.method === 'POST');
  assert.ok(post, 'a payment must be posted');
  assert.equal(post.path, '/admin/finance/payments');
  assert.equal(post.body.amount, '250.00');
  assert.equal(post.body.reference, 'BACS-99213');
  /* The server derives the balance movement, the actor and the idempotency
     key. A body that carried any of them would be a way to assert them. */
  for (const forbidden of ['balance', 'actor', 'actorId', 'recordedBy', 'idempotencyKey', 'id']) {
    assert.equal(forbidden in post.body, false, `the body must not carry ${forbidden}`);
  }
});

test('the payment method list comes from the server, with the spelling the database accepts', async () => {
  /* The old hard-coded form offered "credit card" with a space — a value the
     `payments.method` CHECK constraint would have refused outright. */
  const { el, sandbox } = await renderPage();
  el.querySelector('#pay-new').onclick();
  const options = modalOf(sandbox).querySelectorAll('#rp-method option')
    .map(o => o.getAttribute('value'));
  assert.deepEqual(options, ['transfer', 'check', 'credit_card', 'cash']);
  assert.ok(!options.includes('credit card'), 'a space-separated method must never be offered');
  assert.ok(!options.includes('stripe'), 'a Stripe payment cannot be keyed in by hand');
});

test('the payment form says plainly that Stripe payments are not entered here', async () => {
  const { el, sandbox } = await renderPage();
  el.querySelector('#pay-new').onclick();
  assert.match(words(modalOf(sandbox)),
    /Stripe payment is recorded by the payment provider itself and cannot be entered here/i);
});

test('a reference is presented as required, with the reason', async () => {
  const { el, sandbox } = await renderPage();
  el.querySelector('#pay-new').onclick();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /Reference \(required\)/);
  assert.match(words(modal), /matched against a bank statement/i);
});

test('a rejected payment keeps the form open with the operator’s typing intact', async () => {
  const { el, sandbox } = await renderPage({
    'POST /admin/finance/payments': async () => ({
      status: 400, body: { error: 'That could not be saved.', code: 'INVALID_INPUT',
        errors: [{ field: 'reference', code: 'REQUIRED', message: 'A bank reference is required.' }] } }),
  });
  el.querySelector('#pay-new').onclick();
  const modal = modalOf(sandbox);
  fill(modal, { '#rp-amount': '250.00', '#rp-ref': 'x' });
  modal.querySelector('[data-ok]').onclick();
  await settle();

  const still = modalOf(sandbox);
  assert.equal(still.querySelector('#rp-amount').value, '250.00', 'typing must survive');
  assert.match(words(still), /A bank reference is required/);
});

test('a duplicate is explained as a duplicate, with what to do about it', async () => {
  const { el, sandbox } = await renderPage({
    'POST /admin/finance/payments': async () => ({
      status: 409, body: { error: 'already', code: 'ALREADY_RECORDED' } }),
  });
  el.querySelector('#pay-new').onclick();
  const modal = modalOf(sandbox);
  fill(modal, { '#rp-amount': '250.00', '#rp-ref': 'BACS-99213' });
  modal.querySelector('[data-ok]').onclick();
  await settle();
  assert.match(words(modalOf(sandbox)), /Change the reference if this is a genuinely separate one/i);
});

test('a double click cannot record the payment twice', async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const { el, sandbox, calls } = await renderPage({
    'POST /admin/finance/payments': async () => {
      await held;
      return { status: 200, body: { payment: { id: 'pay_9', amount: '250.00', currency: 'USD', method: 'transfer' } } };
    },
  });
  el.querySelector('#pay-new').onclick();
  const modal = modalOf(sandbox);
  fill(modal, { '#rp-amount': '250.00', '#rp-ref': 'BACS-99213' });
  const ok = modal.querySelector('[data-ok]');
  ok.onclick(); ok.onclick(); ok.onclick();
  release();
  await settle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

// ---------------------------------------------------------------------------
// credit notes
// ---------------------------------------------------------------------------

test('a credit note is presented as different from a payment, and needs a reason', async () => {
  const { el, sandbox } = await renderPage();
  el.querySelectorAll('[data-tab]').find(b => b.dataset.tab === 'Credit Notes').onclick();
  await settle();
  el.querySelector('#cn-new').onclick();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /without money arriving/i);
  assert.match(words(modal), /It is not a payment/i);
  assert.match(words(modal), /Reason \(required\)/);
});

test('issuing a credit note posts to its own endpoint', async () => {
  const { el, sandbox, calls } = await renderPage({
    'POST /admin/finance/credit-notes': async () => ({
      status: 200, body: { creditNote: { id: 'cn_1', customerId: 'u_cust1',
        amount: '50.00', currency: 'USD', reason: 'goods damaged in transit' } } }),
  });
  el.querySelectorAll('[data-tab]').find(b => b.dataset.tab === 'Credit Notes').onclick();
  await settle();
  el.querySelector('#cn-new').onclick();
  const modal = modalOf(sandbox);
  fill(modal, { '#cn-amount': '50.00', '#cn-reason': 'goods damaged in transit' });
  modal.querySelector('[data-ok]').onclick();
  await settle();

  const post = calls.find(c => c.method === 'POST');
  assert.equal(post.path, '/admin/finance/credit-notes');
  assert.equal(post.body.reason, 'goods damaged in transit');
  assert.equal('balance' in post.body, false);
});

// ---------------------------------------------------------------------------
// capability gating — the two authorities stay apart
// ---------------------------------------------------------------------------

test('finance.record does not confer finance.credit', async () => {
  const { el } = await renderPage({}, {
    caps: { invoice: false, record: true, credit: false, reconcile: false },
  });
  assert.ok(el.querySelector('#pay-new'), 'a recorder may record');
  el.querySelectorAll('[data-tab]').find(b => b.dataset.tab === 'Credit Notes').onclick();
  await settle();
  assert.equal(el.querySelector('#cn-new'), null, 'but may not forgive a debt');
  assert.match(words(el), /deliberately separate from recording a payment/i);
});

test('finance.credit does not confer finance.record', async () => {
  const { el } = await renderPage({}, {
    caps: { invoice: false, record: false, credit: true, reconcile: false },
  });
  assert.equal(el.querySelector('#pay-new'), null);
  assert.match(words(el), /Record offline payments/);
});

test('an account holding neither is offered no financial control at all', async () => {
  const { el } = await renderPage({}, {
    caps: { invoice: false, record: false, credit: false, reconcile: false },
    payments: [payment()],
  });
  assert.equal(el.querySelector('#pay-new'), null);
  assert.equal(el.querySelector('[data-void]'), null);
  /* But the records are still readable — blocking writes must not blind the
     finance screens. */
  assert.match(words(el), /BACS-99213/);
});

// ---------------------------------------------------------------------------
// voiding
// ---------------------------------------------------------------------------

test('an ordinary payment offers a void; a Stripe payment does not', async () => {
  const { el } = await renderPage({}, { payments: [
    payment(),
    payment({ id: 'pay_2', method: 'stripe', reference: 'pi_1' }),
  ] });
  assert.ok(el.querySelector('[data-void="pay_1"]'), 'an offline payment may be voided');
  assert.equal(el.querySelector('[data-void="pay_2"]'), null,
    'a Stripe payment may not — the money really was taken');
});

test('an already-voided payment is shown, marked, and offers no second void', async () => {
  const { el } = await renderPage({}, { payments: [
    payment({ voidedAt: '2026-08-02T00:00:00.000Z' }),
  ] });
  assert.match(words(el), /Voided/);
  assert.match(words(el), /BACS-99213/, 'the record is kept, not hidden');
  assert.equal(el.querySelector('[data-void]'), null);
});

test('voiding requires a reason and says the record is kept', async () => {
  const { el, sandbox, calls } = await renderPage({
    'POST /admin/finance/payments/pay_1/void': async () => ({
      status: 200, body: { payment: { id: 'pay_1', amount: '250.00', currency: 'USD',
        method: 'transfer', voidedAt: '2026-08-02T00:00:00.000Z', voidReason: 'keyed twice' } } }),
  }, { payments: [payment()] });

  el.querySelector('[data-void="pay_1"]').onclick();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /puts the debt back/i);
  assert.match(words(modal), /nothing is deleted/i);
  assert.match(words(modal), /Reason \(required\)/);

  fill(modal, { '#vd-reason': 'keyed twice — same BACS reference as the entry above' });
  modal.querySelector('[data-ok]').onclick();
  await settle();

  const post = calls.find(c => c.method === 'POST');
  assert.equal(post.path, '/admin/finance/payments/pay_1/void');
  assert.equal(post.body.confirm, true);
  assert.match(post.body.reason, /keyed twice/);
});

// ---------------------------------------------------------------------------
// the client cannot reach what it must not
// ---------------------------------------------------------------------------

test('the client exposes no method that sets a balance or records a Stripe payment', () => {
  const dataJs = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  for (const forbidden of ['setBalance', 'adjustBalance', 'markPaymentSuccessful', 'settlePayment']) {
    assert.ok(!dataJs.includes(forbidden), `the client exposes ${forbidden}`);
  }
  /* Every finance path it does reach is one of the governed routes. */
  const paths = [...dataJs.matchAll(/'\/admin\/finance\/[^']*'/g)].map(m => m[0]);
  assert.ok(paths.length > 0);
  for (const p of paths) {
    assert.match(p, /capabilities|payments|credit-notes|reconciliation|ledger/, `unexpected path ${p}`);
  }
});

test('after a successful write the page re-reads from the server', () => {
  /* The browser no longer holds the authoritative balance, so patching local
     state would show a figure nothing verified. */
  const src = fs.readFileSync(path.join(ROOT, 'js', 'pages_finance.js'), 'utf8');
  assert.match(src, /await DB\.refreshLive\(\)/);
});
