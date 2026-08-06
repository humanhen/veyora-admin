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
  'js/pages_public_content.js', 'js/pages_enquiries.js'];
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
    ['enquiries', 'enquiries.view'],
    ['public-content', 'public_content.view'],
  ]);
});

// ---------------------------------------------------------------------------
// 29 — the batch's boundary
// ---------------------------------------------------------------------------

const changedFiles = () => execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map(l => l.slice(3).trim()).filter(Boolean);

test('30 — the live routing, the storefront and any real secret file stay untouched', () => {
  /* A clean tree is a valid state — it is what a checkpoint commit leaves
     behind — so there is nothing to inspect rather than something wrong. */
  const changed = changedFiles();
  if (!changed.length) return;

  /* This list was originally the admin-frontend batch's own boundary and named
     migrations, `migrate.js`, `docker-compose.yml` and `deploy.sh`. The
     fast-track release workstream legitimately owns all four — it is the
     workstream that makes the public site deployable and adds the schema the
     enquiry operations need — so guarding them here would assert a boundary
     this repository no longer has, and would be widened reflexively until it
     meant nothing.

     What remains genuinely protected, in every workstream:

       - `Caddyfile`, the LIVE public routing. `deploy.sh` ships it and
         immediately brings the stack up, so editing it in place arms the
         catch-all cutover (risks R-01/R-02) on the next deploy by anyone. The
         release-candidate topology ships beside it as `Caddyfile.rc` and is
         selected by one deliberate line on the server.
       - the storefront, which another developer is working on.
       - any real `.env`. `.env.example` is documentation and is exempt by
         name — it carries `example.test` placeholders and no secret. */
  const PROTECTED = [
    /^platform\/server\/storefront\//,
    /^platform\/server\/Caddyfile$/,
    /(^|\/)\.env($|\.[^/]*$)/,
  ];
  const EXEMPT = [/(^|\/)\.env\.example$/];
  for (const file of changed) {
    if (EXEMPT.some((e) => e.test(file))) continue;
    for (const p of PROTECTED) {
      assert.ok(!p.test(file), `protected path modified: ${file}`);
    }
  }
});

test('30 — any migration this change adds is additive, never destructive', () => {
  /* The replacement for "no migration may be touched". Migrations are allowed;
     a migration that could lose data is not. Every statement is checked, with
     comments stripped — several of them explain what is deliberately NOT done
     and would otherwise match. Constraint drops are permitted because widening
     a CHECK requires one, and they move no data. */
  const migrations = changedFiles().filter((f) => /^platform\/server\/db\/migrations\/.*\.sql$/.test(f));
  for (const file of migrations) {
    const sql = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\s*--[^\n]*$/gm, ' ');
    for (const destructive of [/drop\s+table/i, /drop\s+column/i, /alter\s+column/i,
                               /truncate/i, /delete\s+from/i, /drop\s+database/i]) {
      assert.ok(!destructive.test(sql), `${file} contains a destructive statement: ${destructive}`);
    }
    for (const match of sql.match(/drop constraint[^\n;]*/gi) ?? []) {
      assert.match(match, /if exists/i, `${file} has an unguarded constraint drop: ${match}`);
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
    'platform/server/db/',                          // schema migrations
    'platform/server/docker-compose.yml',           // deployment topology
    'platform/server/Caddyfile.rc',                 // the RC routing, not the live one
    'platform/server/deploy.sh',
    'platform/server/.env.example',
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
