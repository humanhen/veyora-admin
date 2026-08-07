-- ============================================================================
-- Duplicate-submission guards (Final Handover, Phase 7)
--
-- A sweep of every high-risk mutation path found five of seven already guarded
-- by a row lock, a unique key or an optimistic-concurrency token. This
-- migration closes the two that were not, and adds a ledger key to the one
-- remaining route where an honest client retry produced a real duplicate.
--
--   1. `form_submissions` — a public enquiry had NO server-side duplicate
--      guard at all. A refresh of the POST result, a synthetic
--      `requestSubmit()`, a second tab, or scripting simply being off all
--      produced a second row and a second staff alert.
--
--   2. `inventory_movements` — `POST /admin/inventory/adjust` applies a SIGNED
--      DELTA, so it is inherently non-idempotent: two identical requests
--      legitimately mean +20. The UI has held an in-flight flag since the
--      security hardening batch, but a retrying proxy or a double-submitted
--      fetch had nothing stopping it server-side.
--
-- Entirely additive. Both guards are PARTIAL unique indexes over a nullable
-- column, so every existing row is outside them and nothing is invalidated.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A short-window fingerprint on public form submissions
--
-- WHY A TIME BUCKET RATHER THAN A PLAIN CONTENT HASH
--
-- Two genuine enquiries from the same person can be identical: somebody asks
-- the same question twice a week apart, or two people at one shop send the
-- same request. A permanent uniqueness constraint on content would refuse the
-- second, which is worse than accepting a duplicate — a lost enquiry is
-- invisible, whereas a duplicated one is merely untidy.
--
-- So the fingerprint includes a coarse TIME BUCKET. Identical content inside
-- the same bucket is a double submission; the same content tomorrow is a new
-- enquiry. The application computes the value (see src/routes/public-forms.js);
-- the database only enforces that it is unique.
--
-- Nullable, so every pre-existing row is outside the index and no historical
-- duplicate blocks the migration.
-- ---------------------------------------------------------------------------
alter table form_submissions
  add column if not exists dedupe_fingerprint text;

create unique index if not exists form_submissions_dedupe_idx
  on form_submissions (dedupe_fingerprint)
  where dedupe_fingerprint is not null;

-- ---------------------------------------------------------------------------
-- 2. An idempotency key on the stock ledger
--
-- `inventory_movements` is append-only (0001 installs the trigger), which is
-- right — but it means a duplicated adjustment leaves two ledger rows that can
-- never be corrected, only offset. Refusing the second is the only workable
-- guard.
--
-- Nullable: movements written by the ordering path, the sync path and every
-- historical row carry none, and must not start colliding with one another.
-- Only the narrow adjust/transfer routes set it.
-- ---------------------------------------------------------------------------
alter table inventory_movements
  add column if not exists idempotency_key text;

create unique index if not exists inventory_movements_idempotency_idx
  on inventory_movements (idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 3. What is deliberately NOT here
--
--   * No uniqueness on enquiry CONTENT alone — see the note above. A refused
--     genuine enquiry is invisible; a duplicated one is merely untidy.
--   * No change to the append-only trigger on `inventory_movements`. The guard
--     refuses the write; it does not permit a correction afterwards.
--   * No guard on `order_items.collected` or on order status: those are
--     ABSOLUTE writes (`set collected = least($3, qty)`), so replaying them is
--     already a no-op. Adding a key would be ceremony without a property.
-- ---------------------------------------------------------------------------
