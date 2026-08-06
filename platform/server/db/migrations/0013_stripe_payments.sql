-- ============================================================================
-- Stripe invoice payment foundation (Final Handover, Phase 3)
--
-- WHAT THIS ADDS AND WHAT IT DELIBERATELY DOES NOT CHANGE
--
-- The approved flow is: order → Veyora invoice → THE CUSTOMER REMAINS ON
-- ACCOUNT TERMS → an authorised user creates a Stripe-hosted payment session →
-- the customer follows the secure link → a SIGNED WEBHOOK confirms payment →
-- Veyora records settlement transactionally.
--
-- Paying online is therefore an OPTION added beside account terms, never a
-- precondition for ordering. Nothing here touches `orders`, the checkout path,
-- or the existing invoicing route's behaviour. A deployment with no Stripe
-- configuration behaves exactly as it does today.
--
-- WHY `invoices.status` IS NOT REUSED
--
-- `invoices.status` exists and defaults to 'paid', alongside
-- `provider = 'Green Invoice'`. That pair records something about the LEGACY
-- external invoicing arrangement, not about whether Veyora collected money.
-- Overloading it would make "the external system issued this" and "a customer
-- paid us" indistinguishable — the same mistake 0009 avoided when it refused
-- to overload `form_submissions.delivery_state`.
--
-- So settlement gets its own column, `settlement_state`, whose default —
-- 'on_terms' — is a true statement about every existing row: the invoice is
-- outstanding on account terms and Veyora has collected nothing through a
-- payment provider. No back-fill is needed and no row moves.
--
-- MONEY IS STORED IN MINOR UNITS ON EVERY NEW COLUMN
--
-- `amount_minor bigint`, not `numeric`. Stripe speaks minor units, and every
-- conversion between representations is an opportunity to be out by a factor
-- of a hundred on somebody's money. The existing `numeric(12,2)` columns are
-- untouched; the new ones hold exactly what the provider holds, so the
-- verification "does Stripe's amount equal ours?" is an integer comparison.
--
-- Entirely additive. No column is dropped, no type is changed, no existing
-- default is altered, nothing is deleted.
--
-- As with every migration since go-live, this file only runs on a completely
-- fresh database volume. An existing database picks it up through
-- api/src/migrate.js's ensureSchema(), which mirrors every statement below.
--
-- DELIBERATELY GRANTS NOTHING. There is no INSERT into account_permissions
-- anywhere in this file. No account receives any payment capability from this
-- migration — least of all `payments.refund`, which moves money out.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Widen the capability CHECK
--
-- Four separate capabilities, because these are four genuinely different
-- authorities. Seeing that an invoice was paid, asking a customer to pay,
-- sending money back, and correcting the books are not the same job, and the
-- person who does one frequently must not thereby be able to do the others.
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
    'payments.reconcile'
  ));

-- ---------------------------------------------------------------------------
-- 2. Settlement state on invoices
-- ---------------------------------------------------------------------------
alter table invoices
  -- Every existing row is, correctly, 'on_terms': outstanding on account
  -- terms, with nothing collected through a payment provider.
  add column if not exists settlement_state text not null default 'on_terms',
  -- The currency the invoice is denominated in. 'USD' is the platform's base
  -- currency (src/currency.js) and is true of every existing row.
  add column if not exists settlement_currency text not null default 'USD',
  -- Total minor units confirmed settled by a provider. Never written by a
  -- browser redirect; only by a verified webhook.
  add column if not exists amount_settled_minor bigint not null default 0,
  add column if not exists amount_refunded_minor bigint not null default 0,
  add column if not exists settled_at timestamptz,
  add column if not exists settlement_reference text not null default '';

alter table invoices
  drop constraint if exists invoices_settlement_state_valid;
alter table invoices
  add constraint invoices_settlement_state_valid
  check (settlement_state in ('on_terms', 'processing', 'paid', 'refunded', 'void'));

-- A settled invoice must carry evidence. Same principle as the notification
-- outbox's `delivered_evidenced`: the state that asserts money arrived cannot
-- be reached without the provider reference that proves it, so no code path —
-- including a future one — can mark an invoice paid on a hunch.
alter table invoices
  drop constraint if exists invoices_paid_evidenced;
alter table invoices
  add constraint invoices_paid_evidenced
  check (settlement_state <> 'paid'
         or (settled_at is not null and settlement_reference <> '' and amount_settled_minor > 0));

-- Refunds cannot exceed what was settled. An arithmetic slip here is money.
alter table invoices
  drop constraint if exists invoices_refund_within_settled;
alter table invoices
  add constraint invoices_refund_within_settled
  check (amount_refunded_minor >= 0 and amount_refunded_minor <= amount_settled_minor);

create index if not exists invoices_settlement_state_idx
  on invoices (settlement_state) where settlement_state <> 'on_terms';

-- ---------------------------------------------------------------------------
-- 3. Payment sessions
--
-- One row per hosted payment attempt. The row is created BEFORE the provider
-- is contacted and carries the server-generated idempotency key, so a
-- duplicate request finds the existing row rather than creating a second
-- session for the same invoice.
-- ---------------------------------------------------------------------------
create table if not exists payment_sessions (
  id                     text primary key default veyora_id('ps'),

  invoice_id             text not null references invoices(id) on delete cascade,
  customer_id            text references users(id) on delete set null,

  provider               text not null default 'stripe' check (provider in ('stripe')),

  -- 'created' is the moment before the provider answered. A row stuck there is
  -- a request that failed mid-flight, and is visible as a reconciliation
  -- exception rather than silently absent.
  status                 text not null default 'created'
                         check (status in ('created', 'open', 'completed',
                                           'expired', 'cancelled', 'failed')),

  -- THE SERVER'S amount. Never supplied by a customer, and compared against
  -- what the provider reports before anything is marked settled.
  amount_minor           bigint not null check (amount_minor > 0),
  currency               text not null,

  provider_session_id    text not null default '',
  provider_payment_intent text not null default '',
  -- The customer-facing hosted link. Not a secret key, but bearer-ish and
  -- short-lived, so it is never rendered on a public page and never logged.
  hosted_url             text not null default '',

  -- Server-generated, unique. This is what makes a double-click safe: the
  -- second request collides here rather than opening a second session.
  idempotency_key        text not null unique,

  -- Who asked for the link. Null for a customer paying their own invoice —
  -- attribution there is `customer_id`.
  requested_by           text references users(id) on delete set null,

  expires_at             timestamptz,
  completed_at           timestamptz,
  last_error             text not null default '',

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint payment_sessions_completed_evidenced
    check (status <> 'completed' or (completed_at is not null and provider_payment_intent <> ''))
);

-- AT MOST ONE LIVE SESSION PER INVOICE. A partial unique index rather than a
-- check-then-insert: two concurrent requests cannot both read "no open session"
-- and both create one, which would give the customer two links and Veyora two
-- ways to be paid twice for the same invoice.
create unique index if not exists payment_sessions_one_live_idx
  on payment_sessions (invoice_id) where status in ('created', 'open');

create index if not exists payment_sessions_invoice_idx
  on payment_sessions (invoice_id, created_at desc);
create unique index if not exists payment_sessions_provider_session_idx
  on payment_sessions (provider_session_id) where provider_session_id <> '';
create index if not exists payment_sessions_intent_idx
  on payment_sessions (provider_payment_intent) where provider_payment_intent <> '';

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 't_payment_sessions_touch') then
    create trigger t_payment_sessions_touch before update on payment_sessions
      for each row execute function touch_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Provider events — the deduplication ledger
--
-- Stripe retries. It also delivers out of order. Both are normal, and both
-- mean the same event can arrive more than once and a later event can arrive
-- before an earlier one.
--
-- `provider_event_id` is UNIQUE, so the second delivery of an event collides
-- on insert and is acknowledged without being processed again. That is the
-- whole deduplication mechanism: one constraint, enforced by the database,
-- rather than an application-level "have I seen this?" that races with itself.
--
-- THE RAW PAYLOAD IS NOT STORED. A Stripe event carries customer names,
-- addresses and card metadata. What is kept is an allowlisted summary the
-- application built — enough to reconcile, and nothing that turns this table
-- into a second, ungoverned copy of a customer's payment details.
-- ---------------------------------------------------------------------------
create table if not exists payment_events (
  id                  text primary key default veyora_id('pev'),

  provider            text not null default 'stripe' check (provider in ('stripe')),
  provider_event_id   text not null unique,
  event_type          text not null,

  -- What happened to it here. 'ignored' is a real, successful outcome: an
  -- event outside the allowlist is acknowledged so the provider stops
  -- retrying, and recorded so nobody has to guess whether it arrived.
  status              text not null default 'received'
                      check (status in ('received', 'processed', 'ignored', 'failed')),

  invoice_id          text references invoices(id) on delete set null,
  payment_session_id  text references payment_sessions(id) on delete set null,

  amount_minor        bigint,
  currency            text not null default '',
  summary             jsonb not null default '{}',
  last_error          text not null default '',

  received_at         timestamptz not null default now(),
  processed_at        timestamptz
);

create index if not exists payment_events_invoice_idx on payment_events (invoice_id);
create index if not exists payment_events_status_idx
  on payment_events (status) where status in ('received', 'failed');
create index if not exists payment_events_received_idx on payment_events (received_at desc);

-- ---------------------------------------------------------------------------
-- 5. Link the existing payments ledger to invoices
--
-- `payments` already exists, already has a 'stripe' method and a
-- `stripe_payment_intent` column, and is what the finance screens read. It is
-- EXTENDED rather than replaced: a second payments table would mean two
-- answers to "what has this customer paid".
-- ---------------------------------------------------------------------------
alter table payments
  add column if not exists invoice_id text references invoices(id) on delete set null,
  add column if not exists currency text not null default 'USD',
  add column if not exists amount_minor bigint,
  add column if not exists payment_session_id text references payment_sessions(id) on delete set null,
  -- Unique per provider settlement, so a replayed webhook cannot record the
  -- same money twice. Nullable: manual transfers and cheques have no key.
  add column if not exists settlement_key text;

create unique index if not exists payments_settlement_key_idx
  on payments (settlement_key) where settlement_key is not null;
create index if not exists payments_invoice_idx
  on payments (invoice_id) where invoice_id is not null;

-- ---------------------------------------------------------------------------
-- 6. Refunds
--
-- Their own table rather than a negative payment: a refund has a reason, an
-- authoriser and a provider reference of its own, and "a payment that is
-- actually a refund" is how a receivables report ends up wrong.
-- ---------------------------------------------------------------------------
create table if not exists payment_refunds (
  id                   text primary key default veyora_id('rfn'),
  invoice_id           text not null references invoices(id) on delete cascade,
  payment_id           text references payments(id) on delete set null,
  provider             text not null default 'stripe' check (provider in ('stripe')),
  provider_refund_id   text not null default '',
  amount_minor         bigint not null check (amount_minor > 0),
  currency             text not null,
  status               text not null default 'pending'
                       check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  -- Required by the application, not defaulted to something bland: a refund
  -- with no stated reason is one nobody can explain six months later.
  reason               text not null default '',
  -- Who authorised it. `on delete set null`: losing the account must never
  -- rewrite the fact that a refund happened.
  authorised_by        text references users(id) on delete set null,
  idempotency_key      text not null unique,
  last_error           text not null default '',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists payment_refunds_invoice_idx on payment_refunds (invoice_id);
create unique index if not exists payment_refunds_provider_idx
  on payment_refunds (provider_refund_id) where provider_refund_id <> '';

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 't_payment_refunds_touch') then
    create trigger t_payment_refunds_touch before update on payment_refunds
      for each row execute function touch_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. What is deliberately NOT here
--
--   * No card data of any kind. No PAN, no expiry, no CVC, no token that could
--     be used to charge. The customer's card details are entered on Stripe's
--     own hosted page and never touch Veyora — which is the reason for
--     choosing a hosted flow.
--   * No change to `orders`, to checkout, or to the existing invoicing route.
--     Payment is never forced during order creation.
--   * No raw webhook payload, anywhere.
--   * No automatic refund path. A refund needs `payments.refund`, an explicit
--     confirmation and a stated reason; nothing a customer can send causes one.
-- ---------------------------------------------------------------------------
