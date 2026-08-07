-- ============================================================================
-- Customer credit limit (client feedback item G)
--
-- The customer's Balance & Payments page needs to show the account's credit
-- limit. Nothing in the platform recorded one, so this adds it.
--
-- NULL IS NOT UNLIMITED. It means "nobody has set a credit limit for this
-- account", and every surface must say exactly that. The distinction matters
-- because the two readings are opposites: treating an unset limit as unlimited
-- would silently grant infinite credit to every account that already exists,
-- which is all of them the moment this runs. The storefront renders "Credit
-- limit not configured" and no headroom figure, and the API never invents one.
--
-- A CUSTOMER MAY NEVER SET THIS. It is a commercial decision made by Veyora
-- about the customer, in the same family as `pricing` and `payment_terms`. The
-- column is deliberately absent from the admin sync collection in `shape.js`,
-- so the generic row-diff sync cannot write it either: a credit limit should
-- move through a deliberate, audited action, not through a whole-row diff
-- posted by a browser that happened to have the account loaded.
--
-- Entirely additive: one nullable column with no default and no backfill. No
-- drop, no truncate, no delete, no retype, no default change. Every existing
-- row reads NULL, which is the honest answer — no limit has been decided.
-- ============================================================================

alter table users add column if not exists credit_limit numeric(12,2);

comment on column users.credit_limit is
  'Credit limit in the account currency. NULL means NOT CONFIGURED, never unlimited. '
  'Set by Veyora staff through an audited action; never by the customer, and never '
  'through the generic admin sync.';
