/* Capability registry, resolution and middleware (B2.4P).

   Real modules against a controlled database double. No live database. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PERMISSION_KEYS,
  PERMISSION_DEFINITIONS,
  isRegisteredPermission,
  getPermissionDefinition,
  validatePermissionKeyList,
} from '../src/permission-registry.js';
import {
  getUserPermissions,
  hasPermission,
  hasAllPermissions,
  requirePermission,
  requireAllPermissions,
  countActiveHolders,
} from '../src/permissions.js';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const permissionsCode = stripComments(fs.readFileSync(path.join(SRC, 'permissions.js'), 'utf8'));
const registryCode = stripComments(fs.readFileSync(path.join(SRC, 'permission-registry.js'), 'utf8'));

/** Fake db holding grant rows: { user_id, permission_key, is_active, status }.
 * `status` is the OWNING USER's account status, so the join behaviour in the
 * real queries can be exercised. */
function makeDb(grants = []) {
  const statements = [];
  return {
    statements,
    async query(sql, params = []) {
      statements.push({ sql, params });

      const activeOnly = /is_active = true/.test(sql);
      const activeUserOnly = /u\.status = 'active'/.test(sql);

      if (/count\(\*\)/.test(sql)) {
        const key = params[0];
        const count = grants.filter(
          (g) => g.permission_key === key && (!activeOnly || g.is_active) && (!activeUserOnly || g.status === 'active')
        ).length;
        return { rows: [{ count }] };
      }
      if (/from account_permissions ap/.test(sql)) {
        const [userId, key] = params;
        const rows = grants.filter(
          (g) =>
            g.user_id === userId &&
            (key === undefined || g.permission_key === key) &&
            (!activeOnly || g.is_active) &&
            (!activeUserOnly || g.status === 'active')
        );
        return { rows: rows.map((g) => ({ permission_key: g.permission_key })) };
      }
      return { rows: [] };
    },
  };
}

const grant = (user_id, permission_key, extra = {}) => ({
  user_id,
  permission_key,
  is_active: true,
  status: 'active',
  ...extra,
});

/** Runs a middleware and reports what it did. */
function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    const res = {
      status: (code) => ({ json: (body) => resolve({ outcome: 'denied', code, body }) }),
    };
    mw(req, res, (err) => resolve(err ? { outcome: 'error', err } : { outcome: 'allowed' }));
  });
}

// ---------------------------------------------------------------------------
// 21 / registry
// ---------------------------------------------------------------------------

test('the registry contains exactly the four approved capabilities', () => {
  assert.deepEqual(PERMISSION_KEYS, [
    'public_content.view',
    'public_content.edit',
    'public_content.publish',
    'permissions.manage',
  ]);
});

test('every definition has a stable label and description for administration', () => {
  for (const definition of PERMISSION_DEFINITIONS) {
    assert.ok(definition.label.length > 3, `${definition.key} needs a label`);
    assert.ok(definition.description.length > 30, `${definition.key} needs a real description`);
  }
});

test('the registry is immutable — a caller cannot add, mutate or widen a definition', () => {
  assert.throws(() => PERMISSION_DEFINITIONS.push({ key: 'x' }), TypeError);
  assert.throws(() => {
    'use strict';
    PERMISSION_DEFINITIONS[0].key = 'hacked';
  }, TypeError);
  assert.throws(() => PERMISSION_KEYS.push('x'), TypeError);
  // A mutation attempt through a returned definition must not stick either.
  const definition = getPermissionDefinition('permissions.manage');
  assert.throws(() => {
    'use strict';
    definition.label = 'changed';
  }, TypeError);
});

test('38 — there is no wildcard, prefix or hierarchical permission behaviour', () => {
  for (const notAKey of [
    '*',
    'public_content.*',
    'public_content',
    'public_content.',
    '.publish',
    'permissions.*',
    'PUBLIC_CONTENT.VIEW',
    ' public_content.view',
    'public_content.view ',
  ]) {
    assert.equal(isRegisteredPermission(notAKey), false, `"${notAKey}" must not be a recognised key`);
  }
  // And nothing in the registry or resolver does prefix/wildcard matching.
  // (`count(*)` in the resolver's SQL is not a permission wildcard, so the
  // check targets wildcard *matching* constructs rather than the character.)
  for (const code of [registryCode, permissionsCode]) {
    assert.doesNotMatch(code, /startsWith|endsWith/);
    assert.doesNotMatch(code, /\.split\(\s*['"]\./);
    assert.doesNotMatch(code, /['"]\*['"]/, 'no literal wildcard key');
    assert.doesNotMatch(code, /like\s+['"][^'"]*%/i, 'no LIKE-based key matching');
  }
});

test('a role name is not a permission key', () => {
  for (const role of ['admin', 'warehouse', 'agent', 'super-agent', 'customer']) {
    assert.equal(isRegisteredPermission(role), false);
  }
});

test('non-string and empty inputs are rejected', () => {
  for (const bad of [null, undefined, 42, {}, [], true, '']) {
    assert.equal(isRegisteredPermission(bad), false);
  }
});

// ---------------------------------------------------------------------------
// 24 / key-list validation
// ---------------------------------------------------------------------------

test('a valid key list is accepted and canonicalised into registry order', () => {
  const result = validatePermissionKeyList(['permissions.manage', 'public_content.view']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.keys, ['public_content.view', 'permissions.manage']);
});

test('an empty list is valid — it means "revoke everything"', () => {
  const result = validatePermissionKeyList([]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.keys, []);
});

test('an unknown key is rejected, never silently dropped', () => {
  const result = validatePermissionKeyList(['public_content.view', 'public_content.destroy']);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'UNKNOWN_PERMISSION');
});

test('a duplicate key is rejected', () => {
  const result = validatePermissionKeyList(['public_content.view', 'public_content.view']);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'DUPLICATE_PERMISSION');
});

test('a non-array body is rejected', () => {
  for (const bad of [null, undefined, 'public_content.view', {}, 42]) {
    assert.equal(validatePermissionKeyList(bad).ok, false);
  }
});

test('an over-long list is rejected before per-item work', () => {
  const result = validatePermissionKeyList(Array.from({ length: 50 }, () => 'public_content.view'));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'TOO_MANY');
});

// ---------------------------------------------------------------------------
// 10 / 11 / 12 / 13 / 14 — resolution
// ---------------------------------------------------------------------------

test('10 — a specifically granted account resolves the capability', async () => {
  const db = makeDb([grant('u_1', 'public_content.publish')]);
  assert.equal(await hasPermission(db, 'u_1', 'public_content.publish'), true);
  assert.deepEqual(await getUserPermissions(db, 'u_1'), ['public_content.publish']);
});

test('11 — a second account without the grant is denied', async () => {
  const db = makeDb([grant('u_1', 'public_content.publish')]);
  assert.equal(await hasPermission(db, 'u_2', 'public_content.publish'), false);
  assert.deepEqual(await getUserPermissions(db, 'u_2'), []);
});

test('12 — a revoked grant is denied', async () => {
  const db = makeDb([grant('u_1', 'public_content.publish', { is_active: false })]);
  assert.equal(await hasPermission(db, 'u_1', 'public_content.publish'), false);
});

test('13 — a disabled or pending account is denied even with an active grant', async () => {
  for (const status of ['disabled', 'pending']) {
    const db = makeDb([grant('u_1', 'public_content.publish', { status })]);
    assert.equal(await hasPermission(db, 'u_1', 'public_content.publish'), false, `status ${status}`);
    assert.deepEqual(await getUserPermissions(db, 'u_1'), []);
  }
});

test('14 — an unknown capability fails closed without touching the database', async () => {
  const db = makeDb([grant('u_1', 'public_content.publish')]);
  assert.equal(await hasPermission(db, 'u_1', 'public_content.*'), false);
  assert.equal(await hasPermission(db, 'u_1', 'nonsense'), false);
  assert.equal(db.statements.length, 0, 'an unregistered key must be rejected before any query');
});

test('a missing or malformed user id resolves nothing', async () => {
  const db = makeDb([grant('u_1', 'public_content.view')]);
  for (const bad of [undefined, null, '', 42]) {
    assert.equal(await hasPermission(db, bad, 'public_content.view'), false);
  }
});

test('hasAllPermissions requires every listed capability', async () => {
  const db = makeDb([grant('u_1', 'public_content.view'), grant('u_1', 'public_content.edit')]);
  assert.equal(await hasAllPermissions(db, 'u_1', ['public_content.view', 'public_content.edit']), true);
  assert.equal(
    await hasAllPermissions(db, 'u_1', ['public_content.view', 'public_content.publish']),
    false
  );
  assert.equal(await hasAllPermissions(db, 'u_1', []), false, 'an empty requirement must not pass');
});

test('countActiveHolders counts only active grants held by active accounts', async () => {
  const db = makeDb([
    grant('u_1', 'permissions.manage'),
    grant('u_2', 'permissions.manage', { is_active: false }),
    grant('u_3', 'permissions.manage', { status: 'disabled' }),
  ]);
  assert.equal(await countActiveHolders(db, 'permissions.manage'), 1);
  assert.equal(await countActiveHolders(db, 'not-a-key'), 0);
});

// ---------------------------------------------------------------------------
// 8 / 9 / 15 / 39 — middleware
// ---------------------------------------------------------------------------

test('8 — an unauthenticated request is denied 401 and never reaches the handler', async () => {
  const db = makeDb([]);
  const result = await runMiddleware(requirePermission('public_content.view', { db }), { user: undefined });
  assert.equal(result.outcome, 'denied');
  assert.equal(result.code, 401);
});

test('9 / 39 — a role-only administrator is denied on a capability route (no role bypass)', async () => {
  const db = makeDb([]); // no grants at all
  const result = await runMiddleware(requirePermission('public_content.view', { db }), {
    user: { id: 'u_admin', role: 'admin', status: 'active' },
  });
  assert.equal(result.outcome, 'denied');
  assert.equal(result.code, 403);
  assert.deepEqual(result.body, { error: 'forbidden' });
});

test('a granted account passes the middleware', async () => {
  const db = makeDb([grant('u_1', 'public_content.edit')]);
  const result = await runMiddleware(requirePermission('public_content.edit', { db }), {
    user: { id: 'u_1', role: 'customer', status: 'active' },
  });
  assert.equal(result.outcome, 'allowed', 'a non-admin WITH the grant must be allowed');
});

test('15 — a permission cannot be forged through headers, body or query', async () => {
  const db = makeDb([]);
  const result = await runMiddleware(requirePermission('public_content.publish', { db }), {
    user: { id: 'u_1', role: 'customer', status: 'active', permissions: ['public_content.publish'] },
    headers: { 'x-permissions': 'public_content.publish', 'x-user-id': 'u_admin' },
    body: { permissions: ['public_content.publish'], granted_by: 'u_1' },
    query: { permission: 'public_content.publish' },
  });
  assert.equal(result.outcome, 'denied');
  assert.equal(result.code, 403);
  // Structural: the resolver reads nothing from the request at all.
  assert.doesNotMatch(permissionsCode, /req\.(headers|body|query)/);
});

test('a middleware built with an unregistered key denies everything (a typo closes, never opens)', async () => {
  const db = makeDb([grant('u_1', 'public_content.view')]);
  const result = await runMiddleware(requirePermission('public_content.viewz', { db }), {
    user: { id: 'u_1', role: 'admin', status: 'active' },
  });
  assert.equal(result.outcome, 'denied');
  assert.equal(result.code, 403);
});

test('requireAllPermissions enforces every capability and rejects an empty requirement', async () => {
  const db = makeDb([grant('u_1', 'public_content.view')]);
  const partial = await runMiddleware(
    requireAllPermissions(['public_content.view', 'public_content.edit'], { db }),
    { user: { id: 'u_1', status: 'active' } }
  );
  assert.equal(partial.outcome, 'denied');

  const empty = await runMiddleware(requireAllPermissions([], { db }), { user: { id: 'u_1' } });
  assert.equal(empty.outcome, 'denied');
});

// ---------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------

test('the resolver never consults users.role', () => {
  assert.doesNotMatch(permissionsCode, /\.role\b/);
  assert.doesNotMatch(permissionsCode, /ADMIN_ROLES|AGENT_ROLES|'admin'/);
});

test('resolver SQL is parameterised, explicit-column and never interpolates a permission key', async () => {
  const db = makeDb([]);
  await hasPermission(db, "u_1'; drop table account_permissions; --", 'public_content.view');
  for (const statement of db.statements) {
    assert.doesNotMatch(statement.sql, /select\s+\*/i);
    assert.doesNotMatch(statement.sql, /\b[a-z]\.\*/i);
    assert.ok(!statement.sql.includes('drop table'), 'a payload reached SQL text');
    assert.match(statement.sql, /\$\d/, 'must use bound parameters');
  }
});

test('the resolver does not cache — every check re-reads, so a revocation takes effect immediately', async () => {
  const grants = [grant('u_1', 'public_content.edit')];
  const db = makeDb(grants);
  assert.equal(await hasPermission(db, 'u_1', 'public_content.edit'), true);
  grants[0].is_active = false; // revoked by another manager
  assert.equal(await hasPermission(db, 'u_1', 'public_content.edit'), false, 'a cached result would still allow');
});
