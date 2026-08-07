/* Lightweight, idempotent schema top-ups applied on every API boot.
   The base schema (db/migrations/0001_schema.sql) only runs on a fresh
   database, so tables added after go-live are ensured here instead — this
   lets a plain `deploy.sh` roll them out with no manual psql step. Every
   statement must be safe to run repeatedly (create ... if not exists). */
import { q } from './db.js';

export async function ensureSchema() {
  await q(`create table if not exists shared_lists (
    slug        text primary key,
    name        text not null default '',
    skus        text[] not null default '{}',
    created_by  text references users(id) on delete set null,
    created_at  timestamptz not null default now()
  )`);
  await q(`create index if not exists shared_lists_created_at_idx
    on shared_lists (created_at desc)`);

  // ---- inventory movements ledger (immutable audit trail of stock changes) ----
  // Every runtime stock write (order reservation, release, admin/PO/transfer
  // edit, Zoho sync) appends one signed row here. Deliberately NO foreign keys:
  // the ledger must outlive variation/warehouse churn (the admin sync deletes
  // and recreates variations), so ids are denormalised text + a copy of the sku.
  await q(`create table if not exists inventory_movements (
    id            text primary key default veyora_id('im'),
    variation_id  text,
    sku           text not null default '',
    warehouse_id  text,
    qty_delta     int not null,
    balance_after int,
    reason        text not null,
    ref_type      text not null default '',
    ref_id        text not null default '',
    actor_id      text,
    actor_name    text not null default 'System',
    actor_role    text not null default 'system',
    note          text not null default '',
    created_at    timestamptz not null default now()
  )`);
  await q(`create index if not exists inv_mov_variation_idx on inventory_movements (variation_id)`);
  await q(`create index if not exists inv_mov_sku_idx on inventory_movements (sku)`);
  await q(`create index if not exists inv_mov_warehouse_idx on inventory_movements (warehouse_id)`);
  await q(`create index if not exists inv_mov_created_idx on inventory_movements (created_at desc)`);
  await q(`create index if not exists inv_mov_ref_idx on inventory_movements (ref_type, ref_id)`);

  // Enforce append-only at the database level: reject UPDATE and DELETE.
  // (Safe because the table has no cascading foreign keys pointing at it.)
  await q(`create or replace function inventory_movements_immutable() returns trigger as $$
    begin
      raise exception 'inventory_movements is append-only (% blocked)', tg_op;
    end $$ language plpgsql`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_inv_mov_no_update') then
      create trigger t_inv_mov_no_update before update on inventory_movements
        for each row execute function inventory_movements_immutable();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 't_inv_mov_no_delete') then
      create trigger t_inv_mov_no_delete before delete on inventory_movements
        for each row execute function inventory_movements_immutable();
    end if;
  end $$`);

  // One-time baseline: seed each non-zero (variation, warehouse) balance as an
  // "opening_balance" movement, so the ledger's running sum equals live stock
  // from day one. Guarded to run only while the ledger is completely empty, so
  // it never re-seeds on a later boot/deploy.
  await q(`insert into inventory_movements
             (variation_id, sku, warehouse_id, qty_delta, balance_after, reason, ref_type, note)
           select s.variation_id, v.sku, s.warehouse_id, s.qty, s.qty,
                  'opening_balance', 'migration', 'ledger baseline at go-live'
             from stock s join variations v on v.id = s.variation_id
            where s.qty <> 0
              and not exists (select 1 from inventory_movements)`);

  // ---- multi-currency dimension ----
  // Money amounts are stored in the BASE currency (USD). What varies is the
  // currency an account trades in and the currency a transaction was struck in.
  // Accounts carry an operating currency; orders/invoices are stamped with the
  // currency + the FX rate used, so the transaction is reproducible even if the
  // rate later changes. Rates live in one place: settings.data.fx.
  await q(`alter table users    add column if not exists currency text not null default 'USD'`);
  await q(`alter table orders   add column if not exists currency text not null default 'USD'`);
  await q(`alter table orders   add column if not exists fx_rate  numeric(12,6) not null default 1`);
  await q(`alter table invoices add column if not exists currency text not null default 'USD'`);

  // Single source of FX rates (base + rate per currency, relative to base).
  // Seeded only if absent, so admin edits survive reboots/deploys.
  await q(`update settings
             set data = jsonb_set(coalesce(data,'{}'::jsonb), '{fx}',
                   '{"base":"USD","rates":{"USD":1,"CAD":1.37,"EUR":0.92}}'::jsonb, true)
           where id = 1 and not (coalesce(data,'{}'::jsonb) ? 'fx')`);

  /* ---- backorder order-context (mirrors db/migrations/0006) ----
     A fully backordered checkout creates no orders row, so the backorder is the
     only durable record. Without these columns the agent, currency, rate,
     addresses, promotion, shipping decision and customer note were lost, and a
     later conversion could not rebuild a faithful order. */
  await q(`alter table backorders add column if not exists agent_id         text references users(id) on delete set null`);
  await q(`alter table backorders add column if not exists source           text not null default 'customer'`);
  await q(`alter table backorders add column if not exists currency         text not null default 'USD'`);
  await q(`alter table backorders add column if not exists fx_rate          numeric(12,6) not null default 1`);
  await q(`alter table backorders add column if not exists shipping_address jsonb`);
  await q(`alter table backorders add column if not exists billing_address  jsonb`);
  await q(`alter table backorders add column if not exists promo            jsonb`);
  await q(`alter table backorders add column if not exists discount         numeric(12,2) not null default 0`);
  await q(`alter table backorders add column if not exists free_shipping    boolean not null default false`);
  await q(`alter table backorders add column if not exists shipping         numeric(12,2) not null default 0`);
  await q(`alter table backorders add column if not exists comments         jsonb not null default '[]'`);
  /* The customer's own authorisation, deliberately SEPARATE from `eligible`:
       customer_authorised = the customer asked for it knowing it was unavailable
       eligible            = staff/stock have cleared it for conversion
     Conflating them would make a backorder look convertible the instant it was
     created, asserting stock that nobody has checked. */
  await q(`alter table backorders add column if not exists customer_authorised boolean not null default false`);
  await q(`create index if not exists backorders_customer_idx on backorders (customer_id)`);
  await q(`create index if not exists backorders_status_idx   on backorders (status)`);

  /* ---- public website — additive content schema (mirrors db/migrations/0007) ----
     Nine new tables plus additive columns on products/variations for the
     future public site (B2). Every statement is additive and idempotent, so
     it is safe to run on an already-deployed database with existing rows.
     Nothing here changes any existing column, and nothing here publishes
     anything: publication_state defaults 'draft', verification_status
     defaults 'unverified', and every new is_published column defaults
     false. See docs/public-website-rebuild/14_B2_SCHEMA_REFERENCE.md for
     the full field-by-field reference. */

  await q(`create table if not exists media (
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
  )`);
  await q(`create index if not exists media_owner_idx on media (owner_type, owner_id)`);

  await q(`create table if not exists brands (
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
  )`);
  await q(`create index if not exists brands_publication_state_idx on brands (publication_state)`);

  await q(`create table if not exists locations (
    id              text primary key default veyora_id('loc'),
    slug            text unique not null,
    name            text not null,
    "function"      text not null default 'office'
                   check ("function" in ('warehouse','supply_base','service_hub','office','support')),
    is_public       boolean not null default false,
    address         jsonb not null default '{}',
    regions_served  text[] not null default '{}',
    contact         jsonb not null default '{}',
    hours           text not null default '',
    coordinates     jsonb,
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
  )`);
  await q(`create index if not exists locations_publication_state_idx on locations (publication_state)`);

  await q(`create table if not exists policies (
    id               text primary key default veyora_id('pol'),
    type             text unique not null,
    summary          text not null default '',
    terms            text not null default '',
    effective_date   date,
    eligible_markets text[] not null default '{}',
    exclusions       text not null default '',
    revisions        jsonb not null default '[]',
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
  )`);
  await q(`create index if not exists policies_publication_state_idx on policies (publication_state)`);

  await q(`create table if not exists redirects (
    id          text primary key default veyora_id('rdr'),
    from_path   text unique not null,
    to_path     text not null default '',
    status      int not null default 301 check (status in (301, 302, 410)),
    reason      text not null default '',
    source      text not null default 'manual',
    created_at  timestamptz not null default now(),
    constraint redirects_to_path_internal check (to_path = '' or to_path like '/%')
  )`);

  await q(`create table if not exists content_pages (
    id            text primary key default veyora_id('cpg'),
    route         text unique not null,
    template      text not null default '',
    modules       jsonb not null default '[]',
    seo           jsonb not null default '{}',
    index_state   text not null default 'noindex' check (index_state in ('index', 'noindex')),
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
  )`);
  await q(`create index if not exists content_pages_publication_state_idx on content_pages (publication_state)`);

  await q(`create table if not exists forms (
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
  )`);

  await q(`create table if not exists form_submissions (
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
  )`);
  await q(`create index if not exists form_submissions_form_type_idx      on form_submissions (form_type)`);
  await q(`create index if not exists form_submissions_delivery_state_idx on form_submissions (delivery_state)`);

  await q(`create table if not exists content_approvals (
    id               text primary key default veyora_id('cap'),
    entity_type      text not null,
    entity_id        text not null,
    field            text not null default '',
    approver_id      text references users(id) on delete set null,
    approved_at      timestamptz not null default now(),
    source_reference text not null default '',
    note             text not null default '',
    created_at       timestamptz not null default now()
  )`);
  await q(`create index if not exists content_approvals_entity_idx on content_approvals (entity_type, entity_id)`);

  // updated_at auto-touch on the new tables only — never attached to
  // content_updated_at (see the header note above).
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_brands_touch') then
      create trigger t_brands_touch before update on brands for each row execute function touch_updated_at();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 't_locations_touch') then
      create trigger t_locations_touch before update on locations for each row execute function touch_updated_at();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 't_policies_touch') then
      create trigger t_policies_touch before update on policies for each row execute function touch_updated_at();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 't_content_pages_touch') then
      create trigger t_content_pages_touch before update on content_pages for each row execute function touch_updated_at();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 't_forms_touch') then
      create trigger t_forms_touch before update on forms for each row execute function touch_updated_at();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 't_form_submissions_touch') then
      create trigger t_form_submissions_touch before update on form_submissions for each row execute function touch_updated_at();
    end if;
  end $$`);

  // ---- additive columns on products (public-content fields) ----
  // is_active keeps its existing meaning; is_published is a new,
  // independent public-visibility flag. Every new column defaults to a
  // value that changes nothing about current behaviour.
  await q(`alter table products add column if not exists public_slug           text`);
  await q(`alter table products add column if not exists brand_id             text references brands(id) on delete set null`);
  await q(`alter table products add column if not exists line                 text not null default ''`);
  await q(`alter table products add column if not exists shape                text not null default ''`);
  await q(`alter table products add column if not exists segment              text not null default ''`);
  await q(`alter table products add column if not exists public_description   text not null default ''`);
  await q(`alter table products add column if not exists is_published         boolean not null default false`);
  await q(`alter table products add column if not exists is_featured          boolean not null default false`);
  await q(`alter table products add column if not exists is_discontinued      boolean not null default false`);
  await q(`alter table products add column if not exists replacement_product_id text references products(id) on delete set null`);
  await q(`alter table products add column if not exists publication_state    text not null default 'draft'
                     check (publication_state in ('draft','verified','approved','published','retired'))`);
  await q(`alter table products add column if not exists source_reference    text not null default ''`);
  await q(`alter table products add column if not exists fact_owner          text references users(id) on delete set null`);
  await q(`alter table products add column if not exists verification_status text not null default 'unverified'
                     check (verification_status in ('unverified','sourced','verified'))`);
  await q(`alter table products add column if not exists last_reviewed_at    timestamptz`);
  await q(`alter table products add column if not exists scheduled_review_at timestamptz`);
  await q(`alter table products add column if not exists content_updated_at  timestamptz not null default now()`);

  await q(`do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'products_replacement_not_self') then
      alter table products add constraint products_replacement_not_self
        check (replacement_product_id is null or replacement_product_id <> id);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'products_published_requires_state') then
      alter table products add constraint products_published_requires_state
        check (is_published = false or publication_state = 'published');
    end if;
  end $$`);

  await q(`create unique index if not exists products_public_slug_idx on products (public_slug)`);
  await q(`create index        if not exists products_brand_id_idx     on products (brand_id)`);
  await q(`create index        if not exists products_is_published_idx on products (is_published)`);
  await q(`create index        if not exists products_shape_idx        on products (shape)`);
  await q(`create index        if not exists products_replacement_idx  on products (replacement_product_id)`);

  // ---- additive columns on variations ----
  await q(`alter table variations add column if not exists color_code      text not null default ''`);
  await q(`alter table variations add column if not exists swatch_media_id text references media(id) on delete set null`);
  await q(`alter table variations add column if not exists is_published    boolean not null default false`);
  await q(`create index if not exists variations_is_published_idx on variations (is_published)`);

  // ---- slug-change → redirect protection (brands and products) ----
  // Fires only on UPDATE; creating these now, while brands is empty and
  // every product has is_published = false, cannot affect any existing row.
  await q(`create or replace function record_brand_slug_redirect() returns trigger as $$
    begin
      if old.publication_state = 'published' and new.slug is distinct from old.slug then
        insert into redirects (from_path, to_path, status, reason, source)
        values ('/brands/' || old.slug || '/', '/brands/' || new.slug || '/', 301, 'brand slug change', 'trigger')
        on conflict (from_path) do nothing;
      end if;
      return new;
    end;
    $$ language plpgsql`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_brands_slug_redirect') then
      create trigger t_brands_slug_redirect before update on brands
        for each row execute function record_brand_slug_redirect();
    end if;
  end $$`);

  await q(`create or replace function record_product_slug_redirect() returns trigger as $$
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
    $$ language plpgsql`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_products_slug_redirect') then
      create trigger t_products_slug_redirect before update on products
        for each row execute function record_product_slug_redirect();
    end if;
  end $$`);

  /* ---- account-specific capability permissions (mirrors db/migrations/0008) ----
     Additive: one new table, no change to `users` or to any existing role
     meaning. GRANTS NOTHING — there is deliberately no insert here, so no
     account (including existing administrators) gains a capability from a
     deploy. The first `permissions.manage` grant is a separately reviewed
     bootstrap step, documented in
     docs/public-website-rebuild/19_ACCOUNT_PERMISSION_SYSTEM.md. */
  await q(`create table if not exists account_permissions (
    id              text primary key default veyora_id('perm'),
    user_id         text not null references users(id) on delete cascade,
    permission_key  text not null
                    check (permission_key in (
                      'public_content.view',
                      'public_content.edit',
                      'public_content.publish',
                      'permissions.manage'
                    )),
    is_active       boolean not null default false,
    granted_by      text references users(id) on delete set null,
    granted_at      timestamptz,
    revoked_by      text references users(id) on delete set null,
    revoked_at      timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint account_permissions_user_key_unique unique (user_id, permission_key),
    constraint account_permissions_active_attributed
      check (is_active = false or granted_at is not null),
    constraint account_permissions_revocation_attributed
      check (is_active = true or revoked_at is null or revoked_by is not null)
  )`);
  await q(`create index if not exists account_permissions_user_idx
    on account_permissions (user_id)`);
  await q(`create index if not exists account_permissions_active_key_idx
    on account_permissions (permission_key) where is_active`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_account_permissions_touch') then
      create trigger t_account_permissions_touch before update on account_permissions
        for each row execute function touch_updated_at();
    end if;
  end $$`);

  /* ---- governed enquiry operations (mirrors db/migrations/0009) ----
     Two new capability keys and somewhere to record how an enquiry is being
     handled. Additive throughout: nothing is dropped but the anonymous CHECK
     0008 left behind, which is replaced by a strictly wider, explicitly named
     one. GRANTS NOTHING — no account, including one that already holds
     public_content capabilities, gains `enquiries.view` or `enquiries.manage`
     from a deploy. See docs/public-website-rebuild/27_ENQUIRY_OPERATIONS.md. */
  await q(`alter table account_permissions
    drop constraint if exists account_permissions_permission_key_check`);
  await q(`alter table account_permissions
    drop constraint if exists account_permissions_permission_key_registered`);
  await q(`alter table account_permissions
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
    ))`);

  /* `handling_status` is NOT `delivery_state`. delivery_state records whether
     the platform managed to forward the submission onward; handling_status
     records what a person decided to do about it. There is no 'deleted'
     status and no DELETE anywhere in the enquiry surface — a submission is
     closed or marked spam, never erased on an operator's say-so. */
  await q(`alter table form_submissions
    add column if not exists handling_status text not null default 'new'`);
  await q(`alter table form_submissions
    add column if not exists handled_by text references users(id) on delete set null`);
  await q(`alter table form_submissions
    add column if not exists handled_at timestamptz`);
  await q(`alter table form_submissions
    add column if not exists handling_note text not null default ''`);

  await q(`alter table form_submissions
    drop constraint if exists form_submissions_handling_status_valid`);
  await q(`alter table form_submissions
    add constraint form_submissions_handling_status_valid
    check (handling_status in ('new', 'in_review', 'responded', 'closed', 'spam'))`);
  await q(`alter table form_submissions
    drop constraint if exists form_submissions_handling_attributed`);
  await q(`alter table form_submissions
    add constraint form_submissions_handling_attributed
    check (handling_status = 'new' or handled_at is not null)`);

  await q(`create index if not exists form_submissions_handling_status_idx
    on form_submissions (handling_status)`);
  await q(`create index if not exists form_submissions_created_at_idx
    on form_submissions (created_at desc)`);

  /* ---- append-only audit history (mirrors db/migrations/0010) ----
     Finding SEC-015. `audit` was a synced collection, so the generic
     whole-database sync could UPDATE and DELETE audit rows. Reuses exactly the
     pattern the inventory ledger has used since it was built (see
     inventory_movements_immutable above) rather than inventing a second
     mechanism. Additive: INSERT is untouched, no row is modified, nothing is
     dropped. Corrections are compensating records, never mutations. */
  await q(`create or replace function audit_log_immutable() returns trigger as $$
    begin
      raise exception 'audit_log is append-only (% blocked)', tg_op;
    end $$ language plpgsql`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_audit_log_no_update') then
      create trigger t_audit_log_no_update before update on audit_log
        for each row execute function audit_log_immutable();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 't_audit_log_no_delete') then
      create trigger t_audit_log_no_delete before delete on audit_log
        for each row execute function audit_log_immutable();
    end if;
  end $$`);

  /* ---- durable notification outbox (mirrors db/migrations/0011) ----
     Findings ENQ-006 / NOT-006. The transactional-outbox pattern: a
     submission and its notification commit together, and a separate worker
     delivers with bounded retry. One mechanism for enquiry alerts, order
     confirmations and statement delivery. Entirely additive. */
  await q(`create table if not exists notification_outbox (
    id                  text primary key default veyora_id('ntf'),
    notification_type   text not null
                        check (notification_type in (
                          'enquiry_received', 'order_confirmation', 'statement_delivery')),
    source_type         text not null default '',
    source_id           text not null default '',
    recipient_address   text not null,
    recipient_name      text not null default '',
    template_key        text not null,
    template_version    text not null default 'v1',
    template_data       jsonb not null default '{}',
    status              text not null default 'pending'
                        check (status in ('pending', 'processing', 'retry_scheduled',
                                          'delivered', 'failed', 'cancelled')),
    attempt_count       int not null default 0,
    next_attempt_at     timestamptz not null default now(),
    claimed_at          timestamptz,
    claim_expires_at    timestamptz,
    last_attempted_at   timestamptz,
    delivered_at        timestamptz,
    failed_at           timestamptz,
    last_error          text not null default '',
    provider_reference  text not null default '',
    idempotency_key     text not null unique,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint notification_outbox_delivered_evidenced
      check (status <> 'delivered' or (delivered_at is not null and provider_reference <> '')),
    constraint notification_outbox_failed_stamped
      check (status <> 'failed' or failed_at is not null)
  )`);
  await q(`create index if not exists notification_outbox_due_idx
    on notification_outbox (status, next_attempt_at)
    where status in ('pending', 'retry_scheduled')`);
  await q(`create index if not exists notification_outbox_claim_idx
    on notification_outbox (claim_expires_at) where status = 'processing'`);
  await q(`create index if not exists notification_outbox_source_idx
    on notification_outbox (source_type, source_id)`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_notification_outbox_touch') then
      create trigger t_notification_outbox_touch before update on notification_outbox
        for each row execute function touch_updated_at();
    end if;
  end $$`);

  /* ---- store contacts (mirrors db/migrations/0012) ----
     `users` conflates the STORE, one person's contact details, and the login.
     This separates the person out. Entirely additive: `users` is untouched and
     every existing customer simply has no contacts yet, which is a real state
     and not an error. Nothing is back-filled — a contact invented by a
     migration is a person nobody chose, with a number nobody confirmed. */
  await q(`create table if not exists customer_contacts (
    id                        text primary key default veyora_id('cc'),
    customer_id               text not null references users(id) on delete cascade,
    first_name                text not null default '',
    last_name                 text not null default '',
    job_title                 text not null default '',
    responsibilities          text[] not null default '{}',
    mobile                    text not null default '',
    mobile_normalised         text not null default '',
    office_phone              text not null default '',
    office_extension          text not null default '',
    email                     text not null default '',
    email_normalised          text not null default '',
    preferred_contact_method  text not null default 'email'
                              check (preferred_contact_method in (
                                'email', 'mobile_call', 'whatsapp', 'office_phone')),
    preferred_language        text not null default '',
    is_primary                boolean not null default false,
    is_active                 boolean not null default true,
    portal_user_id            text references users(id) on delete set null,
    notes                     text not null default '',
    last_verified_at          timestamptz,
    created_at                timestamptz not null default now(),
    updated_at                timestamptz not null default now(),
    constraint customer_contacts_archived_not_primary
      check (is_active or not is_primary),
    constraint customer_contacts_active_named
      check (not is_active or (first_name <> '' and last_name <> '')),
    constraint customer_contacts_active_reachable
      check (not is_active or email <> '' or mobile <> '' or office_phone <> '')
  )`);
  /* One active primary per store, enforced by a partial unique index rather
     than a trigger: two concurrent requests cannot both read "no primary yet"
     and both write one. */
  await q(`create unique index if not exists customer_contacts_one_primary_idx
    on customer_contacts (customer_id) where is_primary and is_active`);
  await q(`create index if not exists customer_contacts_customer_idx
    on customer_contacts (customer_id, is_active, is_primary)`);
  await q(`create index if not exists customer_contacts_email_normalised_idx
    on customer_contacts (email_normalised) where email_normalised <> ''`);
  await q(`create index if not exists customer_contacts_mobile_normalised_idx
    on customer_contacts (mobile_normalised) where mobile_normalised <> ''`);
  await q(`create index if not exists customer_contacts_portal_user_idx
    on customer_contacts (portal_user_id) where portal_user_id is not null`);
  /* A portal account belongs to at most one contact: without this, two people
     could both be recorded as signing in with it and neither record would look
     wrong on its face. */
  await q(`create unique index if not exists customer_contacts_portal_user_unique_idx
    on customer_contacts (portal_user_id) where portal_user_id is not null`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_customer_contacts_touch') then
      create trigger t_customer_contacts_touch before update on customer_contacts
        for each row execute function touch_updated_at();
    end if;
  end $$`);

  /* ---- Stripe invoice payments (mirrors db/migrations/0013) ----
     Paying online is an OPTION beside account terms, never a precondition for
     ordering. `invoices.status` is NOT reused: it records something about the
     legacy external invoicing arrangement, and overloading it would make "the
     external system issued this" and "a customer paid us" indistinguishable.
     Settlement gets its own column whose default is true of every existing
     row, so nothing is back-filled. Money on every new column is in MINOR
     UNITS, because that is what the provider speaks and every conversion is a
     chance to be out by a hundred. */
  await q(`alter table invoices
    add column if not exists settlement_state text not null default 'on_terms',
    add column if not exists settlement_currency text not null default 'USD',
    add column if not exists amount_settled_minor bigint not null default 0,
    add column if not exists amount_refunded_minor bigint not null default 0,
    add column if not exists settled_at timestamptz,
    add column if not exists settlement_reference text not null default ''`);
  await q(`alter table invoices drop constraint if exists invoices_settlement_state_valid`);
  await q(`alter table invoices add constraint invoices_settlement_state_valid
    check (settlement_state in ('on_terms', 'processing', 'paid', 'refunded', 'void'))`);
  /* The state that asserts money arrived cannot be reached without the
     reference that proves it. */
  await q(`alter table invoices drop constraint if exists invoices_paid_evidenced`);
  await q(`alter table invoices add constraint invoices_paid_evidenced
    check (settlement_state <> 'paid'
           or (settled_at is not null and settlement_reference <> '' and amount_settled_minor > 0))`);
  await q(`alter table invoices drop constraint if exists invoices_refund_within_settled`);
  await q(`alter table invoices add constraint invoices_refund_within_settled
    check (amount_refunded_minor >= 0 and amount_refunded_minor <= amount_settled_minor)`);
  await q(`create index if not exists invoices_settlement_state_idx
    on invoices (settlement_state) where settlement_state <> 'on_terms'`);

  await q(`create table if not exists payment_sessions (
    id                      text primary key default veyora_id('ps'),
    invoice_id              text not null references invoices(id) on delete cascade,
    customer_id             text references users(id) on delete set null,
    provider                text not null default 'stripe' check (provider in ('stripe')),
    status                  text not null default 'created'
                            check (status in ('created', 'open', 'completed',
                                              'expired', 'cancelled', 'failed')),
    amount_minor            bigint not null check (amount_minor > 0),
    currency                text not null,
    provider_session_id     text not null default '',
    provider_payment_intent text not null default '',
    hosted_url              text not null default '',
    idempotency_key         text not null unique,
    requested_by            text references users(id) on delete set null,
    expires_at              timestamptz,
    completed_at            timestamptz,
    last_error              text not null default '',
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    constraint payment_sessions_completed_evidenced
      check (status <> 'completed' or (completed_at is not null and provider_payment_intent <> ''))
  )`);
  /* At most one live session per invoice, as a partial unique index: two
     concurrent requests cannot both read "no open session" and both create
     one, which would give Veyora two ways to be paid for the same invoice. */
  await q(`create unique index if not exists payment_sessions_one_live_idx
    on payment_sessions (invoice_id) where status in ('created', 'open')`);
  await q(`create index if not exists payment_sessions_invoice_idx
    on payment_sessions (invoice_id, created_at desc)`);
  await q(`create unique index if not exists payment_sessions_provider_session_idx
    on payment_sessions (provider_session_id) where provider_session_id <> ''`);
  await q(`create index if not exists payment_sessions_intent_idx
    on payment_sessions (provider_payment_intent) where provider_payment_intent <> ''`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_payment_sessions_touch') then
      create trigger t_payment_sessions_touch before update on payment_sessions
        for each row execute function touch_updated_at();
    end if;
  end $$`);

  /* The deduplication ledger. `provider_event_id` is UNIQUE, so a retried
     delivery collides on insert and is acknowledged without being processed
     twice — one database constraint rather than an application-level "have I
     seen this?" that races with itself. The RAW PAYLOAD IS NOT STORED: what is
     kept is an allowlisted summary the application built. */
  await q(`create table if not exists payment_events (
    id                  text primary key default veyora_id('pev'),
    provider            text not null default 'stripe' check (provider in ('stripe')),
    provider_event_id   text not null unique,
    event_type          text not null,
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
  )`);
  await q(`create index if not exists payment_events_invoice_idx on payment_events (invoice_id)`);
  await q(`create index if not exists payment_events_status_idx
    on payment_events (status) where status in ('received', 'failed')`);
  await q(`create index if not exists payment_events_received_idx on payment_events (received_at desc)`);

  /* `payments` is EXTENDED rather than replaced: a second payments table would
     mean two answers to "what has this customer paid". */
  await q(`alter table payments
    add column if not exists invoice_id text references invoices(id) on delete set null,
    add column if not exists currency text not null default 'USD',
    add column if not exists amount_minor bigint,
    add column if not exists payment_session_id text references payment_sessions(id) on delete set null,
    add column if not exists settlement_key text`);
  await q(`create unique index if not exists payments_settlement_key_idx
    on payments (settlement_key) where settlement_key is not null`);
  await q(`create index if not exists payments_invoice_idx
    on payments (invoice_id) where invoice_id is not null`);

  /* Refunds get their own table rather than a negative payment: a refund has a
     reason, an authoriser and its own provider reference, and "a payment that
     is actually a refund" is how a receivables report ends up wrong. */
  await q(`create table if not exists payment_refunds (
    id                   text primary key default veyora_id('rfn'),
    invoice_id           text not null references invoices(id) on delete cascade,
    payment_id           text references payments(id) on delete set null,
    provider             text not null default 'stripe' check (provider in ('stripe')),
    provider_refund_id   text not null default '',
    amount_minor         bigint not null check (amount_minor > 0),
    currency             text not null,
    status               text not null default 'pending'
                         check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
    reason               text not null default '',
    authorised_by        text references users(id) on delete set null,
    idempotency_key      text not null unique,
    last_error           text not null default '',
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
  )`);
  await q(`create index if not exists payment_refunds_invoice_idx on payment_refunds (invoice_id)`);
  await q(`create unique index if not exists payment_refunds_provider_idx
    on payment_refunds (provider_refund_id) where provider_refund_id <> ''`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_payment_refunds_touch') then
      create trigger t_payment_refunds_touch before update on payment_refunds
        for each row execute function touch_updated_at();
    end if;
  end $$`);

  /* ---- auditable finance operations (mirrors db/migrations/0014) ----
     Money used to move through the whole-database row-diff sync: a browser
     could set a customer's balance to any number, with no record of what it
     was before, no reason and no reference, because a row diff has no such
     concept. `finance_events` is the structured, APPEND-ONLY record every
     governed financial mutation now writes inside its own transaction. */
  await q(`create table if not exists finance_events (
    id                 text primary key default veyora_id('fev'),
    event_type         text not null
                       check (event_type in (
                         'invoice.issued', 'payment.recorded', 'payment.voided',
                         'credit_note.issued', 'refund.requested', 'refund.settled',
                         'settlement.applied', 'reconciliation.resolved')),
    customer_id        text references users(id) on delete set null,
    invoice_id         text references invoices(id) on delete set null,
    payment_id         text references payments(id) on delete set null,
    credit_note_id     text references credit_notes(id) on delete set null,
    amount_minor       bigint not null default 0,
    currency           text not null default 'USD',
    balance_before     numeric(12,2),
    balance_after      numeric(12,2),
    reference          text not null default '',
    provider_reference text not null default '',
    reason             text not null default '',
    actor_id           text references users(id) on delete set null,
    actor_name         text not null default '',
    actor_role         text not null default '',
    capability         text not null default '',
    idempotency_key    text not null unique,
    created_at         timestamptz not null default now()
  )`);
  await q(`create index if not exists finance_events_customer_idx
    on finance_events (customer_id, created_at desc)`);
  await q(`create index if not exists finance_events_invoice_idx on finance_events (invoice_id)`);
  await q(`create index if not exists finance_events_type_idx
    on finance_events (event_type, created_at desc)`);
  await q(`create index if not exists finance_events_created_idx
    on finance_events (created_at desc)`);
  /* Append-only, enforced by the database rather than by convention: a
     financial record that can be edited after the fact is not a record. */
  await q(`create or replace function finance_events_immutable() returns trigger as $$
    begin
      raise exception 'finance_events is append-only (% blocked)', tg_op;
    end $$ language plpgsql`);
  await q(`do $$ begin
    if not exists (select 1 from pg_trigger where tgname = 't_finance_events_no_update') then
      create trigger t_finance_events_no_update before update on finance_events
        for each row execute function finance_events_immutable();
    end if;
    if not exists (select 1 from pg_trigger where tgname = 't_finance_events_no_delete') then
      create trigger t_finance_events_no_delete before delete on finance_events
        for each row execute function finance_events_immutable();
    end if;
  end $$`);

  /* A payment recorded in error is VOIDED with a reason; the row stays. A
     delete would leave a balance movement nobody can explain. */
  await q(`alter table payments
    add column if not exists idempotency_key text,
    add column if not exists recorded_by text references users(id) on delete set null,
    add column if not exists notes text not null default '',
    add column if not exists voided_at timestamptz,
    add column if not exists voided_by text references users(id) on delete set null,
    add column if not exists void_reason text not null default ''`);
  await q(`create unique index if not exists payments_idempotency_idx
    on payments (idempotency_key) where idempotency_key is not null`);
  await q(`alter table payments drop constraint if exists payments_void_attributed`);
  await q(`alter table payments add constraint payments_void_attributed
    check (voided_at is null or void_reason <> '')`);

  await q(`alter table credit_notes
    add column if not exists currency text not null default 'USD',
    add column if not exists amount_minor bigint,
    add column if not exists invoice_id text references invoices(id) on delete set null,
    add column if not exists reference text not null default '',
    add column if not exists issued_by text references users(id) on delete set null,
    add column if not exists idempotency_key text`);
  await q(`create unique index if not exists credit_notes_idempotency_idx
    on credit_notes (idempotency_key) where idempotency_key is not null`);
  await q(`create index if not exists credit_notes_customer_idx
    on credit_notes (customer_id, issued_on desc)`);
  /* Existing rows are grandfathered by the `issued_by is null` clause: the
     constraint governs what this phase's API creates and does not retroactively
     invalidate history it cannot explain. */
  await q(`alter table credit_notes drop constraint if exists credit_notes_reasoned`);
  await q(`alter table credit_notes add constraint credit_notes_reasoned
    check (issued_by is null or reason <> '')`);

  /* An exception that is merely READ is not resolved. */
  await q(`alter table payment_events
    add column if not exists resolved_by text references users(id) on delete set null,
    add column if not exists resolved_at timestamptz,
    add column if not exists resolution_note text not null default ''`);
  await q(`alter table payment_events drop constraint if exists payment_events_status_valid`);
  await q(`alter table payment_events add constraint payment_events_status_valid
    check (status in ('received', 'processed', 'ignored', 'failed', 'resolved'))`);
  await q(`alter table payment_events drop constraint if exists payment_events_resolution_explained`);
  await q(`alter table payment_events add constraint payment_events_resolution_explained
    check (status <> 'resolved' or (resolved_at is not null and resolution_note <> ''))`);
}
