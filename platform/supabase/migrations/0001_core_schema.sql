-- ============================================================================
-- VEYORA — Core database schema (Supabase / PostgreSQL)
-- Migration 0001: commerce foundation
--
-- Field names mirror the admin panel's data model so wiring is 1:1.
-- Money is stored in cents (integer) to avoid float rounding.
-- Multi-currency: USD is the base; CAD/EUR optional per row.
-- ============================================================================

-- ---------- extensions ----------
create extension if not exists "pgcrypto";      -- gen_random_uuid()

-- ---------- enums ----------
do $$ begin
  create type user_role       as enum ('customer','special_customer','agent','super_agent','warehouse','admin');
  create type account_status  as enum ('pending','active','disabled');
  create type order_status    as enum ('pending','processing','approved','collecting','collected','completed','shipped','cancelled');
  create type order_source     as enum ('customer','agent');
  create type stock_status     as enum ('in_stock','out_of_stock','in_production');
  create type backorder_status as enum ('open','converted','cancelled');
  create type backorder_reason as enum ('out_of_stock','manual');
  create type return_status    as enum ('open','closed');
  create type return_resolution as enum ('credit','exchange');
  create type promo_reward     as enum ('tiered','percent','fixed','free_shipping');
  create type pricing_mode     as enum ('none','tier','cart','brand','sku');
  create type payment_method   as enum ('transfer','check','credit_card','cash','stripe');
  create type flag_status      as enum ('flagged','resolved');
exception when duplicate_object then null; end $$;

-- ---------- warehouses ----------
create table warehouses (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,          -- e.g. 'main_fulfillment','reserve'
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ---------- users (customers, agents, staff) ----------
create table users (
  id                uuid primary key default gen_random_uuid(),
  auth_id           uuid unique,             -- links to Supabase auth.users
  customer_number   text unique,             -- auto-generated business number
  username          text,
  first_name        text,
  last_name         text,
  email             text unique not null,
  phone             text,
  business          text,
  tax_id            text,
  country           text default 'US',       -- 'US' | 'CA'
  address           text,
  city              text,
  state             text,
  zip               text,
  role              user_role not null default 'customer',
  agent_id          uuid references users(id) on delete set null,
  payment_terms     int not null default 30, -- credit days
  hide_prices       boolean not null default false,
  status            account_status not null default 'pending',
  -- custom pricing (one active mode)
  pricing_mode      pricing_mode not null default 'none',
  pricing_cart_pct  numeric(5,2),            -- cart % discount
  pricing_tiers     jsonb,                   -- {"3500":3000,...} price-cents by tier
  pricing_brands    jsonb,                   -- {"Liv London":10,...} % by brand
  pricing_skus      jsonb,                   -- {"20894.1":6000,...} price-cents by sku
  balance_cents     bigint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index on users (role);
create index on users (agent_id);
create index on users (status);

-- ---------- products ----------
create table products (
  id              uuid primary key default gen_random_uuid(),
  sku             text unique not null,      -- model number, e.g. '20894'
  name            text not null,
  description     text,
  brand           text,
  size            text,
  ean             text,
  categories      text[] not null default '{}',
  tags            text[] not null default '{}',
  price_usd_cents      int,
  price_cad_cents      int,
  price_eur_cents      int,
  sale_usd_cents       int,
  sale_cad_cents       int,
  sale_eur_cents       int,
  -- frame attributes
  attr_lens_w     int,
  attr_lens_h     int,
  attr_bridge     int,
  attr_temple     int,
  attr_lens_type  text,
  attr_case_code  text,
  images          text[] not null default '{}',   -- storage paths
  is_active       boolean not null default true,
  zoho_item_id    text,                      -- link back to Zoho during migration
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on products (brand);
create index on products using gin (categories);

-- ---------- variations (color/SKU of a model) ----------
create table variations (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references products(id) on delete cascade,
  sku             text unique not null,      -- e.g. '20894.1'
  color           text,
  image           text,
  price_usd_cents int,
  sale_usd_cents  int,
  stock_status    stock_status not null default 'in_stock',
  zoho_item_id    text,
  created_at      timestamptz not null default now()
);
create index on variations (product_id);

-- ---------- stock per warehouse ----------
create table stock (
  variation_id  uuid not null references variations(id) on delete cascade,
  warehouse_id  uuid not null references warehouses(id) on delete cascade,
  qty           int not null default 0,
  shelf         text,
  primary key (variation_id, warehouse_id)
);

-- ---------- orders ----------
create table orders (
  id              uuid primary key default gen_random_uuid(),
  number          text unique not null,      -- 'SO11877'
  customer_id     uuid references users(id) on delete set null,
  agent_id        uuid references users(id) on delete set null,
  source          order_source not null default 'customer',
  status          order_status not null default 'pending',
  order_date      date not null default current_date,
  discount_cents  int not null default 0,
  discount_pct    numeric(5,2) not null default 0,
  free_shipping   boolean not null default false,
  shipping_cents  int not null default 0,
  total_cents     int not null default 0,
  tracking_company text,
  tracking_number  text,
  invoice_id      uuid,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on orders (customer_id);
create index on orders (agent_id);
create index on orders (status);
create index on orders (order_date);

-- ---------- order items ----------
create table order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  variation_sku text not null,
  name          text,
  color         text,
  qty           int not null,
  -- fulfilled quantity: what was actually collected/shipped.
  -- Supplier "units sold" reporting reads collected_qty, NOT qty ordered,
  -- so backordered (unfulfilled) units are excluded by design.
  collected_qty int not null default 0,
  price_cents   int not null,
  created_at    timestamptz not null default now()
);
create index on order_items (order_id);
create index on order_items (variation_sku);

-- ---------- backorders ----------
create table backorders (
  id              uuid primary key default gen_random_uuid(),
  number          text unique not null,      -- 'BO5001'
  order_id        uuid references orders(id) on delete set null,
  customer_id     uuid references users(id) on delete set null,
  status          backorder_status not null default 'open',
  reason          backorder_reason not null default 'out_of_stock',
  eligible        boolean not null default false,
  converted_order_id uuid references orders(id) on delete set null,
  created_at      timestamptz not null default now()
);
create table backorder_items (
  id            uuid primary key default gen_random_uuid(),
  backorder_id  uuid not null references backorders(id) on delete cascade,
  variation_sku text not null,
  name          text,
  color         text,
  qty           int not null,
  price_cents   int not null
);

-- ---------- returns ----------
create table returns (
  id            uuid primary key default gen_random_uuid(),
  number        text unique not null,        -- 'RT3001'
  customer_id   uuid references users(id) on delete set null,
  order_number  text,
  status        return_status not null default 'open',
  created_at    timestamptz not null default now()
);
create table return_items (
  id            uuid primary key default gen_random_uuid(),
  return_id     uuid not null references returns(id) on delete cascade,
  variation_sku text not null,
  name          text,
  qty           int not null,
  price_cents   int not null,
  resolution    return_resolution not null
);

-- ---------- promotions ----------
create table promotions (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text,
  active          boolean not null default true,
  starts_on       date,
  ends_on         date,
  countries       text[] not null default '{US,CA}',
  audience        text not null default 'all',   -- all | specific | agents
  customer_ids    uuid[] not null default '{}',
  agent_ids       uuid[] not null default '{}',
  min_qty         int not null default 0,
  max_per_customer int not null default 0,
  max_total       int not null default 0,
  ctx_customer    boolean not null default true,
  ctx_agent       boolean not null default true,
  reward_type     promo_reward not null,
  tiers           jsonb,                          -- [{"buy":20,"free":2}]
  percent         numeric(5,2),
  fixed_cents     int,
  used_count      int not null default 0,
  created_at      timestamptz not null default now()
);

-- ---------- invoices ----------
create table invoices (
  id            uuid primary key default gen_random_uuid(),
  number        text unique not null,
  order_id      uuid references orders(id) on delete set null,
  order_number  text,
  customer_id   uuid references users(id) on delete set null,
  amount_cents  int not null,
  provider      text,                          -- 'Green Invoice' | 'QuickBooks'
  status        text not null default 'paid',
  issued_on     date not null default current_date,
  created_at    timestamptz not null default now()
);
alter table orders add constraint orders_invoice_fk
  foreign key (invoice_id) references invoices(id) on delete set null;

-- ---------- payments & credit notes ----------
create table payments (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references users(id) on delete set null,
  amount_cents  int not null,
  method        payment_method not null,
  reference     text,
  paid_on       date not null default current_date,
  stripe_payment_intent text,
  created_at    timestamptz not null default now()
);
create table credit_notes (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references users(id) on delete set null,
  amount_cents  int not null,
  reason        text,
  issued_on     date not null default current_date,
  created_at    timestamptz not null default now()
);

-- ---------- collection flags ----------
create table collection_flags (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references users(id) on delete cascade,
  status        flag_status not null default 'flagged',
  auto          boolean not null default false,
  notes         text,
  days_overdue  int not null default 0,
  last_payment  date,
  activity      jsonb not null default '[]',   -- [{type,outcome,notes,at}]
  created_at    timestamptz not null default now()
);

-- ---------- shipping ----------
create table shipping_rules (
  id              uuid primary key default gen_random_uuid(),
  country         text not null,
  threshold_cents int not null default 0,
  cost_cents      int not null default 0,
  active          boolean not null default true
);
create table free_shipping (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references users(id) on delete cascade,
  day_of_week   int not null,                -- 0=Sun..6=Sat
  active        boolean not null default true
);

-- ---------- CRM: leads, chains, suitcases, email templates ----------
create table leads (
  id            uuid primary key default gen_random_uuid(),
  business      text not null,
  email         text,
  contact       text,
  phone         text,
  city          text,
  agent_id      uuid references users(id) on delete set null,
  rating        int not null default 3,
  stage         text not null default 'Prospecting',
  questionnaire jsonb not null default '{}',
  visits        jsonb not null default '[]',
  customer_id   uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create table chains (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid references users(id) on delete set null,
  branch_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create table suitcases (
  id         uuid primary key default gen_random_uuid(),
  agent_id   uuid references users(id) on delete cascade,
  name       text not null,
  trays      jsonb not null default '[]',    -- [{size:6,slots:[...]}]
  created_at timestamptz not null default now()
);
create table email_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  language   text not null default 'EN',
  purpose    text,
  subject    text,
  body       text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- production tracking ----------
create table production (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid references products(id) on delete cascade,
  eta         date,
  created_at  timestamptz not null default now()
);

-- ---------- internal tasks ----------
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  subject      text not null,
  assigned_to  uuid references users(id) on delete set null,
  created_by   uuid references users(id) on delete set null,
  status       text not null default 'open',
  messages     jsonb not null default '[]',
  created_at   timestamptz not null default now()
);

-- ---------- audit log (append-only) ----------
create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  actor_name  text,
  actor_role  text,
  action      text not null,
  target      text,
  source      text not null default 'web',   -- web | csv | cron | api
  changes     text,
  payload     jsonb,
  undone      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on audit_log (created_at desc);
create index on audit_log (action);

-- ---------- settings (single row) ----------
create table settings (
  id                       int primary key default 1,
  selling_fast_threshold   int not null default 20,
  cart_recovery_enabled    boolean not null default false,
  cart_recovery_delay_hours int not null default 24,
  cart_recovery_min_cents  int not null default 5000,
  constraint settings_singleton check (id = 1)
);
insert into settings (id) values (1) on conflict do nothing;

-- ---------- updated_at auto-touch ----------
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end $$ language plpgsql;
create trigger t_users_touch   before update on users   for each row execute function touch_updated_at();
create trigger t_products_touch before update on products for each row execute function touch_updated_at();
create trigger t_orders_touch  before update on orders  for each row execute function touch_updated_at();
