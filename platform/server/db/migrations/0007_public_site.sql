-- ============================================================================
-- Public website — additive content schema and publication governance (B2.1)
--
-- Everything in this file is additive: no existing column is renamed,
-- dropped, retyped or re-meaninged, and no existing row is touched. Nine new
-- tables (brands, locations, policies, media, redirects, content_pages,
-- forms, form_submissions, content_approvals) plus new columns on the
-- existing `products` and `variations` tables.
--
-- This file only runs automatically against a completely fresh database
-- volume (docker-entrypoint-initdb.d — see platform/server/db/migrations'
-- own precedent). An EXISTING, already-deployed database does not re-run
-- files in this directory; it picks up additive changes through
-- api/src/migrate.js's ensureSchema(), which mirrors every statement below
-- idempotently (create ... if not exists / add column if not exists) and
-- runs on every API boot. See 0005/0006 and migrate.js for the established
-- precedent this file and its mirror follow.
--
-- Design notes carried over from 0001_schema.sql:
--  * text primary keys via veyora_id(prefix), already defined in 0001.
--  * status/lifecycle fields are text + CHECK, matching the admin panel's
--    existing convention.
--  * New id prefixes chosen to avoid every prefix already in use (checked
--    against 0001–0006 and migrate.js): br, loc, pol, med, rdr, cpg, frm,
--    fsub, cap.
--
-- Governance model (applied to brands, locations, policies, content_pages,
-- and — as additive columns — products): publication_state defaults
-- 'draft', verification_status defaults 'unverified'. Nothing in this
-- migration promotes any record to 'published', and no trigger exists that
-- could auto-promote a draft record — publication is exclusively an
-- application-level action, deferred to B2.2+ editorial surfaces.
-- `content_updated_at` is deliberately NOT touched by any trigger here (see
-- the note on `touch_updated_at()` below) — it stays separate from
-- `updated_at` so a Zoho stock sync, or any other operational write, never
-- moves a content `lastmod` value. It is set once at insert and is
-- otherwise entirely application-managed.
-- ============================================================================

-- ---------- media ----------
-- Referenced by brands.logo_media_id / hero_media_id and by
-- variations.swatch_media_id below, so it is created first. owner_type /
-- owner_id is a deliberately unconstrained (no FK) polymorphic reference —
-- the same pattern already used by inventory_movements in migrate.js for a
-- comparable reason: this table must be able to point at rows in more than
-- one other table.
create table if not exists media (
  id             text primary key default veyora_id('med'),
  path           text not null,
  alt            text not null default '',
  width          int,
  height         int,
  kind           text not null default 'image' check (kind in ('image','video')),
  rights_holder  text not null default '',
  rights_expiry  date,
  owner_type     text not null default '',
  owner_id       text not null default '',
  variant_sku    text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists media_owner_idx on media (owner_type, owner_id);

-- ---------- brands ----------
create table if not exists brands (
  id                   text primary key default veyora_id('br'),
  slug                 text unique not null,
  name                 text not null,
  short_name           text not null default '',
  segment              text not null default '',
  headline             text not null default '',
  summary              text not null default '',
  story                text not null default '',
  ideal_retailer       text not null default '',
  best_for             jsonb not null default '[]',
  style_traits         text[] not null default '{}',
  price_tier_label     text not null default '',
  design_origin        text not null default '',
  manufacturing_origin text not null default '',
  component_origins    jsonb not null default '[]',
  approved_materials   text[] not null default '{}',
  logo_media_id        text references media(id) on delete set null,
  hero_media_id        text references media(id) on delete set null,
  seo                  jsonb not null default '{}',
  -- governance
  publication_state    text not null default 'draft'
                       check (publication_state in ('draft','verified','approved','published','retired')),
  source_reference     text not null default '',
  fact_owner           text references users(id) on delete set null,
  verification_status  text not null default 'unverified'
                       check (verification_status in ('unverified','sourced','verified')),
  last_reviewed_at     timestamptz,
  scheduled_review_at  timestamptz,
  content_updated_at   timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists brands_publication_state_idx on brands (publication_state);

-- ---------- locations ----------
create table if not exists locations (
  id              text primary key default veyora_id('loc'),
  slug            text unique not null,
  name            text not null,
  -- Double-quoted defensively: FUNCTION is non-reserved in PostgreSQL (valid
  -- as a column name unquoted too), but this was written and reviewed
  -- without a local Postgres available to confirm interactively — quoting
  -- costs nothing and removes any doubt. Case-folds identically either way
  -- since the identifier is already all-lowercase.
  "function"      text not null default 'office'
                 check ("function" in ('warehouse','supply_base','service_hub','office','support')),
  is_public       boolean not null default false,
  address         jsonb not null default '{}',
  regions_served  text[] not null default '{}',
  contact         jsonb not null default '{}',
  hours           text not null default '',
  coordinates     jsonb,
  -- governance
  publication_state    text not null default 'draft'
                       check (publication_state in ('draft','verified','approved','published','retired')),
  source_reference     text not null default '',
  fact_owner           text references users(id) on delete set null,
  verification_status  text not null default 'unverified'
                       check (verification_status in ('unverified','sourced','verified')),
  last_reviewed_at     timestamptz,
  scheduled_review_at  timestamptz,
  content_updated_at   timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists locations_publication_state_idx on locations (publication_state);

-- ---------- policies ----------
create table if not exists policies (
  id               text primary key default veyora_id('pol'),
  type             text unique not null,
  summary          text not null default '',
  terms            text not null default '',
  effective_date   date,
  eligible_markets text[] not null default '{}',
  exclusions       text not null default '',
  revisions        jsonb not null default '[]',
  -- governance
  publication_state    text not null default 'draft'
                       check (publication_state in ('draft','verified','approved','published','retired')),
  source_reference     text not null default '',
  fact_owner           text references users(id) on delete set null,
  verification_status  text not null default 'unverified'
                       check (verification_status in ('unverified','sourced','verified')),
  last_reviewed_at     timestamptz,
  scheduled_review_at  timestamptz,
  content_updated_at   timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists policies_publication_state_idx on policies (publication_state);

-- ---------- redirects ----------
-- `to_path` must be empty (410 rows carry no destination) or an internal
-- path — never an absolute URL or another host, so this table cannot
-- become an open-redirect source by construction.
create table if not exists redirects (
  id          text primary key default veyora_id('rdr'),
  from_path   text unique not null,
  to_path     text not null default '',
  status      int not null default 301 check (status in (301, 302, 410)),
  reason      text not null default '',
  source      text not null default 'manual',
  created_at  timestamptz not null default now(),
  constraint redirects_to_path_internal check (to_path = '' or to_path like '/%')
);

-- ---------- content_pages ----------
create table if not exists content_pages (
  id            text primary key default veyora_id('cpg'),
  route         text unique not null,
  template      text not null default '',
  modules       jsonb not null default '[]',
  seo           jsonb not null default '{}',
  -- Conservative default: a page is never auto-indexed. Flipping this to
  -- 'index' is an editorial decision, made alongside publication_state
  -- reaching 'published' — not a migration default.
  index_state   text not null default 'noindex' check (index_state in ('index', 'noindex')),
  -- governance
  publication_state    text not null default 'draft'
                       check (publication_state in ('draft','verified','approved','published','retired')),
  source_reference     text not null default '',
  fact_owner           text references users(id) on delete set null,
  verification_status  text not null default 'unverified'
                       check (verification_status in ('unverified','sourced','verified')),
  last_reviewed_at     timestamptz,
  scheduled_review_at  timestamptz,
  content_updated_at   timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists content_pages_publication_state_idx on content_pages (publication_state);

-- ---------- forms ----------
-- Form *definitions* (what fields a form has, where it routes) — not
-- individual submissions, which live in form_submissions below. No
-- governance block: a form definition is engineering/content
-- configuration, not a publishable public-facing fact.
create table if not exists forms (
  id              text primary key default veyora_id('frm'),
  type            text unique not null,
  fields          jsonb not null default '[]',
  consent_version text not null default '',
  crm_routing     jsonb not null default '{}',
  confirmation    jsonb not null default '{}',
  notify_to       text[] not null default '{}',
  retention_days  int not null default 365,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- form_submissions ----------
create table if not exists form_submissions (
  id              text primary key default veyora_id('fsub'),
  form_type       text not null default '',
  payload         jsonb not null default '{}',
  source_url      text not null default '',
  utm             jsonb not null default '{}',
  region          text not null default '',
  business_type   text not null default '',
  consent_version text not null default '',
  consent_at      timestamptz,
  delivery_state  text not null default 'pending' check (delivery_state in ('pending', 'sent', 'failed')),
  attempts        int not null default 0,
  last_error      text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists form_submissions_form_type_idx      on form_submissions (form_type);
create index if not exists form_submissions_delivery_state_idx on form_submissions (delivery_state);

-- ---------- content_approvals ----------
-- An immutable approval-event log (no updated_at, matching audit_log's
-- existing pattern): `entity_type` + `entity_id` is a deliberately
-- unconstrained polymorphic reference, the same choice as media above,
-- since an approval can attach to a brand, a location, a policy, a content
-- page, or a product field.
create table if not exists content_approvals (
  id               text primary key default veyora_id('cap'),
  entity_type      text not null,
  entity_id        text not null,
  field            text not null default '',
  approver_id      text references users(id) on delete set null,
  approved_at      timestamptz not null default now(),
  source_reference text not null default '',
  note             text not null default '',
  created_at       timestamptz not null default now()
);
create index if not exists content_approvals_entity_idx on content_approvals (entity_type, entity_id);

-- ---------- updated_at auto-touch (new tables only) ----------
-- Reuses touch_updated_at(), already defined in 0001_schema.sql. Never
-- attached to content_updated_at anywhere — see the file header note.
create trigger t_brands_touch        before update on brands        for each row execute function touch_updated_at();
create trigger t_locations_touch     before update on locations     for each row execute function touch_updated_at();
create trigger t_policies_touch      before update on policies      for each row execute function touch_updated_at();
create trigger t_content_pages_touch before update on content_pages for each row execute function touch_updated_at();
create trigger t_forms_touch         before update on forms         for each row execute function touch_updated_at();
create trigger t_form_submissions_touch before update on form_submissions for each row execute function touch_updated_at();

-- ============================================================================
-- Additive columns on `products`
--
-- `is_active` keeps its existing meaning (an ordering/availability flag,
-- unchanged); `is_published` is a new, INDEPENDENT public-visibility flag —
-- a product can be orderable in the portal and unpublished on the public
-- site, and vice versa. Every new column defaults to a value that changes
-- nothing about current behaviour: is_published/is_featured/is_discontinued
-- all default false, public_slug/brand_id stay nullable, and no existing
-- row's brand (free-text) column is touched.
-- ============================================================================
alter table products add column if not exists public_slug           text;
alter table products add column if not exists brand_id               text references brands(id) on delete set null;
alter table products add column if not exists line                  text not null default '';
alter table products add column if not exists shape                 text not null default '';
alter table products add column if not exists segment               text not null default '';
alter table products add column if not exists public_description    text not null default '';
alter table products add column if not exists is_published           boolean not null default false;
alter table products add column if not exists is_featured            boolean not null default false;
alter table products add column if not exists is_discontinued        boolean not null default false;
alter table products add column if not exists replacement_product_id text references products(id) on delete set null;
-- governance (content_updated_at is new and separate from the existing,
-- trigger-maintained `updated_at` — see file header)
alter table products add column if not exists publication_state    text not null default 'draft'
                     check (publication_state in ('draft','verified','approved','published','retired'));
alter table products add column if not exists source_reference     text not null default '';
alter table products add column if not exists fact_owner           text references users(id) on delete set null;
alter table products add column if not exists verification_status  text not null default 'unverified'
                     check (verification_status in ('unverified','sourced','verified'));
alter table products add column if not exists last_reviewed_at     timestamptz;
alter table products add column if not exists scheduled_review_at  timestamptz;
alter table products add column if not exists content_updated_at   timestamptz not null default now();

-- A product cannot list itself as its own replacement.
alter table products add constraint products_replacement_not_self
  check (replacement_product_id is null or replacement_product_id <> id);

-- Structural guarantee that this migration cannot itself publish anything,
-- and that nothing can become publicly visible without also being in the
-- 'published' governance state: is_published = true REQUIRES
-- publication_state = 'published'. Since every existing row keeps
-- is_published at its default (false), this cannot reject any current data.
alter table products add constraint products_published_requires_state
  check (is_published = false or publication_state = 'published');

create unique index if not exists products_public_slug_idx on products (public_slug);
create index        if not exists products_brand_id_idx     on products (brand_id);
create index        if not exists products_is_published_idx on products (is_published);
create index        if not exists products_shape_idx        on products (shape);
create index        if not exists products_replacement_idx  on products (replacement_product_id);

-- ============================================================================
-- Additive columns on `variations`
-- `color_code` is structured and distinct from the existing free-text
-- `color`; `is_published` defaults false, independent of the parent
-- product's flag. The rule "a variation should not publish while its
-- parent product is unpublished" is an application-level gate (B2.2/B2.4),
-- not a database constraint — see 14_B2_SCHEMA_REFERENCE.md.
-- ============================================================================
alter table variations add column if not exists color_code      text not null default '';
alter table variations add column if not exists swatch_media_id text references media(id) on delete set null;
alter table variations add column if not exists is_published    boolean not null default false;

create index if not exists variations_is_published_idx on variations (is_published);

-- ============================================================================
-- Slug-change → redirect protection (additive, brands and products only)
--
-- Fires only on UPDATE, so creating these triggers now — while brands is
-- empty and every existing product has is_published = false — cannot affect
-- any existing row. Each function only inserts a redirect when the OLD row
-- was already published AND the slug actually changed; `on conflict
-- (from_path) do nothing` means a pre-existing redirect at that exact path
-- is left untouched rather than silently overwritten (documented trade-off:
-- the older redirect wins; nothing alerts on the collision in this batch —
-- see 14_B2_SCHEMA_REFERENCE.md). Product backfill (populating public_slug
-- and brand_id for the 1,318 existing products) is explicitly NOT part of
-- this migration.
-- ============================================================================
create or replace function record_brand_slug_redirect() returns trigger as $$
begin
  if old.publication_state = 'published' and new.slug is distinct from old.slug then
    insert into redirects (from_path, to_path, status, reason, source)
    values ('/brands/' || old.slug || '/', '/brands/' || new.slug || '/', 301, 'brand slug change', 'trigger')
    on conflict (from_path) do nothing;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger t_brands_slug_redirect
  before update on brands
  for each row execute function record_brand_slug_redirect();

create or replace function record_product_slug_redirect() returns trigger as $$
declare
  brand_slug text;
begin
  if old.is_published
     and old.public_slug is not null
     and new.public_slug is distinct from old.public_slug then
    select slug into brand_slug from brands where id = old.brand_id;
    if brand_slug is not null then
      insert into redirects (from_path, to_path, status, reason, source)
      values (
        '/collections/' || brand_slug || '/' || old.public_slug || '/',
        '/collections/' || brand_slug || '/' || coalesce(new.public_slug, old.public_slug) || '/',
        301, 'product slug change', 'trigger'
      )
      on conflict (from_path) do nothing;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger t_products_slug_redirect
  before update on products
  for each row execute function record_product_slug_redirect();
