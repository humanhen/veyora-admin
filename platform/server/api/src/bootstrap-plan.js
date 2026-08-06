/* Permission-bootstrap plan validation (Security Hardening Phase 5).
 *
 * The first `permissions.manage` grant cannot come from the API — the API
 * requires that capability to use it — and must not come from a migration,
 * because a migration that grants authority runs unreviewed on every deploy.
 * It is therefore a deliberate, supervised database operation, documented in
 * 19_ACCOUNT_PERMISSION_SYSTEM.md §8.
 *
 * The risk in a hand-run SQL operation is not the SQL. It is granting the
 * wrong account, granting to a disabled one, granting to a shared login, or
 * leaving exactly one holder so that losing them locks everybody out.
 *
 * This module checks a PROPOSED bootstrap against those failure modes and
 * produces a reviewable plan. It is pure:
 *
 *   - no database driver is imported, here or by the CLI that wraps it;
 *   - it takes the candidate accounts as an argument;
 *   - it produces SQL as TEXT for a human to read and run, and executes
 *     nothing.
 *
 * IT CANNOT PERFORM A BOOTSTRAP. That is the point.
 */

export const MANAGE_CAPABILITY = 'permissions.manage';

/** Two, so losing one holder does not lock everybody out of permission
 *  administration. The API's last-manager guard already refuses to revoke the
 *  final holder, which is a trap if there has only ever been one. */
export const MIN_MANAGERS = 2;

/** Signals that an account is shared rather than a single person's. A shared
 *  login makes every audit entry unattributable, and `permissions.manage` is
 *  the last capability that should be behind one. */
const SHARED_ACCOUNT_HINTS = [
  'admin', 'office', 'shared', 'team', 'info', 'support', 'sales',
  'accounts', 'warehouse', 'staff', 'test', 'demo', 'temp',
];

export class BootstrapPlanError extends Error {}

/* ---------------------------------------------------------------------------
   Validation
   --------------------------------------------------------------------------- */

function looksShared(account) {
  const haystack = `${account.username ?? ''} ${account.email ?? ''}`.toLowerCase();
  const local = haystack.split('@')[0];
  return SHARED_ACCOUNT_HINTS.filter((hint) => {
    const bounded = new RegExp(`(^|[^a-z])${hint}([^a-z]|$)`);
    return bounded.test(local);
  });
}

/**
 * Validates a proposed bootstrap.
 *
 * @param accounts candidate account rows — `{ id, username, email, role,
 *   status }`. Supplied by the caller; nothing is read from a database.
 * @param selectedIds the ids proposed to receive `permissions.manage`.
 * @param existingHolders ids that already hold it, if any.
 * @returns {{ok, plan, blocking, warnings, checklist}}
 */
export function validateBootstrapPlan({ accounts = [], selectedIds = [], existingHolders = [] } = {}) {
  const blocking = [];
  const warnings = [];

  if (!Array.isArray(accounts) || !Array.isArray(selectedIds)) {
    throw new BootstrapPlanError('accounts and selectedIds must both be arrays.');
  }

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const selected = [];
  const seen = new Set();

  for (const id of selectedIds) {
    if (seen.has(id)) {
      blocking.push({ code: 'DUPLICATE_SELECTION', message: `${id} is selected more than once.` });
      continue;
    }
    seen.add(id);

    const account = byId.get(id);
    if (!account) {
      blocking.push({ code: 'UNKNOWN_ACCOUNT', message: `No account matches id ${id}.` });
      continue;
    }
    if (account.status !== 'active') {
      blocking.push({
        code: 'INACTIVE_ACCOUNT',
        message: `${id} (${account.username ?? 'no username'}) has status "${account.status}". `
          + 'A disabled or pending account resolves no capability, so the grant would be inert.',
      });
      continue;
    }

    const sharedHints = looksShared(account);
    if (sharedHints.length) {
      warnings.push({
        code: 'POSSIBLY_SHARED_ACCOUNT',
        message: `${id} (${account.username ?? account.email ?? 'unnamed'}) looks like a shared `
          + `login (matched: ${sharedHints.join(', ')}). Every audit entry it writes is `
          + 'unattributable. Confirm one named person holds it.',
      });
    }

    selected.push(account);
  }

  /* Ambiguity is blocking, not a warning: a bootstrap run against the wrong
     account is exactly the mistake this exists to prevent, and duplicated
     usernames are how it happens. */
  const usernameCounts = new Map();
  for (const account of accounts) {
    const key = String(account.username ?? '').trim().toLowerCase();
    if (!key) continue;
    usernameCounts.set(key, (usernameCounts.get(key) ?? 0) + 1);
  }
  for (const account of selected) {
    const key = String(account.username ?? '').trim().toLowerCase();
    if (key && usernameCounts.get(key) > 1) {
      blocking.push({
        code: 'AMBIGUOUS_USERNAME',
        message: `More than one account has username "${account.username}". `
          + 'Identify the intended account by id, and resolve the duplication first.',
      });
    }
  }

  const totalAfter = new Set([...existingHolders, ...selected.map((a) => a.id)]).size;
  if (totalAfter < MIN_MANAGERS) {
    blocking.push({
      code: 'TOO_FEW_MANAGERS',
      message: `The plan leaves ${totalAfter} active permission manager(s). At least ${MIN_MANAGERS} `
        + 'are required, because the API refuses to revoke the last one — with a single holder, '
        + 'losing that account locks everybody out with no route back except manual SQL.',
    });
  }

  const ok = blocking.length === 0;

  return {
    ok,
    plan: selected.map((a) => ({
      id: a.id,
      username: a.username ?? null,
      email: a.email ?? null,
      role: a.role ?? null,
      status: a.status,
      capability: MANAGE_CAPABILITY,
    })),
    blocking,
    warnings,
    checklist: reviewChecklist(),
  };
}

/** The review checklist, as data so a script and a document cannot drift. */
export function reviewChecklist() {
  return [
    'Each selected account belongs to one named person, not a shared login.',
    'Each holder is authorised to decide who may publish to the public website.',
    `At least ${MIN_MANAGERS} active holders exist after the bootstrap.`,
    'Every selected account is active, and its id was confirmed by a SELECT before granting.',
    'The grant runs inside a transaction, and the verification query is run in the same session.',
    'The rollback statement is to hand before the grant is executed.',
    'No capability other than permissions.manage is granted by this operation.',
    'The operation is performed by a named person on a supervised connection, and recorded.',
  ];
}

/* ---------------------------------------------------------------------------
   Rendering — text for a human, never an executed statement
   --------------------------------------------------------------------------- */

/** Escapes a value for a single-quoted SQL literal. The ids come from an
 *  operator-supplied fixture rather than a request, but rendering SQL without
 *  escaping is a habit worth not having. */
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Renders the bootstrap as SQL TEXT for review.
 *
 * Nothing here executes. The output is meant to be read, checked against the
 * checklist, and run by a person on a supervised connection.
 */
export function renderBootstrapSql(plan) {
  if (!plan.ok) {
    throw new BootstrapPlanError('Refusing to render SQL for a plan with blocking findings.');
  }
  const ids = plan.plan.map((p) => p.id);

  const lines = [
    '-- Permission bootstrap — REVIEW BEFORE RUNNING.',
    '-- Generated from a local fixture. Nothing has been executed.',
    '-- Procedure and warnings: docs/public-website-rebuild/19_ACCOUNT_PERMISSION_SYSTEM.md §8',
    '',
    'begin;',
    '',
    '-- 1. Confirm these are the intended accounts BEFORE granting.',
    `select id, username, email, role, status from users where id in (${ids.map(lit).join(', ')});`,
    '',
    '-- 2. Grant permissions.manage. Self-attributed: this grant has no prior',
    '--    grantor, and recording that honestly is better than inventing one.',
  ];

  for (const entry of plan.plan) {
    lines.push(
      `insert into account_permissions (user_id, permission_key, is_active, granted_by, granted_at)`,
      `values (${lit(entry.id)}, ${lit(MANAGE_CAPABILITY)}, true, ${lit(entry.id)}, now())`,
      `on conflict (user_id, permission_key)`,
      `do update set is_active = true, granted_at = now(), revoked_by = null, revoked_at = null;`,
      ''
    );
  }

  lines.push(
    '-- 3. Verify inside the SAME transaction, before committing.',
    "select u.username, ap.permission_key, ap.is_active, ap.granted_at",
    '  from account_permissions ap join users u on u.id = ap.user_id',
    ` where ap.permission_key = ${lit(MANAGE_CAPABILITY)} and ap.is_active;`,
    '',
    `-- Expect exactly ${ids.length} row(s), naming the intended account(s).`,
    '-- If anything is unexpected: rollback;   otherwise: commit;',
    '',
    '-- Rollback AFTER commit (revoke, never delete — the mistake and its',
    '-- correction both stay on record):',
    '-- update account_permissions set is_active = false,',
    "--        revoked_by = '<ACTOR_USER_ID>', revoked_at = now()',",
    ` --  where user_id in (${ids.map(lit).join(', ')}) and permission_key = ${lit(MANAGE_CAPABILITY)};`
  );

  return lines.join('\n');
}
