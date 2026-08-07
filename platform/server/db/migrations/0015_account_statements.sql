-- ============================================================================
-- Account statements (Final Handover, Phase 6)
--
-- WHAT THIS REPLACES
--
-- The admin panel's "Send to Customer" button did this:
--
--     DB.audit('statement.send', u.business, 'Emailed to ' + u.email);
--     toast('Statement emailed to ' + u.email);
--
-- Nothing was generated, nothing was attached, and nothing was sent. The audit
-- log recorded a delivery that never happened, which is worse than no button:
-- a false record is consulted later and believed.
--
-- WHAT IS ADDED
--
--   1. `account_statements` — one row per generated statement, carrying the
--      period, the currency, the opening and closing balances IN MINOR UNITS,
--      who generated it, who it was addressed to and why, and the outbox
--      notification that carries it.
--   2. `statements.send` — one new capability. Generating a statement is
--      reading payment state, which `payments.view` already describes;
--      SENDING one to a customer is an outward-facing act and gets its own key.
--
-- NO SCHEDULING. There is no cron column, no `next_run_at`, no recurrence
-- rule. Automatic monthly statements are explicitly out of scope, and a column
-- anticipating them would be an invitation to wire one up.
--
-- THE PDF IS NOT STORED. The statement's INPUTS are recorded, and the document
-- is regenerated deterministically from them. That keeps a customer's full
-- financial history out of a second place, and means a corrected brand
-- configuration improves every historical statement rather than none of them.
--
-- Entirely additive. DELIBERATELY GRANTS NOTHING.
-- ============================================================================

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
    'finance.reconcile',
    'statements.send'
  ));

create table if not exists account_statements (
  id                   text primary key default veyora_id('stm'),

  customer_id          text not null references users(id) on delete cascade,

  -- The period, inclusive of both ends. Stored as dates rather than
  -- timestamps: a statement covers days, and a timezone on a period boundary
  -- is a way for two people to disagree about which month a payment fell in.
  period_from          date not null,
  period_to            date not null,

  -- ONE CURRENCY PER STATEMENT. A running balance that mixes USD and EUR is
  -- arithmetic nobody can defend, so a customer with activity in two
  -- currencies gets two statements. This column is what makes that explicit
  -- rather than implied.
  currency             text not null,

  opening_minor        bigint not null,
  closing_minor        bigint not null,
  line_count           int not null default 0,

  -- Who generated it, and when. `on delete set null`: losing the account must
  -- never rewrite the fact that a statement was produced.
  generated_at         timestamptz not null default now(),
  generated_by         text references users(id) on delete set null,

  -- Delivery. 'draft' is a statement that was generated and previewed but not
  -- sent — a real and common state, not a failure.
  status               text not null default 'draft'
                       check (status in ('draft', 'queued', 'sent', 'failed', 'cancelled')),

  -- WHO it was addressed to, and WHY that address was chosen. The reason is
  -- stored because "why did this go to the owner rather than accounts
  -- payable?" is asked months later, and reconstructing it from the contact
  -- table as it stands then would give the wrong answer.
  recipient_contact_id text references customer_contacts(id) on delete set null,
  recipient_address    text not null default '',
  recipient_reason     text not null default ''
                       check (recipient_reason in (
                         '', 'accounts_payable_contact', 'primary_contact',
                         'account_email', 'explicit_override')),

  -- The outbox row that carries it. Delivery state lives THERE, not here:
  -- duplicating it would create two answers to "was it sent?".
  notification_id      text references notification_outbox(id) on delete set null,

  sent_at              timestamptz,
  last_error           text not null default '',

  -- Server-derived. Regenerating the same period for the same customer on the
  -- same day reuses the row rather than creating a second one.
  idempotency_key      text not null unique,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- A period must run forwards.
  constraint account_statements_period_ordered check (period_from <= period_to),

  -- A statement that claims to have been sent must say where it went. Same
  -- principle as the outbox's delivered_evidenced and the invoice's
  -- paid_evidenced: the state asserting something happened cannot be reached
  -- without the evidence for it.
  constraint account_statements_sent_evidenced
    check (status <> 'sent' or (sent_at is not null and recipient_address <> ''))
);

create index if not exists account_statements_customer_idx
  on account_statements (customer_id, period_to desc);
create index if not exists account_statements_status_idx
  on account_statements (status) where status in ('queued', 'failed');

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 't_account_statements_touch') then
    create trigger t_account_statements_touch before update on account_statements
      for each row execute function touch_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The outbox learns about statements
--
-- `notification_outbox.source_type` is free text with an index, so no change
-- is needed there. What DOES change is that a statement notification carries
-- an ATTACHMENT, which the worker resolves at send time by regenerating the
-- PDF from the statement row. Nothing binary is stored.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- What is deliberately NOT here
--
--   * No schedule, recurrence or next-run column. Automatic monthly statements
--     are out of scope and a column anticipating them invites wiring one up.
--   * No stored PDF. The inputs are recorded; the document is regenerated
--     deterministically.
--   * No 'sent' status a route can set directly. A statement becomes 'sent'
--     only when its outbox notification is confirmed delivered by a provider.
-- ---------------------------------------------------------------------------
