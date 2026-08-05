/* Admin shell regression cover for B2.4B1.

   The admin panel had no test suite before this batch, so there is no
   pre-existing green suite to keep green. These tests pin the shell
   behaviours B2.4B1 actually touched — script loading, the nav filter and the
   route table — so the change is shown not to have disturbed the panel around
   it, and pin the batch's protected-path boundary. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadAdmin, ROOT } = require('./helpers/dom.js');

const SHIPPED = ['index.html', 'css', 'js', 'assets'];
const PAGE_FILES = ['js/pages_core.js', 'js/pages_sales.js', 'js/pages_customers.js',
  'js/pages_catalog.js', 'js/pages_finance.js', 'js/pages_ops.js', 'js/pages_permissions.js',
  'js/pages_public_content.js'];
const ALL = ['js/util.js', 'js/data.js', 'js/app.js', ...PAGE_FILES];

// ---------------------------------------------------------------------------
// the panel still loads as a whole
// ---------------------------------------------------------------------------

test('28 — every admin script parses and the whole panel evaluates together', () => {
  for (const f of ALL) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)]);
  }
  const sandbox = loadAdmin(ALL);
  assert.equal(typeof sandbox.App, 'object');
  assert.equal(typeof sandbox.DB, 'object');
});

test('28 — every pre-existing route still registers alongside the new one', () => {
  const sandbox = loadAdmin(ALL);
  const routes = Object.keys(sandbox.App.routes);
  for (const r of ['dashboard', 'tasks', 'orders', 'users', 'products', 'inventory',
                   'payments', 'invoices', 'shipping', 'audit', 'leads', 'promotions']) {
    assert.ok(routes.includes(r), `route ${r} disappeared`);
  }
  assert.ok(routes.includes('account-permissions'), 'the account-permissions route must be registered');
  assert.ok(routes.includes('public-content'), 'the public-content route must be registered');
});

test('index.html loads the new page script alongside the existing ones, in order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
  assert.deepEqual(srcs, ALL, 'script order defines global availability — util, data, app, then pages');
});

// ---------------------------------------------------------------------------
// the nav filter only affects entries that ask for a capability
// ---------------------------------------------------------------------------

test('the capability filter leaves every unrestricted nav entry untouched', () => {
  const sandbox = loadAdmin(ALL);
  sandbox.localStorage.setItem('veyora_session', JSON.stringify({ id: 'u', name: 'A', role: 'admin' }));
  sandbox.App.ready = true;
  sandbox.App.caps = new Set();          // holds nothing
  sandbox.App.renderNav();

  const nav = sandbox.document.getElementById('side-nav');
  const expected = sandbox.NAV.filter(n => n.route && !n.requires).map(n => n.route);
  for (const r of expected) {
    assert.ok(nav.querySelector(`[href="#/${r}"]`), `top-level entry ${r} vanished`);
  }
  for (const group of sandbox.NAV.filter(n => n.group)) {
    assert.ok(nav.querySelector(`[data-group="${group.group}"]`), `group ${group.group} vanished`);
    for (const item of group.items) {
      assert.ok(nav.querySelector(`[href="#/${item.route}"]`), `grouped entry ${item.route} vanished`);
    }
  }
});

test('only the governance entries are capability gated, and each names a real capability', () => {
  const sandbox = loadAdmin(['js/util.js', 'js/data.js', 'js/app.js']);
  const gated = [];
  for (const n of sandbox.NAV) {
    if (n.requires) gated.push([n.route, n.requires]);
    (n.items || []).forEach(i => { if (i.requires) gated.push([i.route, i.requires]); });
  }
  assert.deepEqual(gated.sort(), [
    ['account-permissions', 'permissions.manage'],
    ['public-content', 'public_content.view'],
  ]);
});

// ---------------------------------------------------------------------------
// 29 — the batch's boundary
// ---------------------------------------------------------------------------

const changedFiles = () => execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map(l => l.slice(3).trim()).filter(Boolean);

test('30 — no database, storefront or deployment file was modified', () => {
  const changed = changedFiles();
  assert.ok(changed.length, 'expected uncommitted or recent changes to inspect');

  /* The paths that must never move regardless of which workstream is running:
     migrations and the schema, the storefront, deployment configuration, and
     the two API modules that define the PUBLIC read contract — migrate.js and
     routes/public.js. A change to any of them from the admin frontend's own
     work would be out of bounds.

     `platform/server/web/**` was on this list when it was written (B2.4B2A
     touched only the admin panel). It is not protected in general — the Astro
     site is a separately-worked application with its own suite, and the
     fast-track workstream legitimately owns it. Guarding it here would assert
     a boundary this repository does not actually have. */
  const PROTECTED = [
    /^platform\/server\/db\//, /^platform\/server\/storefront\//,
    /^platform\/server\/docker-compose\.yml$/, /^platform\/server\/Caddyfile$/,
    /^platform\/server\/deploy\.sh$/, /\.env/,
    /^platform\/server\/api\/src\/migrate\.js$/,
    /^platform\/server\/api\/src\/routes\/public\.js$/,
  ];
  for (const file of changed) {
    for (const p of PROTECTED) {
      assert.ok(!p.test(file), `protected path modified: ${file}`);
    }
  }
});

test('every change is inside a working area of this repository, never a protected one', () => {
  /* Deliberately a broad allowlist rather than a per-batch one. A per-batch
     list has to be edited by every subsequent batch, which turns a boundary
     check into a maintenance chore that gets widened reflexively — the
     opposite of a guard. The narrow, genuinely-protected paths are asserted
     by the test above; this one only catches a change landing somewhere the
     project does not work at all. */
  const WORKING_AREAS = [
    'index.html', 'css/', 'js/', 'assets/',        // the deployed admin panel
    'test/',                                        // its suite (never deployed)
    'platform/server/api/',                         // the API and its tests
    'platform/server/web/',                         // the Astro public site
    'docs/',
  ];
  const allowed = (f) => WORKING_AREAS.some((area) => f === area || f.startsWith(area));
  for (const file of changedFiles()) {
    assert.ok(allowed(file), `change outside every known working area: ${file}`);
  }
});

test('the public read-only API surface is untouched', () => {
  /* The whole point of the admin editor is that it never widens what the
     public site can read. routes/public.js is protected, and asserted
     unmodified rather than merely assumed. */
  for (const f of changedFiles()) {
    assert.notEqual(f, 'platform/server/api/src/routes/public.js');
    assert.notEqual(f, 'platform/server/api/src/public-serialize.js');
  }
});

test('the test suite is not part of the deployed admin panel', () => {
  /* deploy.sh ships exactly `index.html css js assets`. Tests live in test/,
     so they are never uploaded — asserted here because moving them under js/
     would silently start deploying them. */
  const deploy = fs.readFileSync(path.join(ROOT, 'platform', 'server', 'deploy.sh'), 'utf8');
  assert.match(deploy, /tar czf - index\.html css js assets/);
  assert.ok(fs.existsSync(path.join(ROOT, 'test')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'js', 'test')));
});

// ---------------------------------------------------------------------------
// hygiene across the changed frontend files
// ---------------------------------------------------------------------------

test('the changed frontend files carry no hard-coded identity, secret or host', () => {
  /* Comments are stripped so an explanatory sentence cannot fail its own
     check, and `placeholder="you@example.com"` is stripped because form hint
     text is display copy, not an identity anything is compared against. */
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/placeholder="[^"]*"/g, 'placeholder=""');
  for (const f of ['js/data.js', 'js/app.js', 'js/pages_permissions.js', 'js/pages_public_content.js']) {
    const code = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.doesNotMatch(code, /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i, `${f} contains a hard-coded email`);
    assert.doesNotMatch(code, /\b\d{1,3}(\.\d{1,3}){3}\b/, `${f} contains an IP address`);
    assert.doesNotMatch(code, /veyora\.(design|com|net)/i, `${f} contains a production hostname`);
    assert.doesNotMatch(code, /u_[0-9a-f]{6,}/i, `${f} contains a hard-coded account id`);
    assert.doesNotMatch(code, /TODO|FIXME|XXX|HACK/, `${f} contains an unfinished marker`);
    assert.doesNotMatch(code, /<<<<<<<|>>>>>>>/, `${f} contains a merge marker`);
    assert.doesNotMatch(code, /api[_-]?key|secret\s*[:=]|password\s*[:=]\s*['"]/i, `${f} may contain a secret`);
  }
});
