-- ============================================================================
-- Store contacts (Final Handover, Phase 2)
--
-- THE PROBLEM THIS SOLVES
--
-- `users` conflates two different things. A row with role 'customer' is a
-- BUSINESS — a store, with a customer number, payment terms, a balance and
-- pricing — and it simultaneously carries `first_name`, `last_name`, `email`
-- and `phone` as though it were a PERSON. It is also the login. So the store's
-- identity, one person's contact details, and one set of credentials are the
-- same row.
--
-- That breaks the moment reality intrudes. A store has an owner, a manager, a
-- buyer and someone in accounts payable. The buyer leaves. Whoever edits the
-- customer record to put the new buyer's mobile in has just changed the login
-- email, or overwritten the owner's number, or both — and there was never
-- anywhere to record that the person who left was the buyer in the first
-- place.
--
-- This migration separates the three concepts the platform needs to keep
-- apart:
--
--   * Veyora sales rep  — an internal Veyora agent. Already modelled:
--                         `users.agent_id` pointing at a role 'agent' or
--                         'super-agent' account. NOT touched here.
--   * Store contact     — a person who works for the customer. New: this
--                         table. Has no login and no authority.
--   * Portal user       — an account that may authenticate. Still `users`.
--                         A contact MAY be linked to one, explicitly, by
--                         somebody who decided to; never automatically.
--
-- Entirely additive. `users` is not altered: no column added, dropped or
-- retyped, no default changed, no constraint touched, no data moved. Every
-- existing customer keeps working exactly as it does today and simply has no
-- contacts yet — a real and expected state, not an error (see the legacy note
-- on `is_primary` below).
--
-- As with every migration since go-live, this file only runs on a completely
-- fresh database volume (docker-entrypoint-initdb.d). An existing database
-- picks the change up through api/src/migrate.js's ensureSchema(), which
-- mirrors every statement below idempotently.
--
-- DELIBERATELY GRANTS NOTHING. There is no INSERT into account_permissions
-- anywhere in this file. No account — including existing administrators, and
-- including accounts that already hold enquiry or public-content capabilities
-- — receives `customer_contacts.view` or `customer_contacts.manage` from this
-- migration. Store contacts are named people with mobile numbers; reading them
-- is a grant somebody makes deliberately, one account at a time.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Widen the capability CHECK constraint
--
-- Same mechanism 0009 used, on the explicitly named constraint 0009 left
-- behind. Dropping and re-adding a CHECK is not a data operation: the table is
-- validated against the new predicate on the way in, and the new set is a
-- strict superset of the old one, so every existing row already satisfies it.
-- 0008 and 0009 are NOT edited — a migration that has run somewhere is
-- immutable.
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
    'customer_contacts.manage'
  ));

-- ---------------------------------------------------------------------------
-- 2. The contacts themselves
--
-- ARCHIVE, NEVER DELETE. `is_active` false is how a contact leaves. The row
-- stays, because an order, a call log or an audit entry that names the buyer
-- must still resolve to a person after that person moves on. There is no
-- DELETE statement anywhere in the contact surface — no route, no client
-- method, no button.
--
-- NORMALISED COLUMNS. `email_normalised` and `mobile_normalised` are stored
-- alongside the values a human typed, never instead of them. A person's number
-- should be displayed the way they gave it; matching it needs a canonical
-- form. Deriving one at query time would mean a scan and an index that cannot
-- be used, and overwriting the typed value would quietly discard formatting
-- somebody chose. The application computes both — the database does not
-- guess, because guessing a phone-number country is how a mobile becomes
-- undiallable.
-- ---------------------------------------------------------------------------
create table if not exists customer_contacts (
  id                        text primary key default veyora_id('cc'),

  -- The store this person works for. `on delete cascade`: a contact has no
  -- meaning without the customer, and an orphaned row here would be a named
  -- person with a mobile number attached to nothing.
  customer_id               text not null references users(id) on delete cascade,

  first_name                text not null default '',
  last_name                 text not null default '',

  -- Free text, deliberately. A job title is what somebody calls themselves;
  -- constraining it to a list would mean inventing titles for real people.
  -- `responsibilities` below is the constrained, machine-readable half.
  job_title                 text not null default '',

  -- What this person actually handles, from a closed set. Separate from
  -- job_title because "Office Manager" tells routing nothing, and because a
  -- responsibility must never be INFERRED from a title.
  responsibilities          text[] not null default '{}',

  mobile                    text not null default '',
  mobile_normalised         text not null default '',
  office_phone              text not null default '',
  office_extension          text not null default '',
  email                     text not null default '',
  email_normalised          text not null default '',

  -- How this person prefers to be reached. Constrained, and required to be a
  -- channel they actually have — enforced in the application, which is the
  -- only layer that can produce a usable error message about it.
  preferred_contact_method  text not null default 'email'
                            check (preferred_contact_method in (
                              'email', 'mobile_call', 'whatsapp', 'office_phone')),

  -- A BCP-47-ish tag, unconstrained and purely informational: it tells a rep
  -- which language to open in. Never used to select a template automatically.
  preferred_language        text not null default '',

  is_primary                boolean not null default false,
  is_active                 boolean not null default true,

  -- The portal account this person signs in with, IF they have one. Null is
  -- the normal case and the default: creating a contact never creates a login.
  -- `on delete set null` (not cascade): deleting a portal account must remove
  -- the login, not the person's contact details.
  portal_user_id            text references users(id) on delete set null,

  notes                     text not null default '',

  -- When a human last confirmed these details are still right. Set only by an
  -- explicit action; never stamped by an edit, because editing a note is not
  -- the same as ringing the store to check the number.
  last_verified_at          timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- An archived contact cannot remain the primary. Enforced here as well as in
  -- the application, so no code path — including a future one — can leave a
  -- store whose primary contact no longer works there.
  constraint customer_contacts_archived_not_primary
    check (is_active or not is_primary),

  -- An active contact must be a named person. An entry with no name is not a
  -- contact, it is a stray phone number; the planner in Phase 2 refuses to
  -- propose one for exactly this reason.
  constraint customer_contacts_active_named
    check (not is_active or (first_name <> '' and last_name <> '')),

  -- An active contact must be reachable somehow. A contact nobody can contact
  -- is a record that looks like coverage and is not.
  constraint customer_contacts_active_reachable
    check (not is_active
           or email <> '' or mobile <> '' or office_phone <> '')
);

-- ONE ACTIVE PRIMARY PER STORE. A partial unique index rather than a trigger:
-- the database refuses the second one outright, so two concurrent requests
-- cannot both read "no primary yet" and both write one. Archived and
-- non-primary rows are outside the index entirely, so there is no limit on
-- how many of those a store may have.
create unique index if not exists customer_contacts_one_primary_idx
  on customer_contacts (customer_id) where is_primary and is_active;

-- The list query is "this store's contacts, primary first, then active".
create index if not exists customer_contacts_customer_idx
  on customer_contacts (customer_id, is_active, is_primary);

-- Lookups by normalised channel, for the duplicate check on create. Partial,
-- because the empty string is the common value and indexing it is wasted work.
create index if not exists customer_contacts_email_normalised_idx
  on customer_contacts (email_normalised) where email_normalised <> '';
create index if not exists customer_contacts_mobile_normalised_idx
  on customer_contacts (mobile_normalised) where mobile_normalised <> '';

-- Which contacts already hold a portal login, for the link/unlink screen.
create index if not exists customer_contacts_portal_user_idx
  on customer_contacts (portal_user_id) where portal_user_id is not null;

-- A portal account belongs to at most one contact. Without this, two people at
-- the same store could both be recorded as signing in with the same account,
-- and neither record would be wrong on its face.
create unique index if not exists customer_contacts_portal_user_unique_idx
  on customer_contacts (portal_user_id) where portal_user_id is not null;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 't_customer_contacts_touch') then
    create trigger t_customer_contacts_touch before update on customer_contacts
      for each row execute function touch_updated_at();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. What is deliberately NOT here
--
--   * No back-fill. Not one row is created from `users.first_name` /
--     `users.email`. A contact created by a migration would be a person the
--     platform invented: nobody chose the name, nobody assigned the
--     responsibility, and nobody confirmed the number is current. The Phase 2
--     planner proposes contacts from legacy fields for HUMAN REVIEW and
--     applies nothing.
--   * No consent column and no marketing subscription. Recording that someone
--     is the buyer is not consent to market to them, and a nullable boolean
--     that defaults to anything would eventually be read as one.
--   * No portal account creation. `portal_user_id` starts null and is set only
--     by an explicit link action against an account that already exists.
--   * No DELETE path. Archival is the only way a contact leaves.
-- ---------------------------------------------------------------------------
