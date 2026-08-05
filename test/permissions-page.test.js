/* The rendered Account Permissions screen (B2.4B1).

   Renders the REAL page handler registered by js/pages_permissions.js into the
   DOM shim and drives it the way an operator would: pick an account, toggle a
   checkbox, press Save. Assertions are on what was rendered and what was sent,
   not on the source text. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAdmin } = require('./helpers/dom.js');

const FILES = ['js/util.js', 'js/data.js', 'js/app.js', 'js/pages_permissions.js'];

const REGISTRY = [
  { key: 'public_content.view', label: 'View public content administration', description: 'Read public-content records.' },
  { key: 'public_content.edit', label: 'Edit public content', description: 'Modify public-content fields.' },
  { key: 'public_content.publish', label: 'Publish and unpublish public content', description: 'Publish records.' },
  { key: 'permissions.manage', label: 'Manage account permissions', description: 'Grant and revoke capabilities.' },
];

const USERS = [
  { id: 'u_1', username: 'alex', business: 'Alex Editor', firstName: 'Alex', lastName: 'E', email: 'alex@example.test', role: 'customer', status: 'active' },
  { id: 'u_2', username: 'sam', business: 'Sam Publisher', firstName: 'Sam', lastName: 'P', email: 'sam@example.test', role: 'admin', status: 'active' },
  { id: 'u_3', username: 'dana', business: 'Dana Disabled', firstName: 'Dana', lastName: 'D', email: 'dana@example.test', role: 'agent', status: 'pending' },
];

const payload = (over = {}) => ({
  user: { id: 'u_1', displayName: 'Alex Editor', role: 'customer', status: 'active' },
  permissions: [
    { permissionKey: 'public_content.view', isActive: true, grantedBy: 'u_2', grantedAt: '2026-08-01T00:00:00.000Z', revokedBy: null, revokedAt: null },
    { permissionKey: 'public_content.publish', isActive: false, grantedBy: 'u_2', grantedAt: '2026-07-01T00:00:00.000Z', revokedBy: 'u_2', revokedAt: '2026-07-20T00:00:00.000Z' },
  ],
  activePermissions: ['public_content.view'],
  concurrencyToken: 'perms:u_1:v1',
  granted: [], revoked: [],
  ...over,
});

/** Boots the panel, grants the caller `permissions.manage`, and renders the
 *  page into #content. `routes` overrides individual endpoints. */
async function renderPage(routes = {}, { manage = true, hash = '#/account-permissions' } = {}){
  const sandbox = loadAdmin(FILES);
  const calls = [];
  const table = Object.assign({
    'GET /admin/account-permissions/registry': async () =>
      manage ? { status: 200, body: { permissions: REGISTRY } } : { status: 403, body: { error: 'forbidden' } },
    'GET /admin/account-permissions/users/u_1': async () => ({ status: 200, body: payload() }),
  }, routes);

  sandbox.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const p = String(url).replace(/^\/api/, '');
    calls.push({ method, path: p, body: opts.body ? JSON.parse(opts.body) : null });
    const responder = table[`${method} ${p}`] || table[`${method} *`];
    const r = responder ? await responder() : { status: 404, body: { error: 'not found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };

  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u_2', name: 'Manager', role: 'admin' }));
  /* The account list is the one the panel already loaded for the Users
     screen — the page reads DB.d.users and creates no second directory. */
  sandbox.DB.load().users = USERS.map(u => ({ ...u }));
  sandbox.location.hash = hash;

  await sandbox.App.loadCaps();
  const el = sandbox.document.getElementById('content');
  const args = hash.split('/').slice(2);
  sandbox.App.routes['account-permissions'](el, args);
  await settle();
  return { sandbox, el, calls };
}

/** Lets the page's in-flight promises resolve. */
const settle = () => new Promise(r => setTimeout(r, 0)).then(() => new Promise(r => setTimeout(r, 0)));

const perms = (el) => el.querySelectorAll('[data-perm]');
const permFor = (el, key) => el.querySelector(`[data-perm="${key}"]`);
const saveBtn = (el) => el.querySelector('[data-save]');

// ---------------------------------------------------------------------------
// 3 — access
// ---------------------------------------------------------------------------

test('3 — a direct visit without permissions.manage renders access denied, not the screen', async () => {
  const { el } = await renderPage({}, { manage: false });
  assert.match(el.textContent, /Access denied/);
  assert.match(el.textContent, /does not have the/i);
  assert.equal(perms(el).length, 0, 'no capability control may render');
  assert.equal(el.querySelector('[data-pick]'), null, 'no account list may render');
});

test('the denied state offers no bootstrap or self-grant control', async () => {
  const { el } = await renderPage({}, { manage: false });
  assert.equal(saveBtn(el), null);
  assert.doesNotMatch(el.textContent, /bootstrap|grant myself|request access/i);
});

// ---------------------------------------------------------------------------
// 4/5/6 — registry and account list
// ---------------------------------------------------------------------------

test('4 — exactly four capabilities render, grouped, with labels and descriptions', async () => {
  const { el } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  const boxes = perms(el);
  assert.equal(boxes.length, 4);
  assert.deepEqual(boxes.map(b => b.dataset.perm), REGISTRY.map(r => r.key));
  for (const r of REGISTRY) {
    assert.ok(el.textContent.includes(r.label), `missing label ${r.label}`);
    assert.ok(el.textContent.includes(r.description), `missing description for ${r.key}`);
  }
  assert.match(el.textContent, /PUBLIC CONTENT/);
  assert.match(el.textContent, /PERMISSION ADMINISTRATION/);
});

test('5 — there is no free-text or wildcard permission control', async () => {
  const { el } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  for (const box of perms(el)) assert.equal(box.getAttribute('type'), 'checkbox');
  /* The only inputs are the four checkboxes plus the account search/filter. */
  const inputs = el.querySelectorAll('input').filter(i => i.getAttribute('type') !== 'checkbox');
  assert.deepEqual(inputs.map(i => i.id), ['pm-q'], 'the only free text is the account search');
  assert.equal(el.querySelector('textarea'), null);
  assert.ok(!el.innerHTML.includes('*'), 'no wildcard may be offered anywhere');
});

test('6 — the existing account list is reused; no second user directory is created', async () => {
  const { el, calls } = await renderPage();
  const picks = el.querySelectorAll('[data-pick]').map(b => b.dataset.pick);
  assert.deepEqual(picks.sort(), ['u_1', 'u_2', 'u_3']);
  assert.ok(!calls.some(c => /\/users\b|\/admin\/users/.test(c.path)),
    'the page must not fetch its own user directory');
});

test('the account list shows role and status but no unrelated personal data', async () => {
  const { el } = await renderPage();
  assert.match(el.textContent, /Alex Editor/);
  assert.match(el.textContent, /@alex/);
  assert.match(el.textContent, /customer/);
  assert.match(el.textContent, /Pending/, 'a non-active account is flagged');
  for (const leak of ['alex@example.test', 'balance', 'pricing', 'taxId', 'password']) {
    assert.ok(!el.innerHTML.includes(leak), `leaked ${leak}`);
  }
});

// ---------------------------------------------------------------------------
// 7/8/9/10 — loading and representing grants
// ---------------------------------------------------------------------------

test('7/8 — selecting an account loads its permissions and reflects active grants', async () => {
  const { el, calls } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  assert.ok(calls.some(c => c.path === '/admin/account-permissions/users/u_1'));
  assert.match(el.textContent, /Alex Editor/);
  assert.equal(permFor(el, 'public_content.view').checked, true);
  assert.equal(permFor(el, 'public_content.edit').checked, false);
});

test('9 — a revoked grant is not shown as active, and its history is visible', async () => {
  const { el } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  assert.equal(permFor(el, 'public_content.publish').checked, false,
    'a revoked capability must never render as held');
  assert.match(el.textContent, /Revoked/);
});

test('10 — edit and publish are independent and never imply one another', async () => {
  const { el } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  assert.match(el.textContent, /Editing and publishing are independent/);

  permFor(el, 'public_content.edit').check(true);
  assert.equal(permFor(el, 'public_content.publish').checked, false,
    'granting edit must not tick publish');
});

// ---------------------------------------------------------------------------
// 24/25/11/12 — toggling and saving
// ---------------------------------------------------------------------------

test('24 — toggling a control performs no mutation', async () => {
  const { el, calls } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  const before = calls.length;
  permFor(el, 'public_content.edit').check(true);
  permFor(el, 'permissions.manage').check(true);
  await settle();
  assert.equal(calls.length, before, 'a checkbox must never call the API');
  assert.ok(!calls.some(c => c.method === 'PUT'));
});

test('25 — save is disabled with no changes and enabled once something differs', async () => {
  const { el } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  assert.equal(saveBtn(el).disabled, true, 'nothing to save yet');
  assert.match(el.querySelector('#pm-dirty').textContent, /No unsaved changes/);

  permFor(el, 'public_content.edit').check(true);
  assert.equal(saveBtn(el).disabled, false);
  assert.match(el.querySelector('#pm-dirty').textContent, /Unsaved changes/);

  permFor(el, 'public_content.edit').check(false);   // back to the loaded set
  assert.equal(saveBtn(el).disabled, true, 'reverting by hand clears the dirty state');
});

test('11/12 — the PUT body is the whole intended set, in registry order, with no duplicates', async () => {
  const { el, calls } = await renderPage({
    'PUT /admin/account-permissions/users/u_1': async () => ({
      status: 200,
      body: payload({ activePermissions: ['public_content.view', 'public_content.edit'], concurrencyToken: 'perms:u_1:v2', granted: ['public_content.edit'] }),
    }),
  }, { hash: '#/account-permissions/u_1' });

  permFor(el, 'public_content.edit').check(true);
  permFor(el, 'public_content.edit').check(true);
  el.querySelector('#pm-form').submit();
  await settle();

  const put = calls.find(c => c.method === 'PUT');
  assert.ok(put, 'a save must have been sent');
  assert.deepEqual(put.body.permissions, ['public_content.view', 'public_content.edit']);
  assert.equal(new Set(put.body.permissions).size, put.body.permissions.length, 'no duplicates');
});

test('a revocation sends the set WITHOUT the key rather than a delete', async () => {
  const { el, calls } = await renderPage({
    'PUT /admin/account-permissions/users/u_1': async () => ({
      status: 200, body: payload({ activePermissions: [], concurrencyToken: 'perms:u_1:v2', revoked: ['public_content.view'] }),
    }),
  }, { hash: '#/account-permissions/u_1' });

  permFor(el, 'public_content.view').check(false);
  el.querySelector('#pm-form').submit();
  await settle();

  const put = calls.find(c => c.method === 'PUT');
  assert.deepEqual(put.body.permissions, []);
  assert.ok(!calls.some(c => c.method === 'DELETE'), 'the UI must never issue a DELETE');
});

// ---------------------------------------------------------------------------
// 14/15/16 — concurrency
// ---------------------------------------------------------------------------

test('14/15 — the token is sent and the returned token replaces it', async () => {
  const { el, calls } = await renderPage({
    'PUT /admin/account-permissions/users/u_1': async () => ({
      status: 200, body: payload({ activePermissions: ['public_content.view', 'public_content.edit'], concurrencyToken: 'perms:u_1:v2', granted: ['public_content.edit'] }),
    }),
  }, { hash: '#/account-permissions/u_1' });

  permFor(el, 'public_content.edit').check(true);
  el.querySelector('#pm-form').submit();
  await settle();
  assert.equal(calls.find(c => c.method === 'PUT').body.concurrencyToken, 'perms:u_1:v1');

  // A second save must carry the NEW token, never the spent one.
  permFor(el, 'permissions.manage').check(true);
  el.querySelector('#pm-form').submit();
  await settle();
  const puts = calls.filter(c => c.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.equal(puts[1].body.concurrencyToken, 'perms:u_1:v2', 'the refreshed token must be used');
});

test('16 — switching accounts never reuses the previous account’s token', async () => {
  const u2 = payload({
    user: { id: 'u_2', displayName: 'Sam Publisher', role: 'admin', status: 'active' },
    permissions: [], activePermissions: [], concurrencyToken: 'perms:u_2:v9',
  });
  const { el, sandbox, calls } = await renderPage({
    'GET /admin/account-permissions/users/u_2': async () => ({ status: 200, body: u2 }),
    'PUT /admin/account-permissions/users/u_2': async () => ({
      status: 200, body: { ...u2, activePermissions: ['public_content.view'], concurrencyToken: 'perms:u_2:v10', granted: ['public_content.view'], revoked: [] },
    }),
  }, { hash: '#/account-permissions/u_1' });

  // Switch to u_2 (no unsaved edits, so no confirmation is needed).
  el.querySelector('[data-pick="u_2"]').click();
  sandbox.App.routes['account-permissions'](el, ['u_2']);
  await settle();

  permFor(el, 'public_content.view').check(true);
  el.querySelector('#pm-form').submit();
  await settle();

  const put = calls.find(c => c.method === 'PUT');
  assert.equal(put.path, '/admin/account-permissions/users/u_2');
  assert.equal(put.body.concurrencyToken, 'perms:u_2:v9',
    'a token is bound to the account it was issued for');
});

// ---------------------------------------------------------------------------
// 17/18/19/20/21/22/23 — error handling
// ---------------------------------------------------------------------------

async function saveWith(status, body){
  const ctx = await renderPage({
    'PUT /admin/account-permissions/users/u_1': async () => ({ status, body }),
  }, { hash: '#/account-permissions/u_1' });
  permFor(ctx.el, 'public_content.edit').check(true);
  ctx.el.querySelector('#pm-form').submit();
  await settle();
  return ctx;
}

test('17 — a stale-token 409 never reports success and offers a reload', async () => {
  const { el } = await saveWith(409, { error: 'stale', code: 'STALE_TOKEN' });
  assert.match(el.textContent, /Another administrator changed/);
  assert.doesNotMatch(el.textContent, /Permissions saved/, 'a refused save must never read as success');
  assert.ok(el.querySelector('[data-reload]'), 'a reload action must be offered');
  assert.match(el.querySelector('#pm-dirty').textContent, /Unsaved changes/,
    'the local edit must be preserved and still flagged unsaved');
});

test('18 — reloading after a 409 retrieves the current stored state', async () => {
  let version = 1;
  const ctx = await renderPage({
    'PUT /admin/account-permissions/users/u_1': async () => ({ status: 409, body: { code: 'STALE_TOKEN' } }),
    'GET /admin/account-permissions/users/u_1': async () => ({
      status: 200,
      body: payload(version++ === 1
        ? {}
        : { activePermissions: ['public_content.view', 'permissions.manage'], concurrencyToken: 'perms:u_1:v7' }),
    }),
  }, { hash: '#/account-permissions/u_1' });

  permFor(ctx.el, 'public_content.edit').check(true);
  ctx.el.querySelector('#pm-form').submit();
  await settle();

  ctx.el.querySelector('[data-reload]').click();
  await settle();

  assert.equal(permFor(ctx.el, 'permissions.manage').checked, true,
    'the other administrator’s change is now visible');
  assert.equal(permFor(ctx.el, 'public_content.edit').checked, false,
    'the discarded local edit is gone after an explicit reload');
});

test('19 — a final-manager 422 explains the lockout protection and claims nothing', async () => {
  const { el } = await saveWith(422, { code: 'LAST_PERMISSION_MANAGER' });
  assert.match(el.textContent, /last account able to manage permissions/i);
  assert.match(el.textContent, /Nothing was changed/);
  assert.doesNotMatch(el.textContent, /Permissions saved/);
});

test('20 — a 401 explains the session, not the endpoint', async () => {
  const { el } = await saveWith(401, {});
  assert.match(el.textContent, /session has expired/i);
});

test('21 — a 403 explains the missing capability', async () => {
  const { el } = await saveWith(403, {});
  assert.match(el.textContent, /does not have permission/i);
});

test('22 — a 404 explains that the account is gone', async () => {
  const { el } = await saveWith(404, {});
  assert.match(el.textContent, /no longer exists/i);
});

test('23 — a generic failure leaks no API detail, stack or infrastructure hint', async () => {
  const { el } = await saveWith(500, {
    error: 'select * from account_permissions failed: connection to 10.0.0.4:5432 refused',
    stack: 'at Object.query (/srv/api/src/db.js:14:9)',
  });
  const shown = el.textContent;
  assert.match(shown, /could not be saved/i);
  for (const leak of ['select', 'account_permissions', '10.0.0.4', '5432', 'db.js', 'at Object']) {
    assert.ok(!shown.includes(leak), `leaked "${leak}" to the operator`);
  }
});

test('a failed save leaves the saved state untouched and the edit still pending', async () => {
  const { el } = await saveWith(500, { error: 'boom' });
  assert.equal(permFor(el, 'public_content.edit').checked, true, 'the attempted change is kept');
  assert.equal(saveBtn(el).disabled, false, 'the operator can try again deliberately');
});

// ---------------------------------------------------------------------------
// 26 — unsaved-change guard, and reset
// ---------------------------------------------------------------------------

test('26 — switching accounts with unsaved edits asks before discarding', async () => {
  const { el, sandbox } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  permFor(el, 'public_content.edit').check(true);

  el.querySelector('[data-pick="u_2"]').click();

  const modal = sandbox.document.getElementById('modal-root');
  assert.match(modal.textContent, /unsaved permission changes/i);
  assert.equal(sandbox.location.hash, '#/account-permissions/u_1', 'navigation is held until confirmed');

  modal.querySelector('[data-yes]').click();
  assert.equal(sandbox.location.hash, '#/account-permissions/u_2', 'confirming proceeds');
});

test('switching accounts with no unsaved edits does not interrupt', async () => {
  const { el, sandbox } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  el.querySelector('[data-pick="u_2"]').click();
  assert.equal(sandbox.document.getElementById('modal-root').textContent, '');
  assert.equal(sandbox.location.hash, '#/account-permissions/u_2');
});

test('reset restores the last saved set and clears the dirty flag', async () => {
  const { el } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  permFor(el, 'public_content.edit').check(true);
  permFor(el, 'public_content.view').check(false);
  assert.equal(saveBtn(el).disabled, false);

  el.querySelector('[data-reset]').click();
  assert.equal(permFor(el, 'public_content.edit').checked, false);
  assert.equal(permFor(el, 'public_content.view').checked, true);
  assert.equal(saveBtn(el).disabled, true);
});

// ---------------------------------------------------------------------------
// accessibility / UX
// ---------------------------------------------------------------------------

test('every capability checkbox has an explicit label bound to it', async () => {
  const { el } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  for (const box of perms(el)) {
    assert.ok(box.id, 'a checkbox needs an id to be labelled');
    const label = el.querySelector(`label[for="${box.id}"]`);
    assert.ok(label, `no <label for="${box.id}">`);
    assert.ok(label.textContent.trim().length > 3, 'the label must carry real text');
  }
});

test('the account picker is a real button, so it is keyboard operable', async () => {
  const { el } = await renderPage();
  for (const b of el.querySelectorAll('[data-pick]')) assert.equal(b.tagName, 'BUTTON');
});

test('the dirty indicator is announced as a live status region', async () => {
  const { el } = await renderPage({}, { hash: '#/account-permissions/u_1' });
  const status = el.querySelector('#pm-dirty');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
});

test('a disabled target account is flagged and still editable', async () => {
  const { el } = await renderPage({
    'GET /admin/account-permissions/users/u_1': async () => ({
      status: 200,
      body: payload({ user: { id: 'u_1', displayName: 'Dana Disabled', role: 'agent', status: 'pending' } }),
    }),
  }, { hash: '#/account-permissions/u_1' });

  assert.match(el.textContent, /not active/i);
  assert.equal(perms(el).length, 4, 'permissions remain editable so they can be revoked');
});
