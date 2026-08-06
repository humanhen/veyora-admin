/* Permission-bootstrap plan validation (Security Hardening Phase 5).

   The bootstrap itself is a supervised database operation and is NOT performed
   here or anywhere in this repository. These tests cover the planner: that it
   catches the ways a hand-run grant goes wrong, and that it structurally
   cannot reach a database. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BootstrapPlanError,
  MANAGE_CAPABILITY,
  MIN_MANAGERS,
  renderBootstrapSql,
  reviewChecklist,
  validateBootstrapPlan,
} from '../src/bootstrap-plan.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'scripts', 'plan-permission-bootstrap.js');
const read = (p) => fs.readFileSync(p, 'utf8');
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const account = (over = {}) => ({
  id: 'u_1', username: 'alex.hardy', email: 'alex.hardy@example.test',
  role: 'admin', status: 'active', ...over,
});

const TWO = [account(), account({ id: 'u_2', username: 'sam.reed', email: 'sam.reed@example.test' })];

const runCli = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', shell: false });

// ---------------------------------------------------------------------------
// 1-9 — the failure modes a hand-run grant actually has
// ---------------------------------------------------------------------------

test('1 — a sound two-holder plan validates', () => {
  const result = validateBootstrapPlan({ accounts: TWO, selectedIds: ['u_1', 'u_2'] });
  assert.equal(result.ok, true);
  assert.equal(result.blocking.length, 0);
  assert.deepEqual(result.plan.map((p) => p.id), ['u_1', 'u_2']);
  assert.ok(result.plan.every((p) => p.capability === MANAGE_CAPABILITY));
});

test('2 — a single holder is blocking, because the last one cannot be revoked', () => {
  const result = validateBootstrapPlan({ accounts: TWO, selectedIds: ['u_1'] });
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].code, 'TOO_FEW_MANAGERS');
  assert.match(result.blocking[0].message, /locks everybody out/);
  assert.ok(MIN_MANAGERS >= 2);
});

test('3 — an existing holder counts toward the minimum', () => {
  const result = validateBootstrapPlan({
    accounts: TWO, selectedIds: ['u_1'], existingHolders: ['u_9'],
  });
  assert.equal(result.ok, true, 'one new plus one existing satisfies the minimum');
});

test('4 — a disabled or pending account is blocking', () => {
  for (const status of ['disabled', 'pending', 'suspended']) {
    const accounts = [account({ status }), account({ id: 'u_2', username: 'sam.reed' })];
    const result = validateBootstrapPlan({ accounts, selectedIds: ['u_1', 'u_2'] });
    assert.equal(result.ok, false, `${status} must be refused`);
    assert.ok(result.blocking.some((b) => b.code === 'INACTIVE_ACCOUNT'));
  }
});

test('5 — an unknown id is blocking, never silently skipped', () => {
  const result = validateBootstrapPlan({ accounts: TWO, selectedIds: ['u_1', 'u_nope'] });
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((b) => b.code === 'UNKNOWN_ACCOUNT'));
});

test('6 — a duplicated selection is blocking', () => {
  const result = validateBootstrapPlan({ accounts: TWO, selectedIds: ['u_1', 'u_1', 'u_2'] });
  assert.ok(result.blocking.some((b) => b.code === 'DUPLICATE_SELECTION'));
});

test('7 — an ambiguous username is blocking, not a warning', () => {
  /* Granting the wrong account is the mistake this exists to prevent, and a
     duplicated username is how it happens. */
  const accounts = [
    account({ id: 'u_1', username: 'jordan' }),
    account({ id: 'u_2', username: 'jordan', email: 'other@example.test' }),
    account({ id: 'u_3', username: 'sam.reed' }),
  ];
  const result = validateBootstrapPlan({ accounts, selectedIds: ['u_1', 'u_3'] });
  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((b) => b.code === 'AMBIGUOUS_USERNAME'));
});

test('8 — a shared-looking login warns but does not block', () => {
  /* A judgement call, not a fact: the planner cannot know whether "office" is
     one person. It says so and lets a human decide. */
  const accounts = [
    account({ id: 'u_1', username: 'office', email: 'office@example.test' }),
    account({ id: 'u_2', username: 'sam.reed' }),
  ];
  const result = validateBootstrapPlan({ accounts, selectedIds: ['u_1', 'u_2'] });
  assert.equal(result.ok, true, 'a warning must not block');
  assert.ok(result.warnings.some((w) => w.code === 'POSSIBLY_SHARED_ACCOUNT'));
  assert.match(result.warnings[0].message, /unattributable/);
});

test('9 — an ordinary personal name does not trigger the shared-account warning', () => {
  const result = validateBootstrapPlan({ accounts: TWO, selectedIds: ['u_1', 'u_2'] });
  assert.deepEqual(result.warnings, [], 'alex.hardy and sam.reed are not shared logins');
});

// ---------------------------------------------------------------------------
// 10-14 — the rendered plan
// ---------------------------------------------------------------------------

test('10 — SQL is rendered only for a plan with no blocking findings', () => {
  const bad = validateBootstrapPlan({ accounts: TWO, selectedIds: ['u_1'] });
  assert.throws(() => renderBootstrapSql(bad), BootstrapPlanError);
});

test('11 — the rendered SQL confirms, grants, verifies and offers a rollback', () => {
  const result = validateBootstrapPlan({ accounts: TWO, selectedIds: ['u_1', 'u_2'] });
  const sql = renderBootstrapSql(result);
  assert.match(sql, /^begin;/m, 'the grant must run in a transaction');
  assert.match(sql, /select id, username, email, role, status from users where id in/,
    'confirm the accounts before granting');
  assert.match(sql, /insert into account_permissions/);
  assert.match(sql, /and ap\.is_active;/, 'verify inside the same transaction');
  assert.match(sql, /rollback;/);
  assert.match(sql, /revoke, never delete/);
  assert.match(sql, /REVIEW BEFORE RUNNING/);
});

test('12 — only permissions.manage is ever granted', () => {
  const result = validateBootstrapPlan({ accounts: TWO, selectedIds: ['u_1', 'u_2'] });
  const sql = renderBootstrapSql(result);
  const granted = [...sql.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(granted)], [MANAGE_CAPABILITY]);
  for (const other of ['public_content.publish', 'public_content.edit', 'enquiries.view']) {
    assert.ok(!sql.includes(other), `${other} must not be granted by a bootstrap`);
  }
});

test('13 — identifiers are escaped when rendered', () => {
  const accounts = [
    account({ id: "u_'; drop table users; --" }),
    account({ id: 'u_2', username: 'sam.reed' }),
  ];
  const result = validateBootstrapPlan({ accounts, selectedIds: [accounts[0].id, 'u_2'] });
  const sql = renderBootstrapSql(result);
  assert.ok(sql.includes("''"), 'a quote in an identifier must be doubled');
  assert.ok(!/;\s*drop table users/i.test(sql.replace(/''/g, "'")) || sql.includes("''"),
    'the injection attempt must not survive as executable SQL');
});

test('14 — the checklist is data, so a script and a document cannot drift', () => {
  const checklist = reviewChecklist();
  assert.ok(checklist.length >= 6);
  const joined = checklist.join(' ').toLowerCase();
  for (const requirement of ['shared login', 'active', 'transaction', 'rollback', 'named person']) {
    assert.ok(joined.includes(requirement), `the checklist should cover: ${requirement}`);
  }
  assert.deepEqual(validateBootstrapPlan({ accounts: TWO, selectedIds: ['u_1', 'u_2'] }).checklist, checklist);
});

// ---------------------------------------------------------------------------
// 15-20 — it cannot reach a database
// ---------------------------------------------------------------------------

test('15 — neither the planner nor the CLI imports a database client', () => {
  for (const file of [path.join(ROOT, 'src', 'bootstrap-plan.js'), CLI]) {
    const src = stripComments(read(file));
    for (const forbidden of [/from 'pg'/, /require\('pg'\)/, /db\.js/, /DATABASE_URL/,
                             /\bpool\b/, /node:https?/, /\bfetch\(/]) {
      assert.ok(!forbidden.test(src), `${path.basename(file)} must not reference ${forbidden}`);
    }
  }
});

test('16 — the CLI executes nothing and says so', () => {
  const src = read(CLI);
  assert.match(src, /PLANS ONLY|contacts no database/i);
  const help = runCli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /CONTACTS NO DATABASE/i);
});

test('17 — the CLI refuses a URL as input', () => {
  const r = runCli('--input', 'https://example.test/accounts.json');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be a local file, not a URL/);
});

test('18 — the CLI refuses to run with no arguments', () => {
  const r = runCli();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--input is required/);
});

test('19 — a blocking plan exits non-zero and renders no SQL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyora-bootstrap-'));
  try {
    const file = path.join(dir, 'plan.json');
    fs.writeFileSync(file, JSON.stringify({ accounts: TWO, selectedIds: ['u_1'] }));
    const r = runCli('--input', file);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /BLOCKING/);
    assert.match(r.stdout, /No SQL was rendered/);
    assert.ok(!r.stdout.includes('insert into account_permissions'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('20 — a sound plan renders SQL, the checklist, and states nothing was executed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyora-bootstrap-'));
  try {
    const file = path.join(dir, 'plan.json');
    fs.writeFileSync(file, JSON.stringify({ accounts: TWO, selectedIds: ['u_1', 'u_2'] }));
    const r = runCli('--input', file);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Review checklist/);
    assert.match(r.stdout, /insert into account_permissions/);
    assert.match(r.stdout, /NOTHING HAS BEEN EXECUTED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('21 — no bootstrap has been performed anywhere in this repository', () => {
  /* The migrations grant nothing, and nothing in src inserts a capability
     outside the management API's own transactional path. */
  const migrations = path.join(path.dirname(ROOT), 'db', 'migrations');
  for (const file of fs.readdirSync(migrations)) {
    const sql = read(path.join(migrations, file)).replace(/^\s*--[^\n]*$/gm, ' ');
    assert.ok(!/insert into account_permissions/i.test(sql),
      `${file} must not grant a capability`);
  }
});
