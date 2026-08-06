/* Server-derived admin action discovery (warehouse interface correction).

   The panel needed to know what a session may do, because POST /admin/sync
   became admin-only (finding SEC-002) and a warehouse login discovered that
   as a 403 on save. These tests cover the answer the server gives. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADMIN_ACTIONS, actionsForUser, describeAccess } from '../src/admin-access.js';
import { STOCK_ROLES } from '../src/routes/admin-inventory.js';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const code = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const admin = { id: 'u_a', role: 'admin', status: 'active' };
const warehouse = { id: 'u_w', role: 'warehouse', status: 'active' };

// ---------------------------------------------------------------------------
// 1-6 — the answer matches what the routes actually enforce
// ---------------------------------------------------------------------------

test('1 — an admin holds every action', () => {
  const actions = actionsForUser(admin);
  for (const key of ADMIN_ACTIONS) {
    assert.equal(actions[key], true, `admin should hold ${key}`);
  }
});

test('2 — warehouse does NOT hold sync.write', () => {
  /* The whole point. POST /admin/sync is admin-only since SEC-002, and this
     is how the panel learns that before it tries to save. */
  assert.equal(actionsForUser(warehouse)['sync.write'], false);
});

test('3 — warehouse holds exactly its four operational actions', () => {
  const actions = actionsForUser(warehouse);
  const held = Object.keys(actions).filter((k) => actions[k]);
  assert.deepEqual(held.sort(), [
    'backorders.convert', 'inventory.adjust', 'inventory.transfer', 'orders.fulfil',
  ]);
});

test('4 — warehouse holds no commercial or administrative action', () => {
  const actions = actionsForUser(warehouse);
  for (const key of ['sync.write', 'orders.money', 'users.manage', 'catalogue.edit',
                     'settings.edit', 'finance.manage', 'imports.run']) {
    assert.equal(actions[key], false, `warehouse must not hold ${key}`);
  }
});

test('5 — the inventory actions match the roles the inventory router admits', () => {
  /* If STOCK_ROLES ever changes, this discovery answer must change with it —
     otherwise the panel shows a control the API refuses, or hides one it
     allows. */
  for (const role of STOCK_ROLES) {
    const actions = actionsForUser({ id: 'u', role, status: 'active' });
    assert.equal(actions['inventory.adjust'], true, `${role} should hold inventory.adjust`);
    assert.equal(actions['inventory.transfer'], true, `${role} should hold inventory.transfer`);
  }
});

test('6 — order money is admin-only, matching isFinancialActor', () => {
  assert.equal(actionsForUser(warehouse)['orders.money'], false);
  assert.equal(actionsForUser(admin)['orders.money'], true);
  assert.match(code('routes/admin.js'), /patchTouchesMoney\(patch\) && !isFinancialActor\(req\.user\)/);
});

// ---------------------------------------------------------------------------
// 7-12 — it fails closed and grants nothing
// ---------------------------------------------------------------------------

test('7 — an unknown role holds nothing', () => {
  for (const role of ['customer', 'agent', 'super-agent', 'special customer', 'nonsense', '', null]) {
    const actions = actionsForUser({ id: 'u', role, status: 'active' });
    assert.ok(Object.values(actions).every((v) => v === false), `${role} must hold nothing`);
  }
});

test('8 — a non-active account holds nothing, whatever its role', () => {
  for (const status of ['disabled', 'pending', 'suspended', undefined]) {
    const actions = actionsForUser({ id: 'u', role: 'admin', status });
    assert.ok(Object.values(actions).every((v) => v === false),
      `an account with status "${status}" must hold nothing`);
  }
});

test('9 — a missing or malformed user holds nothing', () => {
  for (const user of [null, undefined, {}, 'admin', 42]) {
    const actions = actionsForUser(user);
    assert.ok(Object.values(actions).every((v) => v === false));
  }
});

test('10 — every action is an explicit boolean, so a missing key cannot read as allowed', () => {
  const actions = actionsForUser(warehouse);
  assert.deepEqual(Object.keys(actions).sort(), [...ADMIN_ACTIONS].sort());
  for (const value of Object.values(actions)) assert.equal(typeof value, 'boolean');
});

test('11 — the payload describes only the caller', () => {
  const described = describeAccess(warehouse);
  assert.deepEqual(Object.keys(described).sort(), ['actions', 'role']);
  assert.equal(described.role, 'warehouse');
  /* No user record, no other account, no capability grant attribution. */
  const json = JSON.stringify(described);
  assert.ok(!json.includes('u_w'), 'the account id must not be echoed');
  assert.ok(!json.includes('permissions.manage'));
});

test('12 — the endpoint reads nothing from the request but the session', () => {
  const src = code('routes/admin.js');
  assert.match(src, /r\.get\('\/access', \(req, res\) => res\.json\(describeAccess\(req\.user\)\)\)/);
  const module = code('admin-access.js');
  for (const forbidden of [/req\.body/, /req\.query/, /req\.headers/]) {
    assert.ok(!forbidden.test(module), `admin-access must not read ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// 13-15 — it grants nothing, and the backend restriction is untouched
// ---------------------------------------------------------------------------

test('13 — discovery performs no write of any kind', () => {
  const src = code('admin-access.js');
  for (const forbidden of [/insert into/i, /update /i, /delete from/i, /\bq\(/, /\bpool\b/, /db\.js/]) {
    assert.ok(!forbidden.test(src), `discovery must not ${forbidden}`);
  }
});

test('14 — the sync endpoint is still admin-only', () => {
  /* The correction must not have weakened what it exists to work around. */
  const src = code('routes/admin.js');
  const sync = src.slice(src.indexOf("r.post('/sync'"));
  assert.match(sync, /req\.user\.role !== 'admin'/);
  assert.match(sync, /ADMIN_ONLY/);
});

test('15 — the action list is frozen', () => {
  assert.throws(() => { 'use strict'; ADMIN_ACTIONS.push('anything'); }, TypeError);
});
