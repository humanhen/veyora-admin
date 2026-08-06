/* Server-derived admin action discovery (warehouse interface correction).
 *
 * WHY THIS EXISTS
 *
 * The security hardening workstream correctly stopped `warehouse` reaching
 * `POST /admin/sync`. The admin panel did not know that: it is a
 * whole-database editor whose every screen mutates a local snapshot and calls
 * `DB.save()`, which debounces into one sync. A warehouse login therefore got
 * a 403 on save — and, worse, `pushSync` retried it every five seconds
 * forever, with a toast each time.
 *
 * The panel needs to know what this session may actually do. The wrong way to
 * supply that is a client-side `if (role === 'warehouse')` sprinkled through
 * nine page files: it drifts from the server, and it teaches the next
 * contributor that the browser decides authority.
 *
 * So the server says. This module derives the answer from the SAME constants
 * the routes enforce with, and the panel treats it as a rendering hint only —
 * every request is still authorised server-side.
 *
 * IT GRANTS NOTHING. It is a read of what the caller could already do. If
 * this endpoint returned every action set to true, the API would refuse the
 * requests exactly as it does now.
 */

/** Actions the admin panel can gate a control on.
 *
 *  Deliberately named for the WORKFLOW, not the endpoint: the panel should ask
 *  "may I adjust stock", not "may I POST to this path". That keeps the mapping
 *  honest if a route later moves. */
export const ADMIN_ACTIONS = Object.freeze([
  /* The whole-database row sync. Admin only — this is the finding SEC-002
     closed, and the single most consequential flag here. */
  'sync.write',

  /* Narrow warehouse workflows, backed by dedicated routes. */
  'inventory.adjust',
  'inventory.transfer',
  'orders.fulfil',
  'backorders.convert',

  /* Commercial and administrative surfaces. */
  'orders.money',
  'users.manage',
  'catalogue.edit',
  'settings.edit',
  'finance.manage',
  'imports.run',
]);

/* Which roles hold which action. This mirrors the guards the routes apply:
 *
 *   - `sync.write`        routes/admin.js POST /sync — admin only
 *   - `inventory.*`       routes/admin-inventory.js STOCK_ROLES
 *   - `orders.fulfil`     routes/admin.js PATCH /orders/:id — admin+warehouse
 *   - `orders.money`      routes/admin.js isFinancialActor — admin only
 *   - everything else     reached only through the sync path, so admin only
 *
 * A role absent from a list holds nothing by default: this map is an
 * allowlist, and an unknown role gets an empty action set rather than a
 * permissive one. */
const ROLE_ACTIONS = Object.freeze({
  admin: Object.freeze([...ADMIN_ACTIONS]),
  warehouse: Object.freeze([
    'inventory.adjust',
    'inventory.transfer',
    'orders.fulfil',
    'backorders.convert',
  ]),
});

/**
 * The actions a session may perform.
 *
 * @param user the AUTHENTICATED user. Nothing is read from a request body,
 *   header or query — a client cannot assert an action it does not hold.
 * @returns a fresh object with every action as an explicit boolean, so a
 *   missing key can never read as "allowed" in the browser.
 */
export function actionsForUser(user) {
  /* A non-active account holds nothing, mirroring requireAuth and the
     capability resolver. `requireAuth` already refuses these, so this is
     defence in depth rather than the only check. */
  const held = (user && user.status === 'active' && ROLE_ACTIONS[user.role]) || [];
  const actions = {};
  for (const key of ADMIN_ACTIONS) actions[key] = held.includes(key);
  return actions;
}

/** The complete discovery payload. Deliberately narrow: the caller's own role
 *  and its own actions. No other account, no user record, no capability grant
 *  attribution, nothing about anybody else. */
export function describeAccess(user) {
  return {
    role: user?.role ?? null,
    actions: actionsForUser(user),
  };
}
