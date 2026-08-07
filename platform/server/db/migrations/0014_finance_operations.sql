-- ============================================================================
-- Auditable finance operations (Final Handover, Phase 4)
--
-- THE PROBLEM THIS SOLVES
--
-- Money moved through a whole-database row-diff sync. The admin panel held the
-- entire dataset in the browser and posted row-level differences to
-- /admin/sync, and `payments`, `credit_notes`, `invoices` and `users.balance`
-- were all in that path. So:
--
--   * a customer's balance could be set to any number by a browser, with no
--     record of what it was before, no reason, and no reference;
--   * a payment could be created, edited or deleted as an ordinary row;
--   * an invoice's amount could be changed after issue;
--   * a stale tab could post a snapshot taken before a real payment arrived
--     and quietly reverse it.
--
-- None of that produced an audit entry that named the actor, the prior value,
-- the new value and the reason, because a row diff has no such concept.
--
-- WHAT THIS MIGRATION ADDS
--
--   1. `finance_events` — an APPEND-ONLY ledger of every financial mutation,
--      carrying prior value, new value, currency, reference, reason and actor.
--      Blocked from UPDATE and DELETE by a trigger, the same way 0010 made
--      `audit_log` append-only.
--   2. Idempotency keys on `payments` and `credit_notes`, so a double-click or
--      a retried request records the money once.
--   3. Resolution fields on `payment_events`, so a reconciliation exception is
--      closed by a named person with a stated reason rather than by being
--      ignored until it scrolls off a screen.
--   4. Four new capability keys.
--
-- Entirely additive. No column is dropped, no type changed, no default
-- altered, nothing deleted. The sync BLOCK itself is application code
-- (src/admin-data.js), not schema — a database cannot tell which HTTP endpoint
-- a statement came from.
--
-- DELIBERATELY GRANTS NOTHING.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Capabilities
--
-- Three new financial authorities, kept apart for the same reason the payment
-- capabilities are:
--
--   `finance.invoice` — turn an order into a debt the customer owes.
--   `finance.record`  — record money that ARRIVED by some means outside
--                       Stripe: a transfer, a cheque, cash, or a card taken
--                       over the phone under existing policy.
--   `finance.credit`  — reduce what a customer owes WITHOUT money arriving.
--
-- The third is the dangerous one and is why it is not folded into the second.
-- "We received £4,000" and "we have decided they owe £4,000 less" look
-- identical on a balance and are completely different events; the person who
-- keys in bank transfers all day should not be able to forgive a debt.
--
-- `finance.reconcile` closes an exception. Deliberately distinct from
-- `payments.reconcile`, which READS the exception queue: seeing that an event
-- failed and declaring it settled are different acts.
-- ---------------------------------------------------------------------------
alter table account_permissions
  drop constraint if exists account_permissions_permission_key_check;
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
    'finance.reconcile'
  ));

-- ---------------------------------------------------------------------------
-- 2. The append-only financial ledger
--
-- Every governed financial mutation writes one row here, inside the same
-- transaction as the mutation itself. If the mutation rolls back so does its
-- event, and if the event cannot be written the mutation does not happen —
-- which is the point: a financial change with no record of who made it and
-- what it replaced is exactly what this phase exists to remove.
--
-- WHY BOTH THIS AND `audit_log`: `audit_log` is a human-readable activity
-- feed, one text line per event, spanning every part of the platform. This is
-- a STRUCTURED financial record with typed prior/new amounts in minor units,
-- queryable per customer and per invoice, that a bookkeeper can reconcile
-- against. Both are written; neither replaces the other.
-- ---------------------------------------------------------------------------
create table if not exists finance_events (
  id                 text primary key default veyora_id('fev'),

  -- What happened, from a closed set. A new operation means a migration that
  -- widens this CHECK — deliberate friction, so an unreviewed financial event
  -- type cannot appear at runtime.
  event_type         text not null
                     check (event_type in (
                       'invoice.issued',
                       'payment.recorded',
                       'payment.voided',
                       'credit_note.issued',
                       'refund.requested',
                       'refund.settled',
                       'settlement.applied',
                       'reconciliation.resolved')),

  customer_id        text references users(id) on delete set null,
  invoice_id         text references invoices(id) on delete set null,
  payment_id         text references payments(id) on delete set null,
  credit_note_id     text references credit_notes(id) on delete set null,

  -- The MOVEMENT, in minor units. Signed: positive increases what the customer
  -- owes (an invoice), negative decreases it (a payment, a credit note).
  amount_minor       bigint not null default 0,
  currency           text not null default 'USD',

  -- The customer balance before and after, so the ledger reconstructs the
  -- balance independently of the `users.balance` column. If the two ever
  -- disagree, that is discoverable rather than invisible.
  balance_before     numeric(12,2),
  balance_after      numeric(12,2),

  -- Where the money came from or went. A bank reference, a cheque number, a
  -- Stripe PaymentIntent. Required by the application for anything that claims
  -- money moved.
  reference          text not null default '',
  provider_reference text not null default '',

  -- Why. Required by the application for every discretionary act — a credit
  -- note or a void with no stated reason is one nobody can explain later.
  reason             text not null default '',

  -- Attribution. `on delete set null`: losing the account must never rewrite
  -- the fact that somebody did this.
  actor_id           text references users(id) on delete set null,
  actor_name         text not null default '',
  actor_role         text not null default '',

  -- The capability that admitted the request, recorded so an audit can answer
  -- "under what authority?" without inferring it from the event type.
  capability         text not null default '',

  -- Unique per logical operation, so a retried request writes one event.
  idempotency_key    text not null unique,

  created_at         timestamptz not null default now()
);

create index if not exists finance_events_customer_idx
  on finance_events (customer_id, created_at desc);
create index if not exists finance_events_invoice_idx on finance_events (invoice_id);
create index if not exists finance_events_type_idx on finance_events (event_type, created_at desc);
create index if not exists finance_events_created_idx on finance_events (created_at desc);

-- APPEND-ONLY, enforced by the database rather than by convention. Same
-- mechanism 0010 used for audit_log: a financial record that can be edited
-- after the fact is not a record.
create or replace function finance_events_immutable() returns trigger as $$
begin
  raise exception 'finance_events is append-only (% blocked)', tg_op;
end $$ language plpgsql;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 't_finance_events_no_update') then
    create trigger t_finance_events_no_update before update on finance_events
      for each row execute function finance_events_immutable();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 't_finance_events_no_delete') then
    create trigger t_finance_events_no_delete before delete on finance_events
      for each row execute function finance_events_immutable();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Idempotency and provenance on the existing ledgers
--
-- `payments.settlement_key` (0013) covers a Stripe settlement. An OFFLINE
-- payment needs its own key, derived by the server from the customer, amount,
-- method and reference, so keying the same bank transfer in twice is refused
-- rather than doubling a credit.
--
-- `voided_*` rather than a DELETE: a payment recorded in error is reversed
-- with a reason, and the original row stays. Removing it would leave a balance
-- movement nobody can explain.
-- ---------------------------------------------------------------------------
alter table payments
  add column if not exists idempotency_key text,
  add column if not exists recorded_by text references users(id) on delete set null,
  add column if not exists notes text not null default '',
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by text references users(id) on delete set null,
  add column if not exists void_reason text not null default '';

create unique index if not exists payments_idempotency_idx
  on payments (idempotency_key) where idempotency_key is not null;

-- A void must be explained and attributed. Same shape as 0009's handling
-- constraint: the state that asserts something cannot exist without the
-- evidence for it.
alter table payments
  drop constraint if exists payments_void_attributed;
alter table payments
  add constraint payments_void_attributed
  check (voided_at is null or void_reason <> '');

alter table credit_notes
  add column if not exists currency text not null default 'USD',
  add column if not exists amount_minor bigint,
  add column if not exists invoice_id text references invoices(id) on delete set null,
  add column if not exists reference text not null default '',
  add column if not exists issued_by text references users(id) on delete set null,
  add column if not exists idempotency_key text;

create unique index if not exists credit_notes_idempotency_idx
  on credit_notes (idempotency_key) where idempotency_key is not null;
create index if not exists credit_notes_customer_idx on credit_notes (customer_id, issued_on desc);

-- A credit note reduces a debt without money arriving, so a reason is not
-- optional. Existing rows default `reason` to '' and are grandfathered by the
-- `issued_by is null` clause: the constraint applies to rows this phase's API
-- creates, and does not retroactively invalidate history it cannot explain.
alter table credit_notes
  drop constraint if exists credit_notes_reasoned;
alter table credit_notes
  add constraint credit_notes_reasoned
  check (issued_by is null or reason <> '');

-- ---------------------------------------------------------------------------
-- 4. Closing a reconciliation exception
--
-- An exception that is merely READ is not resolved. These fields record who
-- decided it was settled and what they concluded, so the queue empties by
-- decision rather than by scrolling.
-- ---------------------------------------------------------------------------
alter table payment_events
  add column if not exists resolved_by text references users(id) on delete set null,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution_note text not null default '';

alter table payment_events
  drop constraint if exists payment_events_status_valid;
alter table payment_events
  add constraint payment_events_status_valid
  check (status in ('received', 'processed', 'ignored', 'failed', 'resolved'));

alter table payment_events
  drop constraint if exists payment_events_resolution_explained;
alter table payment_events
  add constraint payment_events_resolution_explained
  check (status <> 'resolved' or (resolved_at is not null and resolution_note <> ''));

-- ---------------------------------------------------------------------------
-- 5. What is deliberately NOT here
--
--   * No DELETE path for a payment, a credit note or a finance event. A
--     payment recorded in error is VOIDED with a reason; the row stays.
--   * No column that lets a client assert a Stripe payment succeeded. That
--     remains the exclusive result of a verified webhook (0013).
--   * No change to `users.balance` itself. It stays where it is and keeps its
--     meaning; what changes is that only governed, audited code may move it.
--     The block on the generic sync path is application code, because a
--     database cannot tell which endpoint a statement arrived from.
-- ---------------------------------------------------------------------------
