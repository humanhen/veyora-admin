/* Permission API client and navigation access (B2.4B1).

   Drives the REAL js/data.js and js/app.js in a sandbox with a stubbed fetch,
   so what is asserted is the request the panel actually sends and the state it
   actually derives — not the shape of the source. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAdmin } = require('./helpers/dom.js');

const FILES = ['js/util.js', 'js/data.js', 'js/app.js', 'js/pages_permissions.js'];

const REGISTRY = [
  { key: 'public_content.view', label: 'View public content administration', description: 'Read.' },
  { key: 'public_content.edit', label: 'Edit public content', description: 'Edit.' },
  { key: 'public_content.publish', label: 'Publish and unpublish public content', description: 'Publish.' },
  { key: 'permissions.manage', label: 'Manage account permissions', description: 'Grant.' },
];

/** Sandbox with a recording fetch. `routes` maps 'METHOD /path' → responder. */
function makeApp(routes = {}){
  const sandbox = loadAdmin(FILES);
  const calls = [];
  sandbox.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const path = String(url).replace(/^\/api/, '');
    calls.push({ method, url: String(url), path, body: opts.body ? JSON.parse(opts.body) : null, opts });
    const responder = routes[`${method} ${path}`] || routes[`${method} *`];
    const r = responder ? await responder() : { status: 404, body: { error: 'not found' } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  return { sandbox, calls };
}

const ok = (body) => async () => ({ status: 200, body });
const fail = (status, body = {}) => async () => ({ status, body });

const permissionsPayload = (over = {}) => ({
  user: { id: 'u_1', displayName: 'Alex Editor', role: 'customer', status: 'active' },
  permissions: [
    { permissionKey: 'public_content.view', isActive: true, grantedBy: 'u_m', grantedAt: '2026-08-01T00:00:00.000Z', revokedBy: null, revokedAt: null },
  ],
  activePermissions: ['public_content.view'],
  concurrencyToken: 'perms:u_1:v1',
  ...over,
});

// ---------------------------------------------------------------------------
// client shape and paths
// ---------------------------------------------------------------------------

test('the registry call hits the fixed B2.4P path through the authenticated client', async () => {
  const { sandbox, calls } = makeApp({ 'GET /admin/account-permissions/registry': ok({ permissions: REGISTRY }) });
  const out = await sandbox.DB.permissionRegistry();

  assert.equal(calls[0].url, '/api/admin/account-permissions/registry');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].opts.credentials, 'same-origin');
  assert.deepEqual(out.map(p => p.key), REGISTRY.map(p => p.key));
});

test('4 — the registry yields exactly four capabilities and no wildcard', async () => {
  const { sandbox } = makeApp({ 'GET /admin/account-permissions/registry': ok({ permissions: REGISTRY }) });
  const out = await sandbox.DB.permissionRegistry();
  assert.equal(out.length, 4);
  for (const p of out) {
    assert.ok(!p.key.includes('*'), 'a wildcard key must never reach the UI');
    assert.match(p.key, /^(public_content\.(view|edit|publish)|permissions\.manage)$/);
  }
});

test('responses are shaped by an explicit allowlist, never spread', async () => {
  const { sandbox } = makeApp({
    'GET /admin/account-permissions/users/u_1': ok(permissionsPayload({
      // Fields the API does not return today; if one ever appeared it must not
      // reach the screen just because it was in the response.
      user: { id: 'u_1', displayName: 'Alex', role: 'customer', status: 'active', email: 'a@b.test', balance: 999 },
      secretField: 'nope',
    })),
  });
  const res = await sandbox.DB.accountPermissions('u_1');

  assert.deepEqual(Object.keys(res.user).sort(), ['displayName', 'id', 'role', 'status']);
  assert.equal(res.secretField, undefined);
  const json = JSON.stringify(res);
  assert.ok(!json.includes('a@b.test'));
  assert.ok(!json.includes('999'));
});

test('a user id is URL-encoded rather than interpolated raw', async () => {
  const { sandbox, calls } = makeApp({ 'GET *': ok(permissionsPayload()) });
  await sandbox.DB.accountPermissions('u/1 ?x=1');
  assert.ok(calls[0].url.includes(encodeURIComponent('u/1 ?x=1')));
  assert.ok(!calls[0].url.includes('?x=1'), 'a crafted id must not become a query string');
});

// ---------------------------------------------------------------------------
// 11/12/13/14/15 — save payload
// ---------------------------------------------------------------------------

test('11/14 — save sends the complete intended active set plus the token', async () => {
  const { sandbox, calls } = makeApp({
    'PUT /admin/account-permissions/users/u_1': ok(permissionsPayload({
      activePermissions: ['public_content.view', 'public_content.edit'],
      concurrencyToken: 'perms:u_1:v2', granted: ['public_content.edit'], revoked: [],
    })),
  });
  await sandbox.DB.saveAccountPermissions('u_1', ['public_content.view', 'public_content.edit'], 'perms:u_1:v1');

  const put = calls[0];
  assert.equal(put.method, 'PUT');
  assert.deepEqual(put.body.permissions, ['public_content.view', 'public_content.edit']);
  assert.equal(put.body.concurrencyToken, 'perms:u_1:v1');
});

test('13 — the client cannot supply an actor, granted_by or revoked_by', async () => {
  const { sandbox, calls } = makeApp({ 'PUT *': ok(permissionsPayload({ granted: [], revoked: [] })) });
  await sandbox.DB.saveAccountPermissions('u_1', ['public_content.view'], 'perms:u_1:v1');

  const sent = Object.keys(calls[0].body).sort();
  assert.deepEqual(sent, ['concurrencyToken', 'permissions'],
    'the request body must carry nothing but the intended set and the token');
  const json = JSON.stringify(calls[0].body);
  for (const forbidden of ['grantedBy', 'granted_by', 'revokedBy', 'revoked_by', 'actor', 'userId', 'role']) {
    assert.ok(!json.includes(forbidden), `client must not send ${forbidden}`);
  }
});

test('the client never retries a mutation automatically', async () => {
  let attempts = 0;
  const { sandbox } = makeApp({ 'PUT *': async () => { attempts++; return { status: 500, body: {} }; } });
  await assert.rejects(() => sandbox.DB.saveAccountPermissions('u_1', [], 't'));
  assert.equal(attempts, 1, 'a failed mutation must be attempted exactly once');
});

// ---------------------------------------------------------------------------
// status distinction
// ---------------------------------------------------------------------------

test('401, 403, 404, 409, 422 and server failure are distinguishable to the caller', async () => {
  for (const status of [401, 403, 404, 409, 422, 500]) {
    const { sandbox } = makeApp({ 'PUT *': fail(status, { error: 'x', code: 'Y' }) });
    await assert.rejects(
      () => sandbox.DB.saveAccountPermissions('u_1', [], 't'),
      (e) => { assert.equal(e.status, status, `status ${status} must survive to the caller`); return true; }
    );
  }
});

// ---------------------------------------------------------------------------
// 1/2 — navigation access
// ---------------------------------------------------------------------------

test('1 — the nav entry is hidden when the account lacks permissions.manage', async () => {
  const { sandbox } = makeApp({ 'GET /admin/account-permissions/registry': fail(403, { error: 'forbidden' }) });
  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u_a', name: 'Admin', role: 'admin' }));

  await sandbox.App.loadCaps();
  assert.equal(sandbox.App.can('permissions.manage'), false);

  sandbox.App.ready = true;
  sandbox.App.renderNav();
  const nav = sandbox.document.getElementById('side-nav');
  assert.equal(nav.querySelector('[href="#/account-permissions"]'), null);
  assert.ok(nav.querySelector('[href="#/audit"]'), 'unrelated nav entries must still render');
});

test('2 — the nav entry appears after the registry probe succeeds', async () => {
  const { sandbox } = makeApp({ 'GET /admin/account-permissions/registry': ok({ permissions: REGISTRY }) });
  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u_m', name: 'Manager', role: 'admin' }));

  await sandbox.App.loadCaps();
  assert.equal(sandbox.App.can('permissions.manage'), true);

  sandbox.App.ready = true;
  sandbox.App.renderNav();
  const link = sandbox.document.getElementById('side-nav').querySelector('[href="#/account-permissions"]');
  assert.ok(link, 'the entry must be visible to a holder');
  assert.match(link.textContent, /Account Permissions/);
});

test('the admin role alone is never sufficient — no role bypass', async () => {
  const { sandbox, calls } = makeApp({ 'GET /admin/account-permissions/registry': fail(403, {}) });
  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u_a', name: 'Admin', role: 'admin' }));

  await sandbox.App.loadCaps();
  assert.equal(sandbox.App.can('permissions.manage'), false,
    'an admin without the grant must not be treated as a manager');

  /* Access is decided by asking the server, never by reading the role.
     loadCaps makes exactly three server calls and no more: the registry probe
     for permissions.manage (B2.4B1), the public-content capability read
     (B2.4B2A) and the enquiry capability read (WS2 Phase 2). Each is answered
     by the server; none consults the session's role, and none is inferred
     from another — a content capability says nothing about enquiry access. */
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'GET /admin/account-permissions/registry',
    'GET /admin/public-content/capabilities',
    'GET /admin/enquiries/capabilities',
  ]);
});

test('a probe that fails for any other reason also denies (fail closed)', async () => {
  for (const responder of [fail(500, {}), async () => { throw new Error('network down'); }]) {
    const { sandbox } = makeApp({ 'GET /admin/account-permissions/registry': responder });
    await sandbox.App.loadCaps();
    assert.equal(sandbox.App.can('permissions.manage'), false);
    assert.equal(sandbox.App.capsChecked, true);
  }
});

test('capabilities are dropped on logout so the next sign-in re-probes', async () => {
  const { sandbox } = makeApp({ 'GET /admin/account-permissions/registry': ok({ permissions: REGISTRY }) });
  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u_m', name: 'M', role: 'admin' }));
  await sandbox.App.loadCaps();
  assert.equal(sandbox.App.can('permissions.manage'), true);

  sandbox.App.ready = true;
  sandbox.App.renderNav();
  sandbox.document.getElementById('logout-btn').click();

  assert.equal(sandbox.App.caps, null);
  assert.equal(sandbox.App.capsChecked, false);
  assert.equal(sandbox.App.can('permissions.manage'), false);
});

test('27 — nothing in the frontend can bootstrap or grant itself a capability', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROOT } = require('./helpers/dom.js');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  for (const f of ['js/data.js', 'js/app.js', 'js/pages_permissions.js']) {
    const code = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.doesNotMatch(code, /insert\s+into|update\s+account_permissions|bootstrap/i, `${f} must contain no bootstrap path`);
    assert.doesNotMatch(code, /\bcaps\.add\(|can\s*\(\s*\)\s*\{\s*return\s+true/, `${f} must not self-grant`);
    assert.doesNotMatch(code, /role\s*===\s*['"]admin['"]|includes\(['"]admin['"]\)\s*&&/, `${f} must not use a role bypass`);
  }
});
