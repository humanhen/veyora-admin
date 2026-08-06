-- ============================================================================
-- Durable notification outbox (Final Engineering Handover, Phase 1)
--
-- Findings ENQ-006 / NOT-006: an accepted public enquiry was stored with
-- `delivery_state = 'pending'` and nothing ever told anybody it had arrived.
-- A public form that silently accumulates sales leads is worse than no form,
-- because the business believes it is receiving enquiries.
--
-- This is the transactional-outbox pattern. A submission and its notification
-- are written in the SAME transaction, so they commit together or not at all.
-- A separate worker delivers, retries with bounded backoff, and gives up
-- explicitly rather than silently.
--
-- ONE MECHANISM, NOT THREE. Order confirmations, statement delivery and
-- enquiry alerts all use this table. `notification_type` distinguishes them.
--
-- ENTIRELY ADDITIVE. No existing table, column or constraint changes.
-- `form_submissions.delivery_state` keeps its current meaning and is left
-- alone; it describes the submission's own view of delivery, while this table
-- owns the attempt history.
--
-- As with every migration since go-live, this file runs only on a fresh
-- database volume. An existing database picks it up through
-- api/src/migrate.js's ensureSchema(), which mirrors it idempotently.
-- ============================================================================

create table if not exists notification_outbox (
  id                  text primary key default veyora_id('ntf'),

  -- WHAT this is. Constrained so a typo cannot create an untracked class of
  -- notification that no worker knows how to render.
  notification_type   text not null
                      check (notification_type in (
                        'enquiry_received',
                        'order_confirmation',
                        'statement_delivery'
                      )),

  -- WHAT it is about. Deliberately a loose polymorphic reference with no
  -- foreign key: a notification must outlive the record that caused it, so
  -- the delivery history survives even if the source is later removed. The
  -- same choice inventory_movements makes, for the same reason.
  source_type         text not null default '',
  source_id           text not null default '',

  -- WHO it goes to. Stored because the recipient at the time of sending is a
  -- fact about the attempt: changing a contact later must not rewrite where a
  -- message was actually delivered.
  recipient_address   text not null,
  recipient_name      text not null default '',

  -- HOW it is rendered. The version is stamped so a later template change
  -- does not retroactively change what a delivered message is recorded as
  -- having said.
  template_key        text not null,
  template_version    text not null default 'v1',

  -- The template's data. SAFE BY CONSTRUCTION: the enqueueing code builds
  -- this from an explicit allowlist, never by spreading a database row. It is
  -- deliberately NOT the submission payload.
  template_data       jsonb not null default '{}',

  status              text not null default 'pending'
                      check (status in (
                        'pending',          -- queued, never attempted
                        'processing',       -- claimed by a worker right now
                        'retry_scheduled',  -- failed, will be tried again
                        'delivered',        -- provider CONFIRMED it
                        'failed',           -- terminal: retries exhausted
                        'cancelled'         -- deliberately abandoned
                      )),

  attempt_count       int not null default 0,
  next_attempt_at     timestamptz not null default now(),

  -- Lease. A worker claims a row by stamping these; a claim that expires is
  -- reclaimable, which is what makes a crashed worker recoverable rather than
  -- a permanently stuck row.
  claimed_at          timestamptz,
  claim_expires_at    timestamptz,

  last_attempted_at   timestamptz,
  delivered_at        timestamptz,
  failed_at           timestamptz,
  last_error          text not null default '',

  -- The provider's own reference for the delivered message. Present only when
  -- a provider actually confirmed; its absence on a 'delivered' row would be
  -- a bug, and a test asserts the writer never does that.
  provider_reference  text not null default '',

  -- Deterministic, and UNIQUE. This is what makes enqueueing idempotent: a
  -- retried submission cannot produce a second notification.
  idempotency_key     text not null unique,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- A delivered row must name the provider reference that proves it, and must
  -- carry the moment it happened. Enforced here so "delivered" cannot be
  -- claimed by application code that forgot the evidence.
  constraint notification_outbox_delivered_evidenced
    check (status <> 'delivered' or (delivered_at is not null and provider_reference <> '')),

  -- A terminal failure must record when it gave up.
  constraint notification_outbox_failed_stamped
    check (status <> 'failed' or failed_at is not null)
);

-- The worker's only hot query: "what is due, oldest first".
create index if not exists notification_outbox_due_idx
  on notification_outbox (status, next_attempt_at)
  where status in ('pending', 'retry_scheduled');

-- Reclaiming a crashed worker's leases.
create index if not exists notification_outbox_claim_idx
  on notification_outbox (claim_expires_at)
  where status = 'processing';

-- The admin enquiry screen joins on this.
create index if not exists notification_outbox_source_idx
  on notification_outbox (source_type, source_id);

create trigger t_notification_outbox_touch
  before update on notification_outbox
  for each row execute function touch_updated_at();
