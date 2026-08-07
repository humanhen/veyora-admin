/* Account permission schema, management API, and the capability mapping on
   the public-content router (B2.4P).

   Real handlers against a controlled database double. No live database. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import accountPermissionsRouter, {
  getPermissionRegistry,
  getAccountPermissions,
  replaceAccountPermissions,
  makePermissionsToken,
  PermissionApiError,
  MANAGE_CAPABILITY,
} from '../src/routes/account-permissions.js';
import adminPublicContentRouter, {
  PUBLIC_CONTENT_CAPABILITIES,
} from '../src/routes/admin-public-content.js';
import { PERMISSION_KEYS } from '../src/permission-registry.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const MIGRATIONS = path.join(path.dirname(ROOT), 'db', 'migrations');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const migrationSql = fs.readFileSync(path.join(MIGRATIONS, '0008_account_permissions.sql'), 'utf8');
/* 0008 is immutable — it has run. Capabilities added later widen its CHECK
   from their own migration, so "is this key storable?" is a question about the
   migrations as a whole, not about 0008 alone. */
const enquiryMigrationSql = fs.readFileSync(path.join(MIGRATIONS, '0009_enquiry_operations.sql'), 'utf8');
const contactMigrationSql = fs.readFileSync(path.join(MIGRATIONS, '0012_customer_contacts.sql'), 'utf8');
const paymentMigrationSql = fs.readFileSync(path.join(MIGRATIONS, '0013_stripe_payments.sql'), 'utf8');
const financeMigrationSql = fs.readFileSync(path.join(MIGRATIONS, '0014_finance_operations.sql'), 'utf8');
const statementMigrationSql = fs.readFileSync(path.join(MIGRATIONS, '0015_account_statements.sql'), 'utf8');
/* Every migration that has widened the capability CHECK. The widening one is
   always the LAST of these — see 6b, which reads `latestWidenedSql`. */
const allMigrationSql = `${migrationSql}\n${enquiryMigrationSql}\n${contactMigrationSql}\n${paymentMigrationSql}\n${financeMigrationSql}\n${statementMigrationSql}`;
const latestWidenedSql = statementMigrationSql;
const migrateJs = fs.readFileSync(path.join(SRC, 'migrate.js'), 'utf8');
const managementCode = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'account-permissions.js'), 'utf8'));
const publicContentCode = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'admin-public-content.js'), 'utf8'));
const publicRouterCode = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'public.js'), 'utf8'));

const NOW = new Date('2026-08-06T12:00:00.000Z');
const ACTOR = { id: 'u_manager', role: 'admin', email: 'mgr@example.test', business: 'Ops' };

const permRow = (permission_key, over = {}) => ({
  id: `perm_${permission_key}`,
  user_id: 'u_target',
  permission_key,
  is_active: true,
  granted_by: 'u_someone',
  granted_at: NOW,
  revoked_by: null,
  revoked_at: null,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

const TARGET_USER = {
  id: 'u_target',
  first_name: 'Alex',
  last_name: 'Editor',
  business: 'Veyora',
  username: 'alex',
  role: 'customer',
  status: 'active',
};

/**
 * Fake db with a mutable permission table.
 * `managerCount` controls what countActiveHolders sees.
 */
function makeDb({ rows = [], user = TARGET_USER, managerCount = 5, failOn = null } = {}) {
  const statements = [];
  let table = rows.map((r) => ({ ...r }));
  let committed = false;
  let rolledBack = false;

  async function query(sql, params = []) {
    statements.push({ sql, params });
    if (failOn && failOn.test(sql)) throw new Error('simulated database failure');

    if (/from users where id/.test(sql)) return { rows: user ? [user] : [] };
    if (/count\(\*\)/.test(sql)) return { rows: [{ count: managerCount }] };
    if (/from account_permissions where user_id/.test(sql)) {
      return { rows: table.filter((r) => r.user_id === params[0]).sort((a, b) => a.permission_key.localeCompare(b.permission_key)) };
    }
    if (/^\s*insert into account_permissions/i.test(sql)) {
      const [userId, key, grantedBy] = params;
      const existing = table.find((r) => r.user_id === userId && r.permission_key === key);
      if (existing) {
        Object.assign(existing, { is_active: true, granted_by: grantedBy, granted_at: NOW, revoked_by: null, revoked_at: null, updated_at: new Date() });
      } else {
        table.push(permRow(key, { user_id: userId, granted_by: grantedBy, granted_at: NOW, updated_at: new Date() }));
      }
      return { rows: [] };
    }
    if (/^\s*update account_permissions/i.test(sql)) {
      const [userId, key, revokedBy] = params;
      const existing = table.find((r) => r.user_id === userId && r.permission_key === key);
      if (existing) Object.assign(existing, { is_active: false, revoked_by: revokedBy, revoked_at: NOW, updated_at: new Date() });
      return { rows: [] };
    }
    return { rows: [] };
  }

  return {
    statements,
    get table() { return table; },
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
    query,
    async tx(fn) {
      const snapshot = table.map((r) => ({ ...r }));
      try {
        const result = await fn({ query });
        committed = true;
        return result;
      } catch (err) {
        table = snapshot; // real rollback semantics
        rolledBack = true;
        throw err;
      }
    },
    writes() {
      return statements.filter((s) => /^\s*(insert into|update) account_permissions/i.test(s.sql));
    },
  };
}

// ---------------------------------------------------------------------------
// 1-7 — schema
// ---------------------------------------------------------------------------

test('1 — the additive permission table exists in the migration and in ensureSchema', () => {
  assert.match(migrationSql, /create table if not exists account_permissions/);
  assert.match(migrateJs, /create table if not exists account_permissions/);
});

test('2 — migration and ensureSchema definitions stay aligned on every column and constraint', () => {
  for (const fragment of [
    'user_id',
    'permission_key',
    'is_active',
    'granted_by',
    'granted_at',
    'revoked_by',
    'revoked_at',
    'account_permissions_user_key_unique',
    'account_permissions_active_attributed',
    'account_permissions_revocation_attributed',
    'account_permissions_user_idx',
    'account_permissions_active_key_idx',
    't_account_permissions_touch',
  ]) {
    assert.ok(migrationSql.includes(fragment), `migration missing ${fragment}`);
    assert.ok(migrateJs.includes(fragment), `ensureSchema missing ${fragment}`);
  }
});

test('3 — no automatic grant: neither file inserts a permission row', () => {
  for (const [name, sql] of [['migration', migrationSql], ['ensureSchema section', migrateJs]]) {
    const inserts = sql.match(/insert into account_permissions/gi) ?? [];
    assert.equal(inserts.length, 0, `${name} grants a permission automatically`);
  }
});

test('4 — user + permission uniqueness prevents duplicate active authority', () => {
  assert.match(migrationSql, /unique \(user_id, permission_key\)/);
  assert.match(migrateJs, /unique \(user_id, permission_key\)/);
});

test('5 — audit fields exist with safe FK deletion behaviour', () => {
  // The grant belongs to the account; attribution survives the attributor.
  assert.match(migrationSql, /user_id\s+text not null references users\(id\) on delete cascade/);
  assert.match(migrationSql, /granted_by\s+text references users\(id\) on delete set null/);
  assert.match(migrationSql, /revoked_by\s+text references users\(id\) on delete set null/);
});

test('6 — only registered keys can be stored: the CHECK lists every registered capability', () => {
  for (const key of PERMISSION_KEYS) {
    assert.ok(allMigrationSql.includes(`'${key}'`), `migration CHECK missing ${key}`);
    assert.ok(migrateJs.includes(`'${key}'`), `ensureSchema CHECK missing ${key}`);
  }
  // No wildcard is storable.
  assert.ok(!allMigrationSql.includes("'*'"));
  assert.ok(!allMigrationSql.includes("public_content.*"));
  assert.ok(!allMigrationSql.includes("enquiries.*"));
});

/* The widening migration must be a strict superset, checked against the
   registry rather than against a hand-copied list: a key dropped from the
   CHECK while a grant still carries it would leave a row the database refuses
   to update and the application still honours. */
test('6b — the latest widened CHECK is a strict superset of every earlier one', () => {
  const widened = latestWidenedSql.slice(latestWidenedSql.indexOf('permission_key in'));
  for (const key of PERMISSION_KEYS) {
    assert.ok(widened.includes(`'${key}'`), `widened CHECK missing ${key}`);
  }
  /* Earlier migrations are NOT edited: one that has run somewhere is
     immutable, so each widening adds a new drop-and-recreate rather than
     rewriting history. */
  assert.ok(migrationSql.includes("'permissions.manage'"));
  assert.ok(!migrationSql.includes('enquiries.'), '0008 must not be rewritten');
  assert.ok(!migrationSql.includes('customer_contacts.'), '0008 must not be rewritten');
  assert.ok(!migrationSql.includes('payments.'), '0008 must not be rewritten');
  assert.ok(!enquiryMigrationSql.includes('customer_contacts.'), '0009 must not be rewritten');
  assert.ok(!enquiryMigrationSql.includes('payments.'), '0009 must not be rewritten');
  assert.ok(!contactMigrationSql.includes("'payments."), '0012 must not be rewritten');
  assert.ok(!paymentMigrationSql.includes("'finance."), '0013 must not be rewritten');
  assert.ok(!financeMigrationSql.includes("'statements."), '0014 must not be rewritten');
});

test('7 — no destructive SQL in either definition', () => {
  const section = migrateJs.slice(migrateJs.indexOf('account_permissions'));
  for (const [name, sql] of [['migration', migrationSql], ['ensureSchema', section]]) {
    assert.doesNotMatch(sql, /drop\s+(table|column)/i, `${name} contains a drop`);
    assert.doesNotMatch(sql, /truncate/i);
    assert.doesNotMatch(sql, /delete\s+from/i);
    assert.doesNotMatch(sql, /alter table users/i, `${name} alters the users table`);
  }
});

test('the migration is the next number in sequence and users.role is untouched', () => {
  assert.ok(fs.existsSync(path.join(MIGRATIONS, '0008_account_permissions.sql')));
  assert.ok(!fs.existsSync(path.join(MIGRATIONS, '0009_account_permissions.sql')));
  // Comments discuss roles (they explain what this replaces); the statements
  // must not touch them.
  const statements = migrationSql.replace(/^\s*--[^\n]*$/gm, ' ');
  assert.doesNotMatch(statements, /alter table users/i);
  assert.doesNotMatch(statements, /\brole\b/i, 'the migration must not touch role semantics');
});

// ---------------------------------------------------------------------------
// 16-20 — public-content capability mapping
// ---------------------------------------------------------------------------

test('16/17/18 — routes map to the documented capabilities', () => {
  assert.deepEqual(PUBLIC_CONTENT_CAPABILITIES, {
    read: 'public_content.view',
    evaluate: 'public_content.view',
    edit: 'public_content.edit',
    publish: 'public_content.publish',
  });
  // GET + evaluate use view; PATCH uses edit; publish/unpublish use publish.
  assert.match(publicContentCode, /r\.get\('\/brands', canRead\(\)/);
  assert.match(publicContentCode, /r\.get\('\/variations\/:id', canRead\(\)/);
  assert.match(publicContentCode, /evaluate`, canRead\(\)/);
  assert.match(publicContentCode, /r\.patch\(`\/\$\{segment\}\/:id`, canEdit\(\)/);
  assert.match(publicContentCode, /publish`, canPublish\(\)/);
  assert.match(publicContentCode, /unpublish`, canPublish\(\)/);
});

test('every public-content route carries a capability middleware in addition to its handler', () => {
  /* One deliberate exemption (B2.4B2A): `/capabilities` reports the caller's
     OWN capabilities and must answer an authenticated account that holds
     none, so the admin panel can render an accurate access-denied state
     instead of a failure. It is still behind router-level authentication and
     discloses nothing but three booleans about the caller. */
  const EXEMPT = new Set(['/capabilities']);
  for (const layer of adminPublicContentRouter.stack) {
    if (!layer.route) continue;
    const expected = EXEMPT.has(layer.route.path) ? 1 : 2;
    assert.equal(layer.route.stack.length, expected, `${layer.route.path} should have capability + handler`);
  }
  // The exemption is exactly one route, and it is a read.
  const exempt = adminPublicContentRouter.stack.filter((l) => l.route && l.route.stack.length === 1);
  assert.deepEqual(exempt.map((l) => l.route.path), ['/capabilities']);
  assert.ok(exempt.every((l) => l.route.methods.get), 'the exempt route must be a GET');
});

test('39 — the public-content router has no role bypass', () => {
  // requireAuth is called with NO role argument; authority is the capability.
  assert.match(publicContentCode, /requireAuth\(\)/);
  assert.doesNotMatch(publicContentCode, /requireAuth\('admin'\)/);
  assert.doesNotMatch(publicContentCode, /ADMIN_ROLES|AGENT_ROLES/);
});

test('19 — the public read-only router is unchanged: still no auth and no write route', () => {
  assert.doesNotMatch(publicRouterCode, /requireAuth|requirePermission/);
  assert.doesNotMatch(publicRouterCode, /r\.(post|put|patch|delete)\(/i);
});

test('20 — existing unrelated admin routes keep their role-based authorisation', () => {
  const adminCode = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'admin.js'), 'utf8'));
  assert.match(adminCode, /r\.use\(requireAuth\('admin', 'warehouse'\)\)/);
  assert.doesNotMatch(adminCode, /requirePermission/, 'B2.4P must not rewrite unrelated admin authorisation');
});

// ---------------------------------------------------------------------------
// 21/22/35 — management API surface
// ---------------------------------------------------------------------------

test('21 — the registry endpoint returns exactly the four approved keys', () => {
  const registry = getPermissionRegistry();
  assert.deepEqual(registry.map((r) => r.key), PERMISSION_KEYS);
  for (const entry of registry) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'key', 'label']);
  }
});

test('22 — every management route sits behind auth and the permissions.manage capability', () => {
  const middleware = accountPermissionsRouter.stack.filter((l) => !l.route);
  assert.equal(middleware.length, 2, 'expected requireAuth + requirePermission');
  assert.match(managementCode, /r\.use\(requireAuth\(\)\)/);
  assert.match(managementCode, /r\.use\(requirePermission\(MANAGE_CAPABILITY\)\)/);
  assert.equal(MANAGE_CAPABILITY, 'permissions.manage');
});

test('35 — no DELETE route exists on the management router', () => {
  for (const layer of accountPermissionsRouter.stack) {
    if (!layer.route) continue;
    assert.ok(!layer.route.methods.delete, `DELETE on ${layer.route.path}`);
  }
  assert.doesNotMatch(managementCode, /r\.delete\(/);
});

// ---------------------------------------------------------------------------
// 23/36 — reads
// ---------------------------------------------------------------------------

test('23 — an unknown target account is a 404', async () => {
  const db = makeDb({ user: null });
  await assert.rejects(() => getAccountPermissions(db, 'u_missing'), (err) => {
    assert.ok(err instanceof PermissionApiError);
    assert.equal(err.status, 404);
    return true;
  });
});

test('36 — the read serializer exposes only explicit fields, and no unrelated user data', async () => {
  const db = makeDb({ rows: [permRow('public_content.view')] });
  const out = await getAccountPermissions(db, 'u_target');

  assert.deepEqual(Object.keys(out).sort(), ['activePermissions', 'concurrencyToken', 'permissions', 'user'].sort());
  assert.deepEqual(Object.keys(out.user).sort(), ['displayName', 'id', 'role', 'status']);
  assert.deepEqual(Object.keys(out.permissions[0]).sort(), [
    'grantedAt', 'grantedBy', 'isActive', 'permissionKey', 'revokedAt', 'revokedBy', 'updatedAt',
  ].sort());

  // No password hash, email, phone, address, balance or pricing anywhere.
  const json = JSON.stringify(out);
  for (const forbidden of ['password', 'email', 'phone', 'tax_id', 'balance', 'pricing', 'address']) {
    assert.ok(!json.toLowerCase().includes(forbidden), `leaked ${forbidden}`);
  }
});

test('the read response includes both active and revoked records', async () => {
  const db = makeDb({
    rows: [permRow('public_content.view'), permRow('public_content.edit', { is_active: false, revoked_by: 'u_x', revoked_at: NOW })],
  });
  const out = await getAccountPermissions(db, 'u_target');
  assert.equal(out.permissions.length, 2);
  assert.deepEqual(out.activePermissions, ['public_content.view']);
});

// ---------------------------------------------------------------------------
// 24/25/26/27/28/29/30 — replacement
// ---------------------------------------------------------------------------

async function currentToken(db, userId = 'u_target') {
  return (await getAccountPermissions(db, userId)).concurrencyToken;
}

test('24 — unknown or duplicate keys return 400 and write nothing', async () => {
  for (const bad of [['public_content.destroy'], ['public_content.view', 'public_content.view'], 'not-an-array', [42]]) {
    const db = makeDb({ rows: [] });
    const token = await currentToken(db);
    await assert.rejects(
      () => replaceAccountPermissions(db, 'u_target', { desiredKeys: bad, token, actor: ACTOR }),
      (err) => {
        assert.equal(err.status, 400);
        assert.ok(Array.isArray(err.body.fieldErrors));
        return true;
      }
    );
    assert.equal(db.writes().length, 0, 'an invalid request must not write');
  }
});

test('25 — actor identity comes from the authenticated context, never the body', async () => {
  const db = makeDb({ rows: [] });
  const token = await currentToken(db);
  await replaceAccountPermissions(db, 'u_target', {
    desiredKeys: ['public_content.view'],
    token,
    actor: ACTOR,
  });
  const insert = db.writes().find((s) => /insert into/i.test(s.sql));
  assert.equal(insert.params[2], 'u_manager', 'granted_by must be the authenticated actor');
  // The router passes only req.user, and nothing reads an actor from the body.
  assert.match(managementCode, /actor: req\.user/);
  assert.doesNotMatch(managementCode, /granted_by.*req\.body|revoked_by.*req\.body|actor:\s*req\.body/);
});

test('26 — a grant records actor and time and activates the capability', async () => {
  const db = makeDb({ rows: [] });
  const token = await currentToken(db);
  const result = await replaceAccountPermissions(db, 'u_target', {
    desiredKeys: ['public_content.edit'],
    token,
    actor: ACTOR,
  });
  assert.deepEqual(result.granted, ['public_content.edit']);
  assert.deepEqual(result.activePermissions, ['public_content.edit']);
  const row = db.table.find((r) => r.permission_key === 'public_content.edit');
  assert.equal(row.is_active, true);
  assert.equal(row.granted_by, 'u_manager');
  assert.ok(row.granted_at);
});

test('27 — revocation preserves the row and its history rather than deleting it', async () => {
  const db = makeDb({ rows: [permRow('public_content.publish')] });
  const token = await currentToken(db);
  const result = await replaceAccountPermissions(db, 'u_target', { desiredKeys: [], token, actor: ACTOR });

  assert.deepEqual(result.revoked, ['public_content.publish']);
  const row = db.table.find((r) => r.permission_key === 'public_content.publish');
  assert.ok(row, 'the row must still exist');
  assert.equal(row.is_active, false);
  assert.equal(row.revoked_by, 'u_manager');
  assert.ok(row.revoked_at);
  assert.equal(row.granted_by, 'u_someone', 'the original grant attribution is preserved');
  // Nothing was deleted.
  assert.ok(!db.statements.some((s) => /delete\s+from/i.test(s.sql)));
});

test('28 — an unchanged grant is not rewritten', async () => {
  const db = makeDb({ rows: [permRow('public_content.view')] });
  const token = await currentToken(db);
  const result = await replaceAccountPermissions(db, 'u_target', {
    desiredKeys: ['public_content.view'],
    token,
    actor: ACTOR,
  });
  assert.deepEqual(result.granted, []);
  assert.deepEqual(result.revoked, []);
  assert.equal(db.writes().length, 0, 'an unchanged set must issue no write');
});

test('a mixed replacement grants and revokes in one transaction', async () => {
  const db = makeDb({ rows: [permRow('public_content.view'), permRow('public_content.publish')] });
  const token = await currentToken(db);
  const result = await replaceAccountPermissions(db, 'u_target', {
    desiredKeys: ['public_content.view', 'public_content.edit'],
    token,
    actor: ACTOR,
  });
  assert.deepEqual(result.granted, ['public_content.edit']);
  assert.deepEqual(result.revoked, ['public_content.publish']);
  assert.ok(db.committed);
});

test('29/30 — replacement is transactional: a mid-operation failure rolls back and writes nothing', async () => {
  const db = makeDb({ rows: [], failOn: /insert into account_permissions/i });
  const token = await currentToken(db);
  await assert.rejects(() =>
    replaceAccountPermissions(db, 'u_target', { desiredKeys: ['public_content.view'], token, actor: ACTOR })
  );
  assert.ok(db.rolledBack);
  assert.equal(db.table.length, 0, 'no row may survive a rollback');
});

test('the replacement locks the account\'s permission rows inside the transaction', async () => {
  const db = makeDb({ rows: [] });
  const token = await currentToken(db);
  await replaceAccountPermissions(db, 'u_target', { desiredKeys: ['public_content.view'], token, actor: ACTOR });
  assert.ok(db.statements.some((s) => /for update/i.test(s.sql)), 'expected a locked read');
});

// ---------------------------------------------------------------------------
// 31/32/33 — concurrency
// ---------------------------------------------------------------------------

test('31 — a stale token returns 409 and mutates nothing', async () => {
  const db = makeDb({ rows: [permRow('public_content.view')] });
  await assert.rejects(
    () => replaceAccountPermissions(db, 'u_target', { desiredKeys: [], token: 'perms:u_target:stale', actor: ACTOR }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.body.code, 'STALE_TOKEN');
      return true;
    }
  );
  assert.equal(db.writes().length, 0);
  assert.ok(db.rolledBack);
  assert.equal(db.table[0].is_active, true, 'the grant must be untouched');
});

test('a missing token is treated as stale', async () => {
  const db = makeDb({ rows: [] });
  await assert.rejects(
    () => replaceAccountPermissions(db, 'u_target', { desiredKeys: ['public_content.view'], actor: ACTOR }),
    (err) => err.status === 409
  );
});

test('32 — a token issued for another account cannot be reused', async () => {
  const db = makeDb({ rows: [] });
  const otherToken = makePermissionsToken('u_someone_else', []);
  await assert.rejects(
    () => replaceAccountPermissions(db, 'u_target', { desiredKeys: ['public_content.view'], token: otherToken, actor: ACTOR }),
    (err) => err.status === 409
  );
});

test('33 — a successful replacement returns a NEW token that differs from the old one', async () => {
  const db = makeDb({ rows: [] });
  const before = await currentToken(db);
  const result = await replaceAccountPermissions(db, 'u_target', {
    desiredKeys: ['public_content.view'],
    token: before,
    actor: ACTOR,
  });
  assert.ok(result.concurrencyToken);
  assert.notEqual(result.concurrencyToken, before, 'the token must change after a real mutation');
});

test('two editors cannot silently overwrite each other', async () => {
  const db = makeDb({ rows: [] });
  const tokenA = await currentToken(db);
  const tokenB = tokenA; // both loaded the same state

  await replaceAccountPermissions(db, 'u_target', { desiredKeys: ['public_content.view'], token: tokenA, actor: ACTOR });
  // The second editor's token is now stale.
  await assert.rejects(
    () => replaceAccountPermissions(db, 'u_target', { desiredKeys: ['public_content.publish'], token: tokenB, actor: ACTOR }),
    (err) => err.status === 409
  );
});

// ---------------------------------------------------------------------------
// 34 — last-manager protection
// ---------------------------------------------------------------------------

test('34 — removing the final active permissions manager returns 422 and writes nothing', async () => {
  const db = makeDb({ rows: [permRow(MANAGE_CAPABILITY)], managerCount: 1 });
  const token = await currentToken(db);
  await assert.rejects(
    () => replaceAccountPermissions(db, 'u_target', { desiredKeys: [], token, actor: ACTOR }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.body.code, 'LAST_PERMISSION_MANAGER');
      return true;
    }
  );
  assert.equal(db.writes().length, 0);
  assert.equal(db.table[0].is_active, true, 'the last manager keeps the capability');
});

test('removing a manager is allowed while another active manager remains', async () => {
  const db = makeDb({ rows: [permRow(MANAGE_CAPABILITY)], managerCount: 2 });
  const token = await currentToken(db);
  const result = await replaceAccountPermissions(db, 'u_target', { desiredKeys: [], token, actor: ACTOR });
  assert.deepEqual(result.revoked, [MANAGE_CAPABILITY]);
});

test('the last-manager count is evaluated INSIDE the transaction, not before it', async () => {
  const db = makeDb({ rows: [permRow(MANAGE_CAPABILITY)], managerCount: 1 });
  const token = await currentToken(db);
  const before = db.statements.length;
  await replaceAccountPermissions(db, 'u_target', { desiredKeys: [], token, actor: ACTOR }).catch(() => {});
  const during = db.statements.slice(before);
  const lockIndex = during.findIndex((s) => /for update/i.test(s.sql));
  const countIndex = during.findIndex((s) => /count\(\*\)/.test(s.sql));
  assert.ok(lockIndex > -1 && countIndex > -1, 'both the lock and the count must happen');
  assert.ok(countIndex > lockIndex, 'the count must run after the lock, inside the transaction');
});

test('revoking a non-manager capability never triggers the last-manager check', async () => {
  const db = makeDb({ rows: [permRow('public_content.view')], managerCount: 0 });
  const token = await currentToken(db);
  await assert.doesNotReject(() =>
    replaceAccountPermissions(db, 'u_target', { desiredKeys: [], token, actor: ACTOR })
  );
});

// ---------------------------------------------------------------------------
// 37 — SQL safety
// ---------------------------------------------------------------------------

test('37 — management SQL uses explicit columns, is parameterised, and never interpolates a key', async () => {
  const db = makeDb({ rows: [] });
  const token = await currentToken(db);
  await replaceAccountPermissions(db, 'u_target', { desiredKeys: PERMISSION_KEYS.slice(0, 2), token, actor: ACTOR });
  for (const statement of db.statements) {
    assert.doesNotMatch(statement.sql, /select\s+\*/i);
    assert.doesNotMatch(statement.sql, /\b[a-z]\.\*/i);
  }
  /* Structural: the ONLY value interpolated into a SQL template is the
     constant column list. Every user-controlled value — the account id, the
     permission key, the actor — must arrive as a bound parameter. */
  const sqlTemplates = managementCode.match(/`[^`]*\b(select|insert into|update)\b[^`]*`/gi) ?? [];
  assert.ok(sqlTemplates.length >= 4, 'expected to find the SQL templates');
  for (const template of sqlTemplates) {
    for (const interpolation of template.match(/\$\{[^}]*\}/g) ?? []) {
      assert.equal(interpolation, '${PERMISSION_COLUMNS}', `interpolated ${interpolation} into SQL`);
    }
  }
});

test('an adversarial user id reaches SQL only as a bound parameter', async () => {
  const db = makeDb({ rows: [], user: null });
  await getAccountPermissions(db, "u_1'; drop table account_permissions; --").catch(() => {});
  for (const statement of db.statements) {
    assert.ok(!statement.sql.includes('drop table'));
  }
});

test('no management error body leaks SQL, a stack trace or infrastructure detail', async () => {
  const db = makeDb({ rows: [permRow(MANAGE_CAPABILITY)], managerCount: 1 });
  const token = await currentToken(db);
  try {
    await replaceAccountPermissions(db, 'u_target', { desiredKeys: [], token, actor: ACTOR });
    assert.fail('should have thrown');
  } catch (err) {
    const body = JSON.stringify(err.body);
    assert.doesNotMatch(body, /select |insert into|update account|pg_|postgres|\$\d/i);
    assert.doesNotMatch(body, /at \w+ \(/);
  }
});

test('the management router does not query customer, order, payment or invoice tables', () => {
  for (const table of ['orders', 'order_items', 'invoices', 'payments', 'credit_notes', 'carts', 'products']) {
    assert.doesNotMatch(managementCode, new RegExp(`(from|join)\\s+${table}\\b`, 'i'));
  }
});

// ---------------------------------------------------------------------------
// disabled target behaviour (documented)
// ---------------------------------------------------------------------------

test('a disabled target account can still have grants edited, but they confer nothing', async () => {
  /* Deliberate: an administrator must be able to revoke a disabled
     account's capabilities (that is exactly when they would want to), and
     to prepare grants for an account awaiting activation. Resolution
     independently requires status = 'active', so a grant on a disabled
     account is inert until the account is reactivated — see
     permissions.test.js's disabled-account denial test. */
  const db = makeDb({ rows: [permRow('public_content.publish')], user: { ...TARGET_USER, status: 'disabled' } });
  const token = await currentToken(db);
  const result = await replaceAccountPermissions(db, 'u_target', { desiredKeys: [], token, actor: ACTOR });
  assert.deepEqual(result.revoked, ['public_content.publish']);
  assert.equal(result.user.status, 'disabled');
});
