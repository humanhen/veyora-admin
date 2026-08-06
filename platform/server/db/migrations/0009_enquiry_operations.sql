-- ============================================================================
-- Governed enquiry operations (Fast-Track WS2 Phase 2)
--
-- The public website has been storing enquiry submissions since the forms
-- shipped (0007's `form_submissions`), but nothing in the platform could read
-- them. This migration adds the two things that were missing: somewhere to
-- record how each submission is being handled, and two new capability keys so
-- that reading a member of the public's contact details is a grant somebody
-- deliberately makes.
--
-- Entirely additive. No column is dropped, no type is changed, no existing
-- default is altered, and NOTHING IS DELETED — see the handling model below.
-- Every new column has a default that describes what is already true of every
-- existing row, so back-filling is unnecessary and no data moves.
--
-- As with every migration since go-live, this file only runs on a completely
-- fresh database volume (docker-entrypoint-initdb.d). An existing database
-- picks the change up through api/src/migrate.js's ensureSchema(), which
-- mirrors every statement below idempotently.
--
-- DELIBERATELY GRANTS NOTHING. There is no INSERT into account_permissions
-- anywhere in this file. No account — including existing administrators, and
-- including accounts that already hold public_content capabilities — receives
-- `enquiries.view` or `enquiries.manage` from this migration. They are granted
-- one account at a time through the management API, exactly like every other
-- capability. See docs/public-website-rebuild/27_ENQUIRY_OPERATIONS.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Widen the capability CHECK constraint
--
-- 0008 declared the constraint inline, so PostgreSQL named it
-- `account_permissions_permission_key_check`. It is dropped and replaced with
-- an explicitly named constraint carrying the full registered set, so the next
-- capability added widens a constraint whose name is stable and searchable
-- rather than one PostgreSQL invented.
--
-- Dropping and re-adding a CHECK is not a data operation: the table is
-- validated against the new predicate on the way in, and since the new set is
-- a strict superset of the old one, every existing row already satisfies it.
-- 0008 is NOT edited — a migration that has run somewhere is immutable, and on
-- a fresh volume 0009 runs moments later in the same initialisation.
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
    'enquiries.manage'
  ));

-- ---------------------------------------------------------------------------
-- 2. Handling state on form_submissions
--
-- `delivery_state` already exists and is NOT this. It records whether the
-- platform managed to forward the submission onward (pending/sent/failed) —
-- a machine's business. `handling_status` records what a person decided to do
-- about it. Overloading delivery_state to mean both would make "we could not
-- email it" and "we have replied" indistinguishable.
--
-- There is no 'deleted' status and no DELETE anywhere in the enquiry surface.
-- A submission is a record of something a member of the public sent us; it is
-- closed or marked spam, never erased on an operator's say-so. Removal is a
-- retention matter (see `forms.retention_days`), handled by a separate,
-- deliberate process — not by a button on a screen.
-- ---------------------------------------------------------------------------
alter table form_submissions
  -- Every existing row is, correctly, 'new': nobody has been able to look at
  -- one until now.
  add column if not exists handling_status text not null default 'new',
  -- Attribution for the last transition. `on delete set null` (not cascade):
  -- losing the handler's account must never rewrite the enquiry.
  add column if not exists handled_by text references users(id) on delete set null,
  add column if not exists handled_at timestamptz,
  -- An internal working note. Never shown to the public, never returned by
  -- any /public route, and deliberately separate from `payload` so that what
  -- the enquirer wrote and what staff wrote can never be confused.
  add column if not exists handling_note text not null default '';

-- Constrained to the registered set for the same reason capability keys are:
-- the database agrees with src/enquiry-operations.js rather than trusting the
-- application. Named explicitly so a later status addition widens a constraint
-- that can be found by name.
alter table form_submissions
  drop constraint if exists form_submissions_handling_status_valid;
alter table form_submissions
  add constraint form_submissions_handling_status_valid
  check (handling_status in ('new', 'in_review', 'responded', 'closed', 'spam'));

-- A transition must record who made it and when. 'new' is the untouched
-- initial state and carries no attribution, which is why it is exempt.
alter table form_submissions
  drop constraint if exists form_submissions_handling_attributed;
alter table form_submissions
  add constraint form_submissions_handling_attributed
  check (handling_status = 'new' or handled_at is not null);

-- The operations list is "open enquiries, newest first", and the detail screen
-- is a primary-key lookup. Both are covered here.
create index if not exists form_submissions_handling_status_idx
  on form_submissions (handling_status);
create index if not exists form_submissions_created_at_idx
  on form_submissions (created_at desc);
