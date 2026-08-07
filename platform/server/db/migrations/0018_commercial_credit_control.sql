-- ============================================================================
-- Commercial credit control
--
-- 0017 added `users.credit_limit`. This makes it a CONTROL rather than a
-- figure: something only an authorised person may set, and something the
-- server consults when an order is placed.
--
-- Two additive changes.
--
-- ---------------------------------------------------------------------------
-- 1. A capability of its own: `finance.credit_limit`
-- ---------------------------------------------------------------------------
--
-- Deciding how much a customer may owe is a different authority from recording
-- the money they have paid, and from forgiving a debt. The platform already
-- separates `finance.record` from `finance.credit` for exactly that reason:
-- "we received $4,000" and "we have decided they owe $4,000 less" look
-- identical on a balance and are completely different acts. Setting the
-- ceiling on future exposure is a third act again — it commits Veyora to risk
-- rather than recording something that already happened.
--
-- Widening this CHECK is deliberate friction. The constraint exists so that an
-- unreviewed capability cannot appear at runtime: a new key must be a code
-- change AND a migration, both of which a human reads.
--
-- AS ALWAYS, THIS MIGRATION GRANTS NOTHING. It widens the set of keys that may
-- exist; no row is inserted, so no account gains this capability here. The
-- first grant remains a supervised bootstrap.
--
-- ---------------------------------------------------------------------------
-- 2. `orders.credit_review`
-- ---------------------------------------------------------------------------
--
-- When the server evaluates an order and finds the account's projected
-- exposure above its configured limit, that fact has to be recorded somewhere
-- a human will see, or the order is silently indistinguishable from one that
-- passed a credit check.
--
-- This is deliberately NOT a new order status. The platform has one order state
-- machine and adding a parallel one would be a far larger change than the
-- requirement needs: every screen, filter, report and transition would have to
-- learn about it. Instead the order stays `pending` — which is what it is —
-- and carries a snapshot of the credit decision beside it.
--
-- NULL means no credit decision was needed: either no limit is configured, or
-- the order was within it. The presence of the column is therefore the signal,
-- and an absent snapshot can never be mistaken for a passed check.
--
-- The snapshot records the figures the decision was made on — projected
-- exposure, the limit at that moment, the shortfall, the order total, the
-- currency and the timestamp — so it can be checked later rather than
-- re-derived from data that has since moved.
--
-- Entirely additive: one CHECK widened by replacement, one nullable column, no
-- default, no backfill. No drop, no truncate, no delete, no retype.
-- ============================================================================

alter table account_permissions
  drop constraint if exists account_permissions_permission_key_registered;
alter table account_permissions
  add constraint account_permissions_permission_key_registered
  check (permission_key in (
    'public_content.view',
    'public_content.edit',
    'public_content.publish',
    'permissions.manage',
    'enquiries.view',
    'enquiries.manage',
    'customer_contacts.view',
    'customer_contacts.manage',
    'payments.view',
    'payments.collect',
    'payments.refund',
    'payments.reconcile',
    'finance.invoice',
    'finance.record',
    'finance.credit',
    'finance.credit_limit',
    'finance.reconcile',
    'statements.send'
  ));

alter table orders add column if not exists credit_review jsonb;

comment on column orders.credit_review is
  'Snapshot of the server-side credit evaluation, present ONLY when the order '
  'needs an authorised credit decision. NULL means no decision was required - '
  'either no limit is configured, or the order was within it. An order carrying '
  'this has NOT passed a credit check.';

-- Finding the orders awaiting a credit decision must not scan the table.
-- Partial, so every ordinary order stays outside the index.
create index if not exists orders_credit_review_idx
  on orders (customer_id, created_at desc) where credit_review is not null;
