-- ============================================================================
-- Credit review approval: `finance.credit_review`
--
-- 0018 made the credit limit a control and gave the server the ability to
-- detect an order that would take an account over it. Detection without a way
-- to resolve it leaves those orders stuck, so this adds the capability that
-- may approve or decline ONE such order.
--
-- WHY IT IS NOT `finance.credit_limit`.
--
-- Raising a customer's ceiling and letting a single order through above the
-- existing ceiling are different responsibilities with different consequences.
-- The first is a standing commitment that applies to every future order; the
-- second is a one-off judgement about one order that changes nothing
-- afterwards. A salesperson trusted to wave through a $4,000 order for a good
-- customer is not thereby trusted to decide that customer may permanently owe
-- $40,000 — and somebody who sets limits centrally may have no view at all on
-- whether one particular order should go out today.
--
-- The platform already draws exactly this distinction between `finance.record`
-- and `finance.credit`.
--
-- APPROVING AN EXCEPTION DOES NOT RAISE THE LIMIT. That is enforced in the
-- application: the resolution writes only to `orders.credit_review` and never
-- touches `users.credit_limit`.
--
-- GRANTS NOTHING. This widens the set of keys that may exist; no row is
-- inserted, so no account gains this capability here. The first grant remains
-- a supervised bootstrap.
--
-- Entirely additive: one CHECK widened by replacement. No column, no drop, no
-- truncate, no delete, no retype, no backfill. The review record itself needs
-- no schema change — `orders.credit_review` is already jsonb, and the
-- resolution fields were part of its shape from the start.
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
    'finance.credit_review',
    'finance.reconcile',
    'statements.send'
  ));
