/* The rendered Enquiries screen (Fast-Track WS2 Phase 2).

   Renders the REAL page handler registered by js/pages_enquiries.js into the
   DOM shim and drives it the way an operator would: filter, pick an enquiry,
   write a note, press a decision button. Assertions are on what was rendered
   and what was sent, not on the source text.

   No real enquiry data appears anywhere: every submission here is invented and
   uses example.test addresses. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAdmin } = require('./helpers/dom.js');

const FILES = ['js/util.js', 'js/data.js', 'js/app.js', 'js/pages_enquiries.js'];

const CONTRACT = {
  statuses: ['new', 'in_review', 'responded', 'closed', 'spam'],
  transitions: {
    new: ['in_review', 'responded', 'closed', 'spam'],
    in_review: ['responded', 'closed', 'spam'],
    responded: ['in_review', 'closed'],
    closed: ['in_review'],
    spam: ['in_review'],
  },
};

const SUMMARY = [
  { id: 'fsub_1', formType: 'contact', name: 'Sam Example', company: 'Example Optics',
    region: 'IE', businessType: '', handlingStatus: 'new', handledAt: null,
    createdAt: '2026-08-01T09:00:00.000Z' },
  { id: 'fsub_2', formType: 'request-b2b-account', name: 'Rae Example', company: 'Example Retail',
    region: 'DE', businessType: 'Distributor', handlingStatus: 'closed', handledAt: '2026-08-02T10:00:00.000Z',
    createdAt: '2026-07-30T09:00:00.000Z' },
];

const detail = (over = {}) => ({
  id: 'fsub_1',
  formType: 'contact',
  fields: { name: 'Sam Example', email: 'sam@example.test', company: 'Example Optics', message: 'Do you ship to Ireland?' },
  sourcePath: '/contact',
  region: 'IE',
  businessType: '',
  consentVersion: '2026-08-enquiry-v1',
  consentAt: '2026-08-01T09:00:00.000Z',
  handlingStatus: 'new',
  handledBy: null,
  handledAt: null,
  handlingNote: '',
  allowedTransitions: ['in_review', 'responded', 'closed', 'spam'],
  retention: { retentionDays: 365, retainUntil: '2027-08-01T09:00:00.000Z', daysRemaining: 360, expired: false },
  createdAt: '2026-08-01T09:00:00.000Z',
  concurrencyToken: 'enquiry:fsub_1:new:',
  ...over,
});

/** Boots the panel with the given capabilities and renders the page into
 *  #content. `routes` overrides individual endpoints. */
async function renderPage(routes = {}, { view = true, manage = true, hash = '#/enquiries' } = {}){
  const sandbox = loadAdmin(FILES);
  const calls = [];
  const table = Object.assign({
    'GET /admin/enquiries/capabilities': async () => ({
      status: 200, body: { capabilities: { view, manage }, contract: CONTRACT },
    }),
    'GET /admin/enquiries?limit=25': async () => ({
      status: 200, body: { enquiries: SUMMARY, total: 2, limit: 25, offset: 0 },
    }),
    'GET /admin/enquiries/fsub_1': async () => ({ status: 200, body: { enquiry: detail() } }),
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
  sandbox.location.hash = hash;

  await sandbox.App.loadCaps();
  const el = sandbox.document.getElementById('content');
  const args = hash.split('/').slice(2);
  sandbox.App.routes.enquiries(el, args);
  await settle();
  return { sandbox, el, calls };
}

const settle = () => new Promise(r => setTimeout(r, 0)).then(() => new Promise(r => setTimeout(r, 0)));

const decisions = (el) => el.querySelectorAll('[data-to]');
const decisionFor = (el, to) => el.querySelector(`[data-to="${to}"]`);
const noteBox = (el) => el.querySelector('#enq-note');

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------

test('a visit without enquiries.view renders access denied, not the screen', async () => {
  const { el } = await renderPage({}, { view: false, manage: false });
  assert.match(el.textContent, /Access denied/);
  assert.equal(el.querySelector('[data-pick]'), null, 'no enquiry list may render');
  assert.equal(decisions(el).length, 0, 'no handling control may render');
});

test('the denied state does not leak an enquirer detail or offer a way around itself', async () => {
  const { el, calls } = await renderPage({}, { view: false, manage: false });
  assert.ok(!el.textContent.includes('example.test'));
  assert.doesNotMatch(el.textContent, /request access|grant myself|override/i);
  // Nothing is even fetched: the screen refuses before asking for data.
  assert.equal(calls.filter(c => c.path.startsWith('/admin/enquiries?')).length, 0);
});

test('enquiries.view alone renders the screen read-only', async () => {
  const { el } = await renderPage({}, { manage: false, hash: '#/enquiries/fsub_1' });
  assert.ok(el.querySelector('[data-pick]'), 'the list must render for a viewer');
  assert.match(el.textContent, /Do you ship to Ireland\?/);
  assert.equal(decisions(el).length, 0, 'a viewer gets no decision buttons');
  assert.equal(noteBox(el), null, 'a viewer gets no note box');
  assert.match(el.textContent, /Manage public enquiries/);
});

test('the capability probe is a separate endpoint from the public-content one', async () => {
  const { calls } = await renderPage();
  const paths = calls.map(c => c.path);
  assert.ok(paths.includes('/admin/enquiries/capabilities'));
  assert.ok(!paths.some(p => p.startsWith('/admin/public-content/') && p.includes('enquir')));
});

test('a public-content capability does not open the enquiry screen', async () => {
  const sandbox = loadAdmin(FILES);
  sandbox.fetch = async (url) => {
    const p = String(url).replace(/^\/api/, '');
    if (p === '/admin/public-content/capabilities') {
      return { ok: true, status: 200, json: async () => ({ capabilities: { view: true, edit: true, publish: true } }) };
    }
    return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) };
  };
  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u_pub', name: 'Publisher', role: 'admin' }));
  await sandbox.App.loadCaps();
  assert.equal(sandbox.App.can('public_content.publish'), true);
  assert.equal(sandbox.App.can('enquiries.view'), false, 'content capabilities must not confer enquiry access');
  assert.equal(sandbox.App.can('enquiries.manage'), false);
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test('the list renders one row per enquiry with its status', async () => {
  const { el } = await renderPage();
  const rows = el.querySelectorAll('[data-pick]');
  assert.deepEqual(rows.map(r => r.dataset.pick), ['fsub_1', 'fsub_2']);
  assert.match(el.textContent, /Sam Example/);
  assert.match(el.textContent, /New/);
  assert.match(el.textContent, /Closed/);
});

test('the list never renders anyone\'s message or email address', async () => {
  const { el } = await renderPage();
  assert.ok(!el.textContent.includes('Do you ship to Ireland'), 'a list must not show free text');
  assert.ok(!el.textContent.includes('sam@example.test'), 'a list must not show email addresses');
});

test('filters are select controls over the server contract, with no free-text status entry', async () => {
  const { el } = await renderPage();
  const status = el.querySelector('#enq-status');
  assert.ok(status);
  const options = status.querySelectorAll('option').map(o => o.getAttribute('value'));
  assert.deepEqual(options, ['', ...CONTRACT.statuses]);
  const textInputs = el.querySelectorAll('input');
  assert.equal(textInputs.length, 0, 'there is no free-text filter to smuggle a status through');
});

test('changing a filter re-queries the server rather than filtering locally', async () => {
  const { el, calls, sandbox } = await renderPage({
    'GET /admin/enquiries?status=closed&limit=25': async () => ({
      status: 200, body: { enquiries: [SUMMARY[1]], total: 1, limit: 25, offset: 0 },
    }),
  });
  const status = el.querySelector('#enq-status');
  status.value = 'closed';
  status.onchange({ target: status });
  await settle();
  assert.ok(calls.some(c => c.path === '/admin/enquiries?status=closed&limit=25'));
  assert.equal(sandbox.document.getElementById('content').querySelectorAll('[data-pick]').length, 1);
});

test('paging asks the server for the next offset and never for the whole table', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ ...SUMMARY[0], id: `fsub_${i}` }));
  const { el, calls } = await renderPage({
    'GET /admin/enquiries?limit=25': async () => ({ status: 200, body: { enquiries: many, total: 60, limit: 25, offset: 0 } }),
    'GET /admin/enquiries?limit=25&offset=25': async () => ({ status: 200, body: { enquiries: many, total: 60, limit: 25, offset: 25 } }),
  });
  const next = el.querySelector('[data-next]');
  assert.equal(next.getAttribute('disabled'), null);
  next.onclick();
  await settle();
  assert.ok(calls.some(c => c.path === '/admin/enquiries?limit=25&offset=25'));
  assert.ok(!calls.some(c => /limit=(0|1000|9999)/.test(c.path)), 'no request may ask for an unbounded page');
});

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

test('the detail view renders the submitted fields read-only', async () => {
  const { el } = await renderPage({}, { hash: '#/enquiries/fsub_1' });
  assert.match(el.textContent, /Sam Example/);
  assert.match(el.textContent, /sam@example\.test/);
  assert.match(el.textContent, /Do you ship to Ireland\?/);
  /* The only writable control is the internal note. Nothing the enquirer sent
     has an input bound to it. */
  const editable = el.querySelectorAll('textarea').concat(el.querySelectorAll('input'));
  assert.deepEqual(editable.map(e => e.id), ['enq-note']);
});

test('there is no delete control anywhere on the screen', async () => {
  const { el } = await renderPage({}, { hash: '#/enquiries/fsub_1' });
  assert.doesNotMatch(el.textContent, /delete|remove this|erase/i);
  assert.equal(el.querySelector('[data-delete]'), null);
});

test('enquirer content is escaped, so a submitted tag cannot become markup', async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const { el } = await renderPage({
    'GET /admin/enquiries/fsub_1': async () => ({
      status: 200,
      body: { enquiry: detail({ fields: { name: hostile, message: hostile } }) },
    }),
  }, { hash: '#/enquiries/fsub_1' });
  /* The tag survives as escaped text, not as an element. */
  assert.match(el.innerHTML, /&lt;img src=x onerror=/);
  assert.equal(el.querySelector('img'), null, 'submitted markup must not become an element');
  assert.ok(!el.innerHTML.includes('<img src=x'), 'the raw tag must not reach the document');
});

test('consent and retention are shown as facts, with an elapsed period called out', async () => {
  const { el } = await renderPage({}, { hash: '#/enquiries/fsub_1' });
  assert.match(el.textContent, /Contact consent given/);
  assert.match(el.textContent, /Retention: 365 days/);

  const { el: overdue } = await renderPage({
    'GET /admin/enquiries/fsub_1': async () => ({
      status: 200,
      body: { enquiry: detail({ retention: { retentionDays: 30, retainUntil: '2026-01-01T00:00:00.000Z', daysRemaining: -200, expired: true } }) },
    }),
  }, { hash: '#/enquiries/fsub_1' });
  assert.match(overdue.textContent, /due for removal since/);
  assert.match(overdue.textContent, /not performed from this screen/);
});

test('a submission without consent says so rather than implying it was given', async () => {
  const { el } = await renderPage({
    'GET /admin/enquiries/fsub_1': async () => ({
      status: 200, body: { enquiry: detail({ consentAt: null, consentVersion: '' }) },
    }),
  }, { hash: '#/enquiries/fsub_1' });
  assert.match(el.textContent, /No contact consent was recorded/);
});

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------

test('only the transitions the server allows are offered', async () => {
  const { el } = await renderPage({}, { hash: '#/enquiries/fsub_1' });
  assert.deepEqual(decisions(el).map(b => b.dataset.to), ['in_review', 'responded', 'closed', 'spam']);

  const { el: closed } = await renderPage({
    'GET /admin/enquiries/fsub_1': async () => ({
      status: 200,
      body: { enquiry: detail({ handlingStatus: 'closed', handledAt: '2026-08-02T10:00:00.000Z', allowedTransitions: ['in_review'], concurrencyToken: 'enquiry:fsub_1:closed:2026-08-02T10:00:00.000Z' }) },
    }),
  }, { hash: '#/enquiries/fsub_1' });
  assert.deepEqual(decisions(closed).map(b => b.dataset.to), ['in_review']);
});

test('a decision posts the status, the note and the token from the matching read', async () => {
  let sent = null;
  const { el, calls } = await renderPage({
    'POST /admin/enquiries/fsub_1/status': async () => ({
      status: 200,
      body: { enquiry: detail({ handlingStatus: 'in_review', handledBy: 'u_ops', handledAt: '2026-08-06T13:00:00.000Z', handlingNote: 'Picked up.', allowedTransitions: ['responded', 'closed', 'spam'], concurrencyToken: 'enquiry:fsub_1:in_review:2026-08-06T13:00:00.000Z' }) },
    }),
  }, { hash: '#/enquiries/fsub_1' });

  const note = noteBox(el);
  note.value = 'Picked up.';
  note.oninput();
  decisionFor(el, 'in_review').onclick();
  await settle();

  sent = calls.find(c => c.method === 'POST');
  assert.ok(sent, 'a decision must reach the server');
  assert.deepEqual(sent.body, { status: 'in_review', concurrencyToken: 'enquiry:fsub_1:new:', note: 'Picked up.' });
});

test('a decision cannot carry a handler id or any submitted field', async () => {
  const { el, calls } = await renderPage({
    'POST /admin/enquiries/fsub_1/status': async () => ({
      status: 200, body: { enquiry: detail({ handlingStatus: 'closed', handledAt: '2026-08-06T13:00:00.000Z', allowedTransitions: ['in_review'] }) },
    }),
  }, { hash: '#/enquiries/fsub_1' });
  decisionFor(el, 'closed').onclick();
  await settle();
  const sent = calls.find(c => c.method === 'POST');
  assert.deepEqual(Object.keys(sent.body).sort(), ['concurrencyToken', 'note', 'status']);
  for (const forbidden of ['handledBy', 'handled_by', 'actor', 'payload', 'fields', 'consentAt', 'deliveryState']) {
    assert.ok(!(forbidden in sent.body), `${forbidden} must never be sent`);
  }
});

test('the screen adopts the server response, so the old token is dead', async () => {
  const { el, calls } = await renderPage({
    'POST /admin/enquiries/fsub_1/status': async () => ({
      status: 200,
      body: { enquiry: detail({ handlingStatus: 'in_review', handledAt: '2026-08-06T13:00:00.000Z', allowedTransitions: ['responded', 'closed', 'spam'], concurrencyToken: 'enquiry:fsub_1:in_review:2026-08-06T13:00:00.000Z' }) },
    }),
    'GET /admin/enquiries?limit=25': async () => ({
      status: 200,
      body: { enquiries: [{ ...SUMMARY[0], handlingStatus: 'in_review' }, SUMMARY[1]], total: 2, limit: 25, offset: 0 },
    }),
  }, { hash: '#/enquiries/fsub_1' });

  decisionFor(el, 'in_review').onclick();
  await settle();
  assert.deepEqual(decisions(el).map(b => b.dataset.to), ['responded', 'closed', 'spam']);

  decisionFor(el, 'closed').onclick();
  await settle();
  const posts = calls.filter(c => c.method === 'POST');
  assert.equal(posts[1].body.concurrencyToken, 'enquiry:fsub_1:in_review:2026-08-06T13:00:00.000Z');
});

test('the list is refreshed after a decision, so a stale status is not left on screen', async () => {
  const { el, calls } = await renderPage({
    'POST /admin/enquiries/fsub_1/status': async () => ({
      status: 200, body: { enquiry: detail({ handlingStatus: 'spam', handledAt: '2026-08-06T13:00:00.000Z', allowedTransitions: ['in_review'] }) },
    }),
  }, { hash: '#/enquiries/fsub_1' });
  const before = calls.filter(c => c.path.startsWith('/admin/enquiries?')).length;
  decisionFor(el, 'spam').onclick();
  await settle();
  const after = calls.filter(c => c.path.startsWith('/admin/enquiries?')).length;
  assert.ok(after > before, 'the list must be re-read after a transition');
});

// ---------------------------------------------------------------------------
// failure handling
// ---------------------------------------------------------------------------

test('a 409 says nothing was saved and offers a reload, without retrying', async () => {
  const { el, calls } = await renderPage({
    'POST /admin/enquiries/fsub_1/status': async () => ({ status: 409, body: { error: 'stale', code: 'STALE_TOKEN' } }),
  }, { hash: '#/enquiries/fsub_1' });
  decisionFor(el, 'closed').onclick();
  await settle();
  assert.match(el.textContent, /was NOT saved/);
  assert.ok(el.querySelector('[data-reload]'), 'a reload must be offered');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'a decision must never be replayed automatically');
});

test('a 422 explains the illegal move and leaves the record alone', async () => {
  const { el } = await renderPage({
    'POST /admin/enquiries/fsub_1/status': async () => ({ status: 422, body: { error: 'illegal', code: 'ILLEGAL_TRANSITION' } }),
  }, { hash: '#/enquiries/fsub_1' });
  decisionFor(el, 'responded').onclick();
  await settle();
  assert.match(el.textContent, /Nothing was changed/);
  assert.match(el.textContent, /New/, 'the record must still show its unchanged status');
});

test('a 403 on the transition is reported without hiding the enquiry already read', async () => {
  const { el } = await renderPage({
    'POST /admin/enquiries/fsub_1/status': async () => ({ status: 403, body: { error: 'forbidden' } }),
  }, { hash: '#/enquiries/fsub_1' });
  decisionFor(el, 'closed').onclick();
  await settle();
  assert.match(el.textContent, /does not have permission/);
  assert.match(el.textContent, /Do you ship to Ireland\?/);
});

test('a failed list load reports itself rather than rendering an empty inbox as fact', async () => {
  const { el } = await renderPage({
    'GET /admin/enquiries?limit=25': async () => ({ status: 500, body: { error: 'boom' } }),
  });
  assert.doesNotMatch(el.textContent, /No enquiries match these filters/);
  assert.match(el.textContent, /could not be updated|check your connection/i);
});
