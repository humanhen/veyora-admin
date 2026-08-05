-- ============================================================================
-- Account-specific capability permissions (B2.4P)
--
-- Until now the platform had role-based access control only: `users.role`, a
-- single text enum. Every account with role 'admin' had identical authority.
-- Management requires specific permissions for specific accounts, which needs
-- persistent per-account grants — this table.
--
-- Entirely additive: one new table, no change to `users` or to any existing
-- column, constraint or role meaning. `users.role` keeps working exactly as it
-- does today for every route that already uses it; this table is consulted
-- only by the capability-gated routes introduced in B2.4P.
--
-- As with every migration since go-live, this file only runs on a completely
-- fresh database volume (docker-entrypoint-initdb.d). An existing database
-- picks the change up through api/src/migrate.js's ensureSchema(), which
-- mirrors every statement below idempotently. See 0007 and migrate.js for the
-- established convention this follows.
--
-- DELIBERATELY GRANTS NOTHING. There is no INSERT anywhere in this file: no
-- account — including existing administrators — receives any capability from
-- the migration. The first `permissions.manage` grant is a separately
-- reviewed bootstrap operation documented in
-- docs/public-website-rebuild/19_ACCOUNT_PERMISSION_SYSTEM.md, deliberately
-- not automated here, because a migration that silently hands every admin the
-- ability to publish public content would defeat the requirement it exists to
-- serve.
-- ============================================================================

create table if not exists account_permissions (
  id              text primary key default veyora_id('perm'),

  -- The account the grant belongs to. `on delete cascade`: a grant is owned
  -- data with no meaning once the account is gone, and an orphaned row here
  -- would be an authority record pointing at nothing.
  user_id         text not null references users(id) on delete cascade,

  -- The exact capability key. Constrained to the registered set: an
  -- unregistered or wildcard key cannot be stored at all, so the database
  -- agrees with src/permission-registry.js rather than trusting callers.
  -- Adding a capability later means an additive migration that widens this
  -- CHECK — deliberate friction, so capabilities cannot be invented at
  -- runtime.
  permission_key  text not null
                  check (permission_key in (
                    'public_content.view',
                    'public_content.edit',
                    'public_content.publish',
                    'permissions.manage'
                  )),

  -- Whether the grant currently confers authority. Revocation sets this
  -- false and stamps revoked_by/revoked_at rather than deleting the row, so
  -- the history of who granted what, and who took it away, survives.
  is_active       boolean not null default false,

  -- Attribution. `on delete set null` (not cascade): losing the granting
  -- administrator's account must never delete the grant itself or rewrite
  -- the fact that a grant happened.
  granted_by      text references users(id) on delete set null,
  granted_at      timestamptz,
  revoked_by      text references users(id) on delete set null,
  revoked_at      timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One row per (account, capability). Combined with the revoke-in-place
  -- model above, this makes "two active grants of the same capability to the
  -- same account" structurally impossible — there is only ever one row to
  -- flip, so authority cannot be duplicated or half-revoked.
  constraint account_permissions_user_key_unique unique (user_id, permission_key),

  -- An active grant must record who granted it and when; a revoked grant must
  -- record who revoked it and when. This keeps the audit trail complete by
  -- construction rather than by application discipline.
  constraint account_permissions_active_attributed
    check (is_active = false or granted_at is not null),
  constraint account_permissions_revocation_attributed
    check (is_active = true or revoked_at is null or revoked_by is not null)
);

-- Resolution reads by account, and the last-manager check counts active
-- holders of one capability; both are covered here.
create index if not exists account_permissions_user_idx
  on account_permissions (user_id);
create index if not exists account_permissions_active_key_idx
  on account_permissions (permission_key) where is_active;

-- Reuses touch_updated_at(), defined once in 0001_schema.sql.
create trigger t_account_permissions_touch
  before update on account_permissions
  for each row execute function touch_updated_at();
