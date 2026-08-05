/* Capability resolution and enforcement (B2.4P).

   Resolution rules, all of which fail closed:
     - authentication first: capability is resolved for the AUTHENTICATED
       account id (`req.user.id`) and nothing else. There is no header,
       query or body input to this module;
     - the grant must exist and be active — a revoked row denies;
     - the account must be active — `requireAuth` already rejects a
       non-active user at authentication, and this module re-checks inside
       its own query so a capability can never resolve for a disabled
       account even if reached another way;
     - an unregistered capability denies, always, before any query runs;
     - NO ROLE FALLBACK. `users.role` is never consulted here. An `admin`
       role does not satisfy a capability-gated route. This is the whole
       point of the batch: without it, every admin would remain equivalent.

   Deliberately NOT cached. A permission change must take effect on the
   next request, and a stale cache on an authorisation decision is the kind
   of bug that is invisible until it matters. The query is a single indexed
   lookup on a table with at most four rows per account; caching it would
   trade a real safety property for no measurable gain. */
import { pool } from './db.js';
import { isRegisteredPermission } from './permission-registry.js';

/**
 * Every ACTIVE capability held by an account.
 *
 * @param db anything with `.query()` — the real pool in production, a
 *   controlled double in tests (this repository's established convention).
 * @returns string[] of registered keys, in database order.
 */
export async function getUserPermissions(db, userId) {
  if (typeof userId !== 'string' || userId === '') return [];
  const { rows } = await db.query(
    `select ap.permission_key
       from account_permissions ap
       join users u on u.id = ap.user_id
      where ap.user_id = $1
        and ap.is_active = true
        and u.status = 'active'
      order by ap.permission_key`,
    [userId]
  );
  /* Filtered against the registry on the way out as well as the way in:
     if a key were ever removed from the registry while rows still carry it,
     it must stop conferring authority immediately rather than lingering. */
  return rows.map((r) => r.permission_key).filter(isRegisteredPermission);
}

/** True only when the account holds this exact active capability. An
 * unregistered key is denied without touching the database. */
export async function hasPermission(db, userId, permissionKey) {
  if (!isRegisteredPermission(permissionKey)) return false;
  if (typeof userId !== 'string' || userId === '') return false;
  const { rows } = await db.query(
    `select 1
       from account_permissions ap
       join users u on u.id = ap.user_id
      where ap.user_id = $1
        and ap.permission_key = $2
        and ap.is_active = true
        and u.status = 'active'
      limit 1`,
    [userId, permissionKey]
  );
  return rows.length > 0;
}

/** True only when the account holds every listed capability. */
export async function hasAllPermissions(db, userId, permissionKeys) {
  if (!Array.isArray(permissionKeys) || permissionKeys.length === 0) return false;
  if (!permissionKeys.every(isRegisteredPermission)) return false;
  const held = new Set(await getUserPermissions(db, userId));
  return permissionKeys.every((key) => held.has(key));
}

const FORBIDDEN_BODY = { error: 'forbidden' };

/**
 * Express middleware requiring one capability.
 *
 * Must be mounted AFTER an authentication middleware — it reads
 * `req.user.id` and refuses (401) if there is none, rather than assuming
 * the route was reachable unauthenticated.
 *
 * An unregistered key passed here is a programming error, so it denies
 * every request rather than accidentally allowing them: a typo'd
 * capability name must close a route, not open it.
 */
export function requirePermission(permissionKey, { db = null } = {}) {
  return async (req, res, next) => {
    try {
      if (!isRegisteredPermission(permissionKey)) return res.status(403).json(FORBIDDEN_BODY);
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });
      const allowed = await hasPermission(db ?? pool, userId, permissionKey);
      if (!allowed) return res.status(403).json(FORBIDDEN_BODY);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Express middleware requiring every listed capability. */
export function requireAllPermissions(permissionKeys, { db = null } = {}) {
  return async (req, res, next) => {
    try {
      if (!Array.isArray(permissionKeys) || permissionKeys.length === 0) {
        return res.status(403).json(FORBIDDEN_BODY);
      }
      if (!permissionKeys.every(isRegisteredPermission)) return res.status(403).json(FORBIDDEN_BODY);
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'unauthorized' });
      const allowed = await hasAllPermissions(db ?? pool, userId, permissionKeys);
      if (!allowed) return res.status(403).json(FORBIDDEN_BODY);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Counts accounts currently holding an active capability. Used by the
 * last-manager guard, which must run inside the caller's transaction — so
 * `db` is the transaction client there, never the pool. */
export async function countActiveHolders(db, permissionKey) {
  if (!isRegisteredPermission(permissionKey)) return 0;
  const { rows } = await db.query(
    `select count(*)::int as count
       from account_permissions ap
       join users u on u.id = ap.user_id
      where ap.permission_key = $1
        and ap.is_active = true
        and u.status = 'active'`,
    [permissionKey]
  );
  return rows[0]?.count ?? 0;
}
