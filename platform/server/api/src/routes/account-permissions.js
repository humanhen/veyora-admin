/* Account permission management API (B2.4P).

   Mounted under /admin (see index.js). Every route requires an
   authenticated, active account AND the `permissions.manage` capability —
   there is deliberately no role bypass, so an `admin` cannot grant
   themselves anything without already holding `permissions.manage`. The
   first holder is created by a separately reviewed bootstrap operation
   documented in docs/public-website-rebuild/19_ACCOUNT_PERMISSION_SYSTEM.md,
   not by this API and not by a migration.

   Handler logic is exported as plain functions taking an injectable `db`
   (`.query()` plus `.tx()`), matching this repository's convention for
   testing database logic without a live database. */
import { Router } from 'express';
import { pool, tx as realTx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import {
  PERMISSION_DEFINITIONS,
  PERMISSION_KEYS,
  validatePermissionKeyList,
} from '../permission-registry.js';
import { requirePermission, countActiveHolders } from '../permissions.js';

export const MANAGE_CAPABILITY = 'permissions.manage';

export class PermissionApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

/* Explicit columns everywhere — never SELECT *. */
const PERMISSION_COLUMNS = `id, user_id, permission_key, is_active, granted_by, granted_at,
  revoked_by, revoked_at, created_at, updated_at`;

/* ---------------------------------------------------------------------------
   Serializers — explicit, and deliberately narrow about the target account
   --------------------------------------------------------------------------- */

function isoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function serializePermissionRow(row) {
  return {
    permissionKey: row.permission_key,
    isActive: row.is_active === true,
    grantedBy: row.granted_by ?? null,
    grantedAt: isoOrNull(row.granted_at),
    revokedBy: row.revoked_by ?? null,
    revokedAt: isoOrNull(row.revoked_at),
    updatedAt: isoOrNull(row.updated_at),
  };
}

/* The target account is described by the minimum needed to confirm "am I
   editing the right person": id, name, role and status. Deliberately NOT
   email, phone, address, tax id, balance, pricing or any other user field —
   a permissions screen is not a customer-record screen, and this endpoint
   is reachable by anyone holding permissions.manage. */
function serializeTargetUser(row) {
  return {
    id: row.id,
    displayName: [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.business || row.username || row.id,
    role: row.role,
    status: row.status,
  };
}

/* ---------------------------------------------------------------------------
   Concurrency token
   --------------------------------------------------------------------------- */

/* Bound to the target account id, so a token issued while viewing one
   account cannot be replayed against another. The version component is the
   account's whole permission set — every row's key and its updated_at — so
   ANY change by another manager (grant, revoke, or re-grant) invalidates a
   token held by a concurrent editor. */
export function makePermissionsToken(userId, rows) {
  const version = [...rows]
    .map((r) => `${r.permission_key}:${r.is_active === true ? 1 : 0}:${isoOrNull(r.updated_at) ?? ''}`)
    .sort()
    .join('|');
  return `perms:${userId}:${version}`;
}

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

export function getPermissionRegistry() {
  // The frozen registry, shaped for an admin screen. No database involved.
  return PERMISSION_DEFINITIONS.map((d) => ({ key: d.key, label: d.label, description: d.description }));
}

async function loadTargetUser(db, userId) {
  const { rows } = await db.query(
    `select id, first_name, last_name, business, username, role, status from users where id = $1 limit 1`,
    [userId]
  );
  if (!rows[0]) throw new PermissionApiError(404, { error: 'Account not found' });
  return rows[0];
}

export async function getAccountPermissions(db, userId) {
  const user = await loadTargetUser(db, userId);
  const { rows } = await db.query(
    `select ${PERMISSION_COLUMNS} from account_permissions where user_id = $1 order by permission_key`,
    [userId]
  );
  return {
    user: serializeTargetUser(user),
    permissions: rows.map(serializePermissionRow),
    activePermissions: rows.filter((r) => r.is_active === true).map((r) => r.permission_key).sort(),
    concurrencyToken: makePermissionsToken(userId, rows),
  };
}

/* ---------------------------------------------------------------------------
   Replacement (PUT) — transactional, audited, last-manager protected
   --------------------------------------------------------------------------- */

/**
 * Replaces the target account's ACTIVE capability set.
 *
 * @param actor the AUTHENTICATED user. Attribution comes only from here —
 *   `granted_by`/`revoked_by` are never read from the request body.
 */
export async function replaceAccountPermissions(db, userId, { desiredKeys, token, actor }) {
  const validated = validatePermissionKeyList(desiredKeys);
  if (!validated.ok) {
    throw new PermissionApiError(400, { error: 'Invalid permissions', fieldErrors: validated.errors });
  }
  const desired = new Set(validated.keys);

  const result = await db.tx(async (c) => {
    const user = await loadTargetUser(c, userId);

    /* Lock this account's permission rows for the transaction. The token
       check below stops a lost update (a manager overwriting a change they
       never saw); the lock stops two transactions interleaving. */
    const { rows: current } = await c.query(
      `select ${PERMISSION_COLUMNS} from account_permissions where user_id = $1 order by permission_key for update`,
      [userId]
    );

    if (token !== makePermissionsToken(userId, current)) {
      // Throwing rolls back, so a stale attempt writes nothing.
      throw new PermissionApiError(409, {
        error: 'These permissions changed since you loaded them. Reload and reapply your change.',
        code: 'STALE_TOKEN',
      });
    }

    const byKey = new Map(current.map((r) => [r.permission_key, r]));
    const toGrant = [];
    const toRevoke = [];

    for (const key of PERMISSION_KEYS) {
      const row = byKey.get(key);
      const isActive = row?.is_active === true;
      const wanted = desired.has(key);
      // Unchanged grants are left completely alone — no row is rewritten,
      // so granted_by/granted_at keep their original attribution and
      // updated_at does not churn.
      if (wanted && !isActive) toGrant.push(key);
      else if (!wanted && isActive) toRevoke.push(key);
    }

    /* LAST-MANAGER PROTECTION. Evaluated inside the transaction, after the
       lock, against a live count — never against a value read before the
       transaction began. Without this, two concurrent revocations could
       each see one other manager and both proceed, locking everyone out of
       permission management with no way back except a manual database
       operation. */
    if (toRevoke.includes(MANAGE_CAPABILITY)) {
      const remaining = await countActiveHolders(c, MANAGE_CAPABILITY);
      // `remaining` includes this account, which is about to lose it.
      if (remaining <= 1) {
        throw new PermissionApiError(422, {
          error:
            'This would remove the last account able to manage permissions. Grant permissions.manage ' +
            'to another active account first.',
          code: 'LAST_PERMISSION_MANAGER',
        });
      }
    }

    for (const key of toGrant) {
      /* Revoked rows are re-activated in place rather than deleted and
         re-inserted, so one row per (account, capability) holds the whole
         history. `on conflict` handles the first-ever grant and the
         re-grant identically. */
      await c.query(
        `insert into account_permissions (user_id, permission_key, is_active, granted_by, granted_at, revoked_by, revoked_at)
         values ($1, $2, true, $3, now(), null, null)
         on conflict (user_id, permission_key)
         do update set is_active = true, granted_by = $3, granted_at = now(),
                       revoked_by = null, revoked_at = null`,
        [userId, key, actor?.id ?? null]
      );
    }

    for (const key of toRevoke) {
      // Revocation never deletes: it flips the flag and stamps who/when,
      // preserving the original granted_by/granted_at alongside it.
      await c.query(
        `update account_permissions
            set is_active = false, revoked_by = $3, revoked_at = now()
          where user_id = $1 and permission_key = $2`,
        [userId, key, actor?.id ?? null]
      );
    }

    const { rows: after } = await c.query(
      `select ${PERMISSION_COLUMNS} from account_permissions where user_id = $1 order by permission_key`,
      [userId]
    );

    return {
      user: serializeTargetUser(user),
      permissions: after.map(serializePermissionRow),
      activePermissions: after.filter((r) => r.is_active === true).map((r) => r.permission_key).sort(),
      concurrencyToken: makePermissionsToken(userId, after),
      granted: toGrant,
      revoked: toRevoke,
    };
  });

  /* Audited after commit, and only for real changes. Failures never reach
     here, so the audit log cannot claim a change that rolled back. */
  if (result.granted.length || result.revoked.length) {
    await audit(
      { id: actor?.id, name: actor?.business || actor?.email, role: actor?.role },
      'account_permissions.replace',
      `user:${userId}`,
      `granted: ${result.granted.join(', ') || 'none'}; revoked: ${result.revoked.join(', ') || 'none'}`
    ).catch(() => {});
  }
  return result;
}

/* ---------------------------------------------------------------------------
   Router
   --------------------------------------------------------------------------- */

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

const r = Router();

/* Authentication, then the capability. `requireAuth()` takes no role
   arguments deliberately — authority here is `permissions.manage`, not a
   role, so an admin without the grant is refused and a non-admin with it
   is allowed. */
r.use(requireAuth());
r.use(requirePermission(MANAGE_CAPABILITY));

function send(res, next, promise) {
  promise
    .then((value) => res.json(value))
    .catch((err) => {
      if (err instanceof PermissionApiError) return res.status(err.status).json(err.body);
      next(err);
    });
}

r.get('/registry', (req, res) => res.json({ permissions: getPermissionRegistry() }));

r.get('/users/:userId', (req, res, next) =>
  send(res, next, getAccountPermissions(liveDb, req.params.userId))
);

r.put('/users/:userId', (req, res, next) =>
  send(
    res,
    next,
    replaceAccountPermissions(liveDb, req.params.userId, {
      desiredKeys: req.body?.permissions,
      token: req.body?.concurrencyToken,
      actor: req.user, // authenticated context only — never req.body
    })
  )
);

// No DELETE route: revocation happens through PUT, which preserves history.

export default r;
