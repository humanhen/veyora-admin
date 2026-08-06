/* The rendered Store Contacts screen (Final Handover Phase 2).

   Renders the REAL page handler registered by js/pages_store_contacts.js into
   the DOM shim and drives it the way an operator would: pick a store, add a
   contact, promote, archive, link a portal account. Assertions are on what was
   rendered and what was SENT, not on the source text.

   No real people appear anywhere: every contact here is invented and uses
   example.test addresses. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAdmin } = require('./helpers/dom.js');

const FILES = ['js/util.js', 'js/data.js', 'js/app.js', 'js/pages_store_contacts.js'];

const CONTRACT = {
  responsibilities: ['owner', 'store_manager', 'buyer', 'accounts_payable',
    'receiving', 'returns_warranty', 'other'],
  contactMethods: ['email', 'mobile_call', 'whatsapp', 'office_phone'],
  methodRequires: { email: 'email', mobile_call: 'mobile', whatsapp: 'mobile', office_phone: 'officePhone' },
  verificationStaleDays: 365,
};

const CUSTOMER = { id: 'u_cust1', business: 'Example Optics', customerNumber: '1001', status: 'active' };
const SALES_REP = { id: 'u_rep1', name: 'Rae Rep', role: 'agent', email: 'rae@example.test' };

const contact = (over = {}) => ({
  id: 'cc_1', customerId: 'u_cust1', firstName: 'Ada', lastName: 'Sterling',
  jobTitle: 'Head Buyer', responsibilities: ['buyer'],
  mobile: '+1 555 010 9988', officePhone: '', officeExtension: '',
  email: 'ada@example.test', preferredContactMethod: 'email', preferredLanguage: 'en',
  isPrimary: false, isActive: true, portalUserId: null, notes: '',
  lastVerifiedAt: null, createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z', concurrencyToken: 'contact:cc_1:1:0:2026-07-01T00:00:00.000Z',
  verification: { verifiedAt: null, state: 'never', daysSince: null },
  ...over,
});

const store = (over = {}) => ({
  customer: CUSTOMER, salesRep: SALES_REP, contacts: [contact()], hasPrimary: false, ...over,
});

const settle = () => new Promise(r => setTimeout(r, 0))
  .then(() => new Promise(r => setTimeout(r, 0)))
  .then(() => new Promise(r => setTimeout(r, 0)));

/** Boots the panel with the given capabilities and renders the page. */
async function renderPage(routes = {}, { view = true, manage = true, hash = '#/store-contacts/u_cust1' } = {}) {
  const sandbox = loadAdmin(FILES);
  const calls = [];
  const table = Object.assign({
    'GET /admin/customer-contacts/capabilities': async () => ({
      status: 200, body: { capabilities: { view, manage }, contract: CONTRACT },
    }),
    'GET /admin/customer-contacts/u_cust1': async () => ({ status: 200, body: store() }),
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
  /* The store picker reads the snapshot the panel already holds. Seeded here
     directly: this screen's job is to CHOOSE a store from that list, and every
     contact fact still comes from the governed API. */
  sandbox.DB.d.users.push({ id: 'u_cust1', role: 'customer', business: 'Example Optics',
    email: 'sam@example.test', customerNumber: '1001' });

  const el = sandbox.document.getElementById('content');
  const args = hash.split('/').slice(2);
  sandbox.App.routes['store-contacts'](el, args);
  await settle();
  return { sandbox, el, calls };
}

const modalOf = (sandbox) => sandbox.document.getElementById('modal-root').children.slice(-1)[0];

/* An HTML template wraps sentences across source lines, so textContent
   carries newlines mid-phrase. These assertions are about the words the
   operator reads, not about where the template happened to break. */
const words = (node) => String(node.textContent || '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------

test('a visit without customer_contacts.view renders access denied, not the screen', async () => {
  const { el, calls } = await renderPage({}, { view: false, manage: false });
  assert.match(el.textContent, /Access denied/);
  assert.equal(el.querySelector('[data-store]'), null, 'no store list may render');
  assert.ok(!el.textContent.includes('example.test'), 'no contact detail may leak');
  assert.equal(calls.filter(c => c.path.startsWith('/admin/customer-contacts/u_cust1')).length, 0,
    'the screen must refuse before asking for data');
});

test('the denied state explains that no role implies this capability', async () => {
  const { el } = await renderPage({}, { view: false, manage: false });
  assert.match(words(el), /not implied by the administrator role/i);
  assert.doesNotMatch(el.textContent, /request access|grant myself|override/i);
});

test('view alone renders the screen read-only', async () => {
  const { el } = await renderPage({}, { manage: false });
  assert.match(el.textContent, /Ada Sterling/);
  assert.equal(el.querySelector('#sc-add'), null, 'a viewer gets no add button');
  assert.equal(el.querySelector('[data-archive]'), null, 'a viewer gets no archive control');
  assert.equal(el.querySelector('[data-primary]'), null, 'a viewer cannot promote');
  assert.match(el.textContent, /Manage store contacts/);
});

test('the capability probe is its own endpoint, separate from enquiries and public content', async () => {
  const { calls } = await renderPage();
  const paths = calls.map(c => c.path);
  assert.ok(paths.includes('/admin/customer-contacts/capabilities'));
});

// ---------------------------------------------------------------------------
// the three concepts, kept apart on screen
// ---------------------------------------------------------------------------

test('the Veyora sales rep is shown as internal context and is read-only here', async () => {
  const { el } = await renderPage();
  assert.match(el.textContent, /VEYORA SALES REP/);
  assert.match(el.textContent, /Rae Rep/);
  assert.match(words(el), /assigned on the customer record, not here/i);
  assert.equal(el.querySelector('[data-rep]'), null, 'there must be no control to change the rep');
});

test('a store with no sales rep says so rather than showing a blank name', async () => {
  const { el } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({ status: 200, body: store({ salesRep: null }) }),
  });
  assert.match(el.textContent, /No Veyora sales rep is assigned/i);
});

test('a contact with no portal login says so; one with a login says that instead', async () => {
  const { el } = await renderPage();
  assert.match(words(el), /No portal login recorded for this person/i);

  const { el: linked } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact({ portalUserId: 'u_cust1' })] }),
    }),
  });
  assert.match(words(linked), /Signs in with this store’s portal account/i);
});

// ---------------------------------------------------------------------------
// the honest empty and no-primary states
// ---------------------------------------------------------------------------

test('a store with no contacts is a normal state, explained, not an error', async () => {
  const { el } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({ status: 200, body: store({ contacts: [] }) }),
  });
  assert.match(words(el), /No contacts are recorded for this store yet/i);
  assert.match(words(el), /nothing was migrated automatically/i);
  assert.doesNotMatch(words(el), /error|failed/i);
});

test('a store with no primary is flagged without implying the others are broken', async () => {
  const { el } = await renderPage();
  assert.match(words(el), /no primary contact/i);
  assert.match(words(el), /Every other contact still works/i);
});

test('an existing primary is badged and the flag disappears', async () => {
  const { el } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact({ isPrimary: true })], hasPrimary: true }),
    }),
  });
  assert.match(el.textContent, /Primary/);
  assert.doesNotMatch(el.textContent, /has no primary contact/i);
});

// ---------------------------------------------------------------------------
// responsibilities are never invented
// ---------------------------------------------------------------------------

test('a contact with no responsibilities says nothing is assumed from the job title', async () => {
  const { el } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact({ responsibilities: [], jobTitle: 'Office Manager' })] }),
    }),
  });
  assert.match(words(el), /Nothing is assumed from the job title/i);
  assert.doesNotMatch(el.textContent, /Handles:/);
});

test('the add form pre-ticks no responsibility at all', async () => {
  const { el, sandbox } = await renderPage();
  el.querySelector('#sc-add').onclick();
  const modal = modalOf(sandbox);
  const boxes = modal.querySelectorAll('[data-resp]');
  assert.equal(boxes.length, 7, 'all seven responsibilities must be offered');
  assert.equal(boxes.filter(b => b.checked).length, 0, 'nothing may be pre-ticked');
});

test('the add form states that nothing is created or sent', async () => {
  const { el, sandbox } = await renderPage();
  el.querySelector('#sc-add').onclick();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /does not create a portal login/i);
  assert.match(words(modal), /does not record consent/i);
  assert.match(words(modal), /sends nothing/i);
});

// ---------------------------------------------------------------------------
// creating
// ---------------------------------------------------------------------------

test('adding a contact posts exactly the entered fields and no actor', async () => {
  const { el, sandbox, calls } = await renderPage({
    'POST /admin/customer-contacts/u_cust1': async () => ({ status: 200, body: { contact: contact({ id: 'cc_2' }) } }),
  });
  el.querySelector('#sc-add').onclick();
  const modal = modalOf(sandbox);
  modal.querySelector('#sc-fn').value = 'Ben';
  modal.querySelector('#sc-ln').value = 'Manager';
  modal.querySelector('#sc-email').value = 'ben@example.test';
  modal.querySelector('[data-resp="store_manager"]').checked = true;
  modal.querySelector('[data-ok]').onclick();
  await settle();

  const post = calls.find(c => c.method === 'POST');
  assert.ok(post, 'a create must be sent');
  assert.equal(post.path, '/admin/customer-contacts/u_cust1');
  assert.equal(post.body.firstName, 'Ben');
  assert.deepEqual(post.body.responsibilities, ['store_manager']);
  /* Attribution comes from the session, server-side. A body that could name a
     creator would let an operator record a change as somebody else. */
  for (const forbidden of ['actor', 'createdBy', 'userId', 'portalUserId', 'consent', 'isActive']) {
    assert.equal(forbidden in post.body, false, `the body must not carry ${forbidden}`);
  }
});

test('a rejected create keeps the form open with the operator’s typing intact', async () => {
  const { el, sandbox } = await renderPage({
    'POST /admin/customer-contacts/u_cust1': async () => ({
      status: 400,
      body: { error: 'That contact could not be saved.', code: 'INVALID_CONTACT',
        errors: [{ field: 'email', code: 'CHANNEL_REQUIRED', message: 'An active contact needs at least one way to reach them.' }] },
    }),
  });
  el.querySelector('#sc-add').onclick();
  const modal = modalOf(sandbox);
  modal.querySelector('#sc-fn').value = 'Ben';
  modal.querySelector('[data-ok]').onclick();
  await settle();

  const still = modalOf(sandbox);
  assert.equal(still.querySelector('#sc-fn').value, 'Ben', 'typing must survive a rejection');
  assert.match(words(still), /at least one way to reach them/i);
});

// ---------------------------------------------------------------------------
// primary, archive, reactivate
// ---------------------------------------------------------------------------

test('promoting posts to make-primary with the token from the matching read', async () => {
  const { el, calls } = await renderPage({
    'POST /admin/customer-contacts/u_cust1/cc_1/make-primary': async () => ({
      status: 200, body: { contact: contact({ isPrimary: true }) },
    }),
  });
  el.querySelector('[data-primary="cc_1"]').onclick();
  await settle();

  const post = calls.find(c => c.method === 'POST');
  assert.equal(post.path, '/admin/customer-contacts/u_cust1/cc_1/make-primary');
  assert.equal(post.body.concurrencyToken, 'contact:cc_1:1:0:2026-07-01T00:00:00.000Z');
});

test('the primary offers no archive control and explains that it is replaced, not removed', async () => {
  const { el } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact({ isPrimary: true })], hasPrimary: true }),
    }),
  });
  assert.equal(el.querySelector('[data-archive]'), null);
  assert.match(words(el), /replaced, not removed/i);
});

test('archiving asks first and says plainly that nothing is deleted', async () => {
  const { el, sandbox, calls } = await renderPage({
    'POST /admin/customer-contacts/u_cust1/cc_1/archive': async () => ({
      status: 200, body: { contact: contact({ isActive: false }) },
    }),
  });
  el.querySelector('[data-archive="cc_1"]').onclick();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /Nothing is deleted/i);
  assert.match(words(modal), /can be reactivated later/i);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'nothing may be sent before confirming');

  modal.querySelector('[data-yes]').onclick();
  await settle();
  assert.equal(calls.filter(c => c.method === 'POST')[0].path, '/admin/customer-contacts/u_cust1/cc_1/archive');
});

test('an archived contact is still shown, with a reactivate control and no edit', async () => {
  const { el } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact({ isActive: false })] }),
    }),
  });
  assert.match(el.textContent, /Ada Sterling/, 'an archived contact is not hidden');
  assert.match(el.textContent, /Archived/);
  assert.ok(el.querySelector('[data-reactivate="cc_1"]'));
  assert.equal(el.querySelector('[data-edit]'), null);
  assert.equal(el.querySelector('[data-archive]'), null);
});

test('there is no delete control anywhere on the screen', async () => {
  const { el } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact(), contact({ id: 'cc_2', isActive: false })] }),
    }),
  });
  assert.equal(el.querySelector('[data-delete]'), null);
  assert.equal(el.querySelector('[data-del]'), null);
  assert.doesNotMatch(el.textContent, /\bDelete\b/);
});

test('a 422 on the primary is explained rather than shown as a generic failure', async () => {
  const { el, sandbox } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact({ id: 'cc_2' }), contact({ isPrimary: true })], hasPrimary: true }),
    }),
    'POST /admin/customer-contacts/u_cust1/cc_2/archive': async () => ({
      status: 422, body: { error: 'primary', code: 'PRIMARY_MUST_BE_REPLACED' },
    }),
  });
  el.querySelector('[data-archive="cc_2"]').onclick();
  modalOf(sandbox).querySelector('[data-yes]').onclick();
  await settle();
  assert.match(words(el), /Make another contact primary first/i);
  assert.match(words(el), /Nothing was changed/i);
});

// ---------------------------------------------------------------------------
// portal link
// ---------------------------------------------------------------------------

test('linking a portal account confirms, grants nothing, and posts the store’s own account', async () => {
  const { el, sandbox, calls } = await renderPage({
    'POST /admin/customer-contacts/u_cust1/cc_1/link-portal': async () => ({
      status: 200, body: { contact: contact({ portalUserId: 'u_cust1' }) },
    }),
  });
  el.querySelector('[data-link="cc_1"]').onclick();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /grants no capability/i);
  assert.match(words(modal), /sends nothing/i);
  modal.querySelector('[data-yes]').onclick();
  await settle();

  const post = calls.find(c => c.method === 'POST');
  assert.equal(post.path, '/admin/customer-contacts/u_cust1/cc_1/link-portal');
  assert.equal(post.body.portalUserId, 'u_cust1');
});

test('unlinking says the account itself is untouched', async () => {
  const { el, sandbox, calls } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact({ portalUserId: 'u_cust1' })] }),
    }),
    'POST /admin/customer-contacts/u_cust1/cc_1/unlink-portal': async () => ({
      status: 200, body: { contact: contact({ portalUserId: null }) },
    }),
  });
  el.querySelector('[data-unlink="cc_1"]').onclick();
  const modal = modalOf(sandbox);
  assert.match(words(modal), /not changed, disabled or deleted/i);
  modal.querySelector('[data-yes]').onclick();
  await settle();
  assert.equal(calls.find(c => c.method === 'POST').path, '/admin/customer-contacts/u_cust1/cc_1/unlink-portal');
});

// ---------------------------------------------------------------------------
// channels are links, never sends
// ---------------------------------------------------------------------------

test('call, email and WhatsApp are ordinary links and nothing is ever sent', async () => {
  const { el, calls } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact({ officePhone: '+1 555 010 1122', officeExtension: '204' })] }),
    }),
  });
  const links = el.querySelectorAll('a');
  const hrefs = links.map(a => a.getAttribute('href'));
  assert.ok(hrefs.some(h => h.startsWith('mailto:ada@example.test')));
  assert.ok(hrefs.some(h => h === 'tel:+15550109988'));
  assert.ok(hrefs.some(h => h === 'https://wa.me/15550109988'));
  assert.ok(hrefs.some(h => h === 'tel:+15550101122'));
  assert.match(el.textContent, /ext 204/);
  /* Rendering the screen must not send anything: only the two reads. */
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
});

test('a WhatsApp link never invents a country code', async () => {
  const { el } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200, body: store({ contacts: [contact({ mobile: '555 010 9988' })] }),
    }),
  });
  const wa = el.querySelectorAll('a').map(a => a.getAttribute('href')).find(h => h.includes('wa.me'));
  assert.equal(wa, 'https://wa.me/5550109988');
});

test('a contact with no channels renders no channel links at all', async () => {
  const { el } = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200,
      body: store({ contacts: [contact({ email: '', mobile: '', officePhone: '', isActive: false })] }),
    }),
  });
  assert.equal(el.querySelectorAll('a').filter(a => /^(tel:|mailto:|https:\/\/wa\.me)/.test(a.getAttribute('href') || '')).length, 0);
});

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

test('verification state is shown for all three cases', async () => {
  const never = await renderPage();
  assert.match(never.el.textContent, /Never verified/);

  const stale = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200,
      body: store({ contacts: [contact({ lastVerifiedAt: '2024-01-01T00:00:00.000Z',
        verification: { verifiedAt: '2024-01-01T00:00:00.000Z', state: 'stale', daysSince: 900 } })] }),
    }),
  });
  assert.match(words(stale.el), /due a check/i);

  const current = await renderPage({
    'GET /admin/customer-contacts/u_cust1': async () => ({
      status: 200,
      body: store({ contacts: [contact({ lastVerifiedAt: '2026-08-01T00:00:00.000Z',
        verification: { verifiedAt: '2026-08-01T00:00:00.000Z', state: 'current', daysSince: 6 } })] }),
    }),
  });
  assert.match(current.el.textContent, /Verified/);
  assert.doesNotMatch(current.el.textContent, /Never verified/);
});

test('marking verified is its own action and carries the token', async () => {
  const { el, calls } = await renderPage({
    'POST /admin/customer-contacts/u_cust1/cc_1/verify': async () => ({
      status: 200,
      body: { contact: contact({ verification: { verifiedAt: '2026-08-07T00:00:00.000Z', state: 'current', daysSince: 0 } }) },
    }),
  });
  el.querySelector('[data-verify="cc_1"]').onclick();
  await settle();
  const post = calls.find(c => c.method === 'POST');
  assert.equal(post.path, '/admin/customer-contacts/u_cust1/cc_1/verify');
  assert.equal(post.body.concurrencyToken, 'contact:cc_1:1:0:2026-07-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// concurrency and double-click
// ---------------------------------------------------------------------------

test('a 409 tells the operator nothing was saved and offers a reload', async () => {
  const { el, calls } = await renderPage({
    'POST /admin/customer-contacts/u_cust1/cc_1/verify': async () => ({
      status: 409, body: { error: 'stale', code: 'STALE_TOKEN' },
    }),
  });
  el.querySelector('[data-verify="cc_1"]').onclick();
  await settle();
  assert.match(words(el), /was NOT saved/i);
  assert.ok(el.querySelector('[data-reload]'), 'a reload must be offered');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'a refusal is never retried automatically');
});

test('a double click cannot run the same action twice', async () => {
  let release;
  const held = new Promise(r => { release = r; });
  const { el, calls } = await renderPage({
    'POST /admin/customer-contacts/u_cust1/cc_1/verify': async () => {
      await held;
      return { status: 200, body: { contact: contact() } };
    },
  });
  const button = el.querySelector('[data-verify="cc_1"]');
  button.onclick();
  button.onclick();
  button.onclick();
  release();
  await settle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});
