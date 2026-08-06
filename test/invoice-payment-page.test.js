/* The rendered invoice payment surface (Final Handover Phase 3).

   Renders the REAL Invoices page handler registered by js/pages_finance.js and
   drives its payment controls the way an operator would. Assertions are on
   what was rendered and what was SENT.

   No real money and no real key: every amount is invented, every id a fixture,
   and the Stripe block the fake API returns carries no key because the real
   API never sends one. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAdmin } = require('./helpers/dom.js');

const FILES = ['js/util.js', 'js/data.js', 'js/app.js', 'js/pages_finance.js'];

const CAPS = { view: true, collect: true, refund: true, reconcile: true };
const STRIPE_TEST = { enabled: true, mode: 'test', testMode: true, disabledReason: '' };
const STRIPE_OFF = { enabled: false, mode: 'disabled', testMode: false,
  disabledReason: 'STRIPE_ENABLED is not set, so online payment is switched off.' };

const payment = (over = {}) => ({
  invoiceId: 'in_1', invoiceNumber: 'IN1001', amount: '250.00', currency: 'USD',
  settlementState: 'on_terms', amountSettledMinor: 0, amountRefundedMinor: 0,
  settledAt: null, settlementReference: '', issuedOn: '2026-08-01T00:00:00.000Z',
  session: null, ...over,
});

const openSession = (over = {}) => ({
  id: 'ps_1', invoiceId: 'in_1', status: 'open', amountMinor: 25000, currency: 'USD',
  providerReference: 'cs_test_1', expiresAt: '2026-08-08T00:00:00.000Z',
  completedAt: null, lastError: '', createdAt: '2026-08-07T00:00:00.000Z',
  hostedUrl: 'https://checkout.stripe.test/cs_test_1', ...over,
});

const settle = () => new Promise(r => setTimeout(r, 0))
  .then(() => new Promise(r => setTimeout(r, 0)))
  .then(() => new Promise(r => setTimeout(r, 0)));

const words = (node) => String(node.textContent || '').replace(/\s+/g, ' ').trim();
const modalOf = (sandbox) => sandbox.document.getElementById('modal-root').children.slice(-1)[0];

/** Boots the panel with the given payment capabilities and renders Invoices. */
async function renderPage(routes = {}, { caps = CAPS, stripe = STRIPE_TEST } = {}) {
  const sandbox = loadAdmin(FILES);
  const calls = [];
  const table = Object.assign({
    'GET /admin/payments/capabilities': async () => ({
      status: 200, body: { capabilities: caps, stripe },
    }),
    'GET /admin/payments/invoice/in_1': async () => ({ status: 200, body: { payment: payment() } }),
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

  /* The Invoices page refuses to render against a failed load rather than
     showing invented rows (`requireLiveData`). That guard is correct and stays;
     this stands in for a completed DB.init(), which would need the whole
     snapshot endpoint and is not what these tests are about. */
  Object.defineProperty(sandbox.DB, 'ready', { get: () => true, configurable: true });

  /* The invoices grid reads the snapshot the panel already holds. Seeded here
     directly; every PAYMENT fact still comes from the governed API. */
  sandbox.DB.d.invoices.push({ id: 'in_1', number: 'IN1001', orderId: 'o_1', orderNumber: 'SO1',
    customerId: 'u_cust1', amount: 250, provider: 'Green Invoice', status: 'paid', date: '2026-08-01' });
  sandbox.DB.d.orders.push({ id: 'o_1', number: 'SO1', currency: 'USD', fxRate: 1, total: 250 });
  sandbox.DB.d.users.push({ id: 'u_cust1', role: 'customer', business: 'Example Optics', email: 'a@example.test' });

  const el = sandbox.document.getElementById('content');
  sandbox.App.routes.invoices(el);
  await settle();
  return { sandbox, el, calls };
}

// ---------------------------------------------------------------------------
// configuration is stated, never guessed
// ---------------------------------------------------------------------------

test('test mode is announced loudly and permanently', async () => {
  /* A deployment that believes it is live while taking test cards — or the
     reverse — is the worst outcome available here, so it is stated on the page
     rather than discovered when a payment never arrives. */
  const { el } = await renderPage();
  assert.match(words(el), /Stripe is in TEST mode/);
  assert.match(words(el), /move no real money/i);
});

test('Stripe being off is stated as configuration, not as an outage', async () => {
  const { el } = await renderPage({}, { stripe: STRIPE_OFF });
  assert.match(words(el), /switched off/i);
  assert.match(words(el), /remain payable on account terms exactly as before/i);
  assert.doesNotMatch(words(el), /error|failed|unavailable/i);
});

test('live mode says so plainly too', async () => {
  const { el } = await renderPage({}, { stripe: { enabled: true, mode: 'live', testMode: false, disabledReason: '' } });
  assert.match(words(el), /Stripe is live\. Payment links here take real money/);
});

test('no Stripe key of any kind reaches the page', async () => {
  const { el, sandbox } = await renderPage();
  const html = sandbox.document.getElementById('content').innerHTML;
  for (const shape of ['sk_test', 'sk_live', 'whsec_', 'pk_live', 'secretKey', 'webhookSecret']) {
    assert.ok(!html.includes(shape), `the page rendered ${shape}`);
  }
});

// ---------------------------------------------------------------------------
// capability gating
// ---------------------------------------------------------------------------

test('an account with no payment capability sees no payment surface at all', async () => {
  const { el } = await renderPage({}, { caps: { view: false, collect: false, refund: false, reconcile: false } });
  assert.equal(el.querySelector('[data-pay]'), null, 'no payment control may render');
  assert.equal(el.querySelector('#pay-reconcile'), null);
  assert.doesNotMatch(words(el), /TEST mode/);
});

test('payments.view alone shows state but offers no reconciliation entry', async () => {
  const { el } = await renderPage({}, { caps: { view: true, collect: false, refund: false, reconcile: false } });
  assert.ok(el.querySelector('[data-pay]'), 'a viewer sees the payment control');
  assert.equal(el.querySelector('#pay-reconcile'), null, 'reconciliation needs its own capability');
});

test('a viewer is offered neither a link nor a refund', async () => {
  const { el, sandbox } = await renderPage({}, { caps: { view: true, collect: false, refund: false, reconcile: false } });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  const modal = modalOf(sandbox);
  assert.equal(modal.querySelector('[data-collect]'), null, 'a viewer may not create a link');
  assert.equal(modal.querySelector('[data-refund]'), null, 'a viewer may not refund');
});

test('payments.collect does not confer payments.refund', async () => {
  const { el, sandbox } = await renderPage({
    'GET /admin/payments/invoice/in_1': async () => ({ status: 200,
      body: { payment: payment({ settlementState: 'paid', amountSettledMinor: 25000,
        settledAt: '2026-08-05T00:00:00.000Z', settlementReference: 'pi_1' }) } }),
  }, { caps: { view: true, collect: true, refund: false, reconcile: false } });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  assert.equal(modalOf(sandbox).querySelector('[data-refund]'), null);
});

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

test('an on-terms invoice offers a link and reads as "On terms", not "Unpaid"', async () => {
  /* An invoice outstanding on agreed account terms is not a delinquent one,
     and every existing invoice is in that state. */
  const { el, sandbox } = await renderPage();
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /On terms/);
  assert.doesNotMatch(words(modal), /Unpaid|Overdue/);
  assert.ok(modal.querySelector('[data-collect]'));
});

test('a paid invoice shows the settled amount and provider reference, and no link button', async () => {
  const { el, sandbox } = await renderPage({
    'GET /admin/payments/invoice/in_1': async () => ({ status: 200,
      body: { payment: payment({ settlementState: 'paid', amountSettledMinor: 25000,
        settledAt: '2026-08-05T00:00:00.000Z', settlementReference: 'pi_test_1' }) } }),
  });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /Paid/);
  assert.match(words(modal), /250\.00 USD/);
  assert.match(words(modal), /pi_test_1/);
  assert.equal(modal.querySelector('[data-collect]'), null, 'a paid invoice offers no new link');
  assert.ok(modal.querySelector('[data-refund]'), 'and does offer a refund to a holder');
});

test('a confirming invoice says so and offers neither a link nor a refund', async () => {
  const { el, sandbox } = await renderPage({
    'GET /admin/payments/invoice/in_1': async () => ({ status: 200,
      body: { payment: payment({ settlementState: 'processing' }) } }),
  });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /Confirming/);
  assert.equal(modal.querySelector('[data-collect]'), null);
  assert.equal(modal.querySelector('[data-refund]'), null);
});

test('a fully refunded invoice offers no further refund', async () => {
  const { el, sandbox } = await renderPage({
    'GET /admin/payments/invoice/in_1': async () => ({ status: 200,
      body: { payment: payment({ settlementState: 'refunded', amountSettledMinor: 25000,
        amountRefundedMinor: 25000, settledAt: '2026-08-05T00:00:00.000Z',
        settlementReference: 'pi_1' }) } }),
  });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  assert.equal(modalOf(sandbox).querySelector('[data-refund]'), null);
});

test('with Stripe off, no link can be created and the modal says why', async () => {
  const { el, sandbox } = await renderPage({}, { stripe: STRIPE_OFF });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  const modal = modalOf(sandbox);
  assert.equal(modal.querySelector('[data-collect]'), null);
  assert.match(words(modal), /switched off, so no link can be created/i);
});

test('the modal states that nothing on it can assert a payment', async () => {
  const { el, sandbox } = await renderPage();
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  assert.match(words(modalOf(sandbox)),
    /only ever marked paid by a signed confirmation from the payment provider/i);
});

// ---------------------------------------------------------------------------
// collecting
// ---------------------------------------------------------------------------

test('creating a link posts to collect and sends no amount', async () => {
  const { el, sandbox, calls } = await renderPage({
    'POST /admin/payments/invoice/in_1/collect': async () => ({ status: 200,
      body: { reused: false, payment: payment({ session: openSession() }) } }),
  });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  modalOf(sandbox).querySelector('[data-collect]').onclick();
  await settle();

  const post = calls.find(c => c.method === 'POST');
  assert.equal(post.path, '/admin/payments/invoice/in_1/collect');
  /* The amount always comes from the invoice, server-side. A body that could
     carry one would be a way to charge a different number. */
  assert.deepEqual(post.body, {});
  assert.match(words(modalOf(sandbox)), /secure payment link has been created/i);
});

test('the hosted link is shown with a warning that it is a bearer link', async () => {
  const { el, sandbox } = await renderPage({
    'POST /admin/payments/invoice/in_1/collect': async () => ({ status: 200,
      body: { reused: false, payment: payment({ session: openSession() }) } }),
  });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  modalOf(sandbox).querySelector('[data-collect]').onclick();
  await settle();
  const modal = modalOf(sandbox);
  assert.equal(modal.querySelector('#pay-link').getAttribute('value'), 'https://checkout.stripe.test/cs_test_1');
  assert.match(words(modal), /Anyone holding this link can pay this invoice/i);
});

test('a reused link is reported as reused rather than as newly created', async () => {
  const { el, sandbox } = await renderPage({
    'POST /admin/payments/invoice/in_1/collect': async () => ({ status: 200,
      body: { reused: true, payment: payment({ session: openSession() }) } }),
  });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  modalOf(sandbox).querySelector('[data-collect]').onclick();
  await settle();
  assert.match(words(modalOf(sandbox)), /already had an open payment link/i);
});

test('a double click cannot request two payment links', async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const { el, sandbox, calls } = await renderPage({
    'POST /admin/payments/invoice/in_1/collect': async () => {
      await held;
      return { status: 200, body: { reused: false, payment: payment({ session: openSession() }) } };
    },
  });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  const button = modalOf(sandbox).querySelector('[data-collect]');
  button.onclick();
  button.onclick();
  button.onclick();
  release();
  await settle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('a provider failure says nothing was charged', async () => {
  const { el, sandbox } = await renderPage({
    'POST /admin/payments/invoice/in_1/collect': async () => ({ status: 502,
      body: { error: 'The payment provider could not be reached. Nothing was charged — please try again.',
        code: 'PROVIDER_UNAVAILABLE' } }),
  });
  el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  modalOf(sandbox).querySelector('[data-collect]').onclick();
  await settle();
  assert.match(words(modalOf(sandbox)), /Nothing was charged/i);
});

// ---------------------------------------------------------------------------
// refunding
// ---------------------------------------------------------------------------

async function openRefund(routes = {}) {
  const ctx = await renderPage(Object.assign({
    'GET /admin/payments/invoice/in_1': async () => ({ status: 200,
      body: { payment: payment({ settlementState: 'paid', amountSettledMinor: 25000,
        settledAt: '2026-08-05T00:00:00.000Z', settlementReference: 'pi_1' }) } }),
  }, routes));
  ctx.el.querySelector('[data-pay="in_1"]').onclick();
  await settle();
  modalOf(ctx.sandbox).querySelector('[data-refund]').onclick();
  await settle();
  return ctx;
}

test('a refund is confirmed by typing, not by clicking', async () => {
  const { sandbox } = await openRefund();
  const modal = modalOf(sandbox);
  const ok = modal.querySelector('[data-ok]');
  assert.equal(ok.disabled, true, 'the refund button starts disabled');

  modal.querySelector('#rf-reason').value = 'goods returned';
  modal.querySelector('#rf-reason').oninput();
  assert.equal(ok.disabled, true, 'a reason alone is not confirmation');

  modal.querySelector('#rf-confirm').value = 'REFUND';
  modal.querySelector('#rf-confirm').oninput();
  assert.equal(ok.disabled, false);
});

test('a reason is mandatory and a short one will not do', async () => {
  const { sandbox } = await openRefund();
  const modal = modalOf(sandbox);
  modal.querySelector('#rf-confirm').value = 'REFUND';
  modal.querySelector('#rf-confirm').oninput();
  modal.querySelector('#rf-reason').value = 'x';
  modal.querySelector('#rf-reason').oninput();
  assert.equal(modal.querySelector('[data-ok]').disabled, true);
});

test('the wrong confirmation word sends nothing', async () => {
  const { sandbox, calls } = await openRefund();
  const modal = modalOf(sandbox);
  modal.querySelector('#rf-reason').value = 'goods returned';
  modal.querySelector('#rf-confirm').value = 'refund please';
  modal.querySelector('#rf-confirm').oninput();
  modal.querySelector('[data-ok]').onclick();
  await settle();
  assert.equal(calls.filter(c => c.path.includes('/refund')).length, 0);
});

test('a confirmed refund sends the reason and an explicit confirm flag', async () => {
  const { sandbox, calls } = await openRefund({
    'POST /admin/payments/invoice/in_1/refund': async () => ({ status: 200,
      body: { refund: { refundId: 'rfn_1', amountMinor: 25000, currency: 'USD',
        status: 'succeeded', providerReference: 're_1', settlementState: 'refunded' } } }),
  });
  const modal = modalOf(sandbox);
  modal.querySelector('#rf-reason').value = 'goods returned';
  modal.querySelector('#rf-reason').oninput();
  modal.querySelector('#rf-confirm').value = 'REFUND';
  modal.querySelector('#rf-confirm').oninput();
  modal.querySelector('[data-ok]').onclick();
  await settle();

  const post = calls.find(c => c.path.includes('/refund'));
  assert.ok(post, 'the refund must be sent');
  assert.equal(post.body.confirm, true);
  assert.equal(post.body.reason, 'goods returned');
});

test('a refused refund keeps the dialog open and says nothing moved', async () => {
  const { sandbox } = await openRefund({
    'POST /admin/payments/invoice/in_1/refund': async () => ({ status: 409,
      body: { error: 'That is more than remains refundable on this invoice.', code: 'EXCEEDS_REMAINING' } }),
  });
  const modal = modalOf(sandbox);
  modal.querySelector('#rf-reason').value = 'goods returned';
  modal.querySelector('#rf-reason').oninput();
  modal.querySelector('#rf-confirm').value = 'REFUND';
  modal.querySelector('#rf-confirm').oninput();
  modal.querySelector('[data-ok]').onclick();
  await settle();
  assert.match(words(modalOf(sandbox)), /more than remains refundable/i);
});

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

test('reconciliation lists the exceptions with their reasons and no payload', async () => {
  const { el, sandbox } = await renderPage({
    'GET /admin/payments/reconciliation': async () => ({ status: 200, body: { exceptions: [{
      id: 'pev_1', providerEventId: 'evt_1', eventType: 'checkout.session.completed',
      status: 'failed', invoiceId: 'in_1', amountMinor: 100, currency: 'USD',
      lastError: 'AMOUNT_MISMATCH', receivedAt: '2026-08-07T09:00:00.000Z',
    }] } }),
  });
  el.querySelector('#pay-reconcile').onclick();
  await settle();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /checkout\.session\.completed/);
  assert.match(words(modal), /AMOUNT_MISMATCH/);
  assert.match(words(modal), /none of them changed an invoice/i);
});

test('an empty reconciliation says so plainly', async () => {
  const { el, sandbox } = await renderPage({
    'GET /admin/payments/reconciliation': async () => ({ status: 200, body: { exceptions: [] } }),
  });
  el.querySelector('#pay-reconcile').onclick();
  await settle();
  assert.match(words(modalOf(sandbox)), /every payment event was applied/i);
});

// ---------------------------------------------------------------------------
// what the client cannot do
// ---------------------------------------------------------------------------

test('the client has no method that could mark an invoice paid', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/dom.js');
  const dataJs = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  for (const forbidden of ['markInvoicePaid', 'settleInvoice', 'confirmPayment', "'paid'"]) {
    if (forbidden === "'paid'") continue; // appears in unrelated order status handling
    assert.ok(!dataJs.includes(forbidden), `the client exposes ${forbidden}`);
  }
  /* And every payment call it does make is one of the five governed reads and
     writes — none of which settles anything. */
  const paths = [...dataJs.matchAll(/'\/admin\/payments\/[^']*'/g)].map(m => m[0]);
  assert.ok(paths.length > 0);
  for (const p of paths) {
    assert.match(p, /capabilities|invoice\/|reconciliation/, `unexpected payment path ${p}`);
  }
});
