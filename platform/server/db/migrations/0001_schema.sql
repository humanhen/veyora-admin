-- ============================================================================
-- VEYORA platform — core schema (plain PostgreSQL 16)
-- Runs automatically on first container boot (docker-entrypoint-initdb.d).
--
-- Design notes:
--  * text primary keys with app-style prefixed ids ("u_ab12cd") so the admin
--    panel's row objects map 1:1 with no id translation.
--  * status/role fields are text + CHECK using the admin panel's exact strings.
--  * money is numeric(12,2) dollars (matches admin + storefront payloads).
-- ============================================================================

create or replace function veyora_id(prefix text) returns text as $$
  select prefix || '_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
$$ language sql volatile;

-- ---------- warehouses ----------
create table warehouses (
  id          text primary key default veyora_id('wh'),
  code        text unique not null,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ---------- users ----------
create table users (
  id               text primary key default veyora_id('u'),
  customer_number  text unique,
  username         text unique,
  first_name       text not null default '',
  last_name        text not null default '',
  email            text unique not null,
  phone            text not null default '',
  business         text not null default '',
  tax_id           text not null default '',
  country          text not null default 'US',
  address          text not null default '',
  city             text not null default '',
  state            text not null default '',
  zip              text not null default '',
  role             text not null default 'customer'
                   check (role in ('customer','special customer','agent','super-agent','warehouse','admin')),
  agent_id         text references users(id) on delete set null,
  payment_terms    int not null default 30,
  hide_prices      boolean not null default false,
  status           text not null default 'pending'
                   check (status in ('pending','active','disabled')),
  pricing          jsonb not null default '{"mode":"none"}',
  balance          numeric(12,2) not null default 0,
  protected        boolean not null default false,
  password_hash    text,
  last_login_at    timestamptz,
  prev_login_at    timestamptz,          -- for "new since last login"
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on users (role);
create index on users (agent_id);
create index on users (status);

-- ---------- products & variations ----------
create table products (
  id                 text primary key default veyora_id('p'),
  sku                text unique not null,          -- model number, e.g. '20894'
  name               text not null,
  description        text not null default '',
  brand              text not null default '',
  size               text not null default '',
  ean                text not null default '',
  categories         text[] not null default '{}',
  tags               text[] not null default '{}',
  images             text[] not null default '{}',  -- paths under /s3/
  attributes         jsonb not null default '{}',   -- lens_w, bridge, lens_h, temple, lensType, caseCode
  price              numeric(12,2),
  sale_price         numeric(12,2),
  production_status  text not null default 'none',
  estimated_arrival  date,
  is_active          boolean not null default true,
  zoho_item_id       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on products (brand);
create index on products using gin (categories);

create table variations (
  id            text primary key default veyora_id('v'),
  product_id    text not null references products(id) on delete cascade,
  sku           text unique not null,               -- e.g. '20894.1'
  color         text not null default '',
  image         text,
  price         numeric(12,2),
  sale_price    numeric(12,2),
  purchase_price numeric(12,2),               -- supplier cost (from Zoho)
  ean           text not null default '',
  stock_status  text not null default 'in stock'
                check (stock_status in ('in stock','out of stock','in production')),
  is_active     boolean not null default true,
  zoho_item_id  text,
  created_at    timestamptz not null default now()
);
create index on variations (product_id);

create table stock (
  variation_id  text not null references variations(id) on delete cascade,
  warehouse_id  text not null references warehouses(id) on delete cascade,
  qty           int not null default 0,
  shelf         text not null default '',
  primary key (variation_id, warehouse_id)
);

-- ---------- orders ----------
create sequence order_number_seq start 11877;

create table orders (
  id            text primary key default veyora_id('o'),
  number        text unique not null,
  customer_id   text references users(id) on delete set null,
  agent_id      text references users(id) on delete set null,
  source        text not null default 'customer' check (source in ('customer','agent')),
  status        text not null default 'pending'
                check (status in ('pending','processing','approved','collecting','collected','completed','shipped','cancelled')),
  order_date    date not null default current_date,
  discount      numeric(12,2) not null default 0,
  discount_pct  numeric(5,2) not null default 0,
  free_shipping boolean not null default false,
  shipping      numeric(12,2) not null default 0,
  total         numeric(12,2) not null default 0,
  tracking      jsonb,                              -- {company, number}
  comments      jsonb not null default '[]',
  invoice_id    text,
  shipping_address jsonb,
  billing_address  jsonb,
  promo         jsonb,                              -- applied promotion snapshot
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on orders (customer_id);
create index on orders (agent_id);
create index on orders (status);
create index on orders (order_date);

create table order_items (
  id           text primary key default veyora_id('oi'),
  order_id     text not null references orders(id) on delete cascade,
  sku          text not null,                       -- variation sku
  name         text not null default '',
  color        text not null default '',
  qty          int not null,
  collected    int not null default 0,              -- fulfilled qty (drives "units sold")
  price        numeric(12,2) not null,
  note         text not null default '',
  labels       jsonb not null default '[]',
  created_at   timestamptz not null default now()
);
create index on order_items (order_id);
create index on order_items (sku);

-- ---------- backorders ----------
create sequence backorder_number_seq start 5001;
create table backorders (
  id                  text primary key default veyora_id('bo'),
  number              text unique not null,
  order_id            text references orders(id) on delete set null,
  order_number        text,
  customer_id         text references users(id) on delete set null,
  status              text not null default 'open' check (status in ('open','approved','converted','cancelled')),
  reason              text not null default 'out of stock',
  eligible            boolean not null default false,
  converted_order_id  text references orders(id) on delete set null,
  created_at          timestamptz not null default now()
);
create table backorder_items (
  id            text primary key default veyora_id('boi'),
  backorder_id  text not null references backorders(id) on delete cascade,
  sku           text not null,
  name          text not null default '',
  color         text not null default '',
  qty           int not null,
  price         numeric(12,2) not null
);

-- ---------- returns ----------
create sequence return_number_seq start 3001;
create table returns (
  id            text primary key default veyora_id('rt'),
  number        text unique not null,
  customer_id   text references users(id) on delete set null,
  order_number  text,
  status        text not null default 'open' check (status in ('open','closed')),
  notes         text not null default '',
  created_at    timestamptz not null default now()
);
create table return_items (
  id          text primary key default veyora_id('rti'),
  return_id   text not null references returns(id) on delete cascade,
  sku         text not null,
  name        text not null default '',
  qty         int not null,
  price       numeric(12,2) not null,
  resolution  text not null default 'credit' check (resolution in ('credit','exchange'))
);

-- ---------- promotions & campaigns ----------
create table promotions (
  id                text primary key default veyora_id('pr'),
  name              text not null,
  description       text not null default '',
  active            boolean not null default true,
  starts_on         date,
  ends_on           date,
  countries         text[] not null default '{US,CA}',
  audience          text not null default 'all',
  customer_ids      text[] not null default '{}',
  agent_ids         text[] not null default '{}',
  min_qty           int not null default 0,
  max_per_customer  int not null default 0,
  max_total         int not null default 0,
  ctx_customer      boolean not null default true,
  ctx_agent         boolean not null default true,
  reward_type       text not null default 'percent'
                    check (reward_type in ('tiered','percent','fixed','free_shipping')),
  tiers             jsonb,
  percent           numeric(5,2),
  fixed             numeric(12,2),
  used_count        int not null default 0,
  created_at        timestamptz not null default now()
);
create table campaigns (
  id          text primary key default veyora_id('cp'),
  name        text not null,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

-- ---------- invoices, payments, credit notes ----------
create sequence invoice_number_seq start 70001;
create table invoices (
  id            text primary key default veyora_id('in'),
  number        text unique not null,
  order_id      text references orders(id) on delete set null,
  order_number  text,
  customer_id   text references users(id) on delete set null,
  amount        numeric(12,2) not null,
  provider      text not null default '',
  status        text not null default 'paid',
  issued_on     date not null default current_date,
  created_at    timestamptz not null default now()
);
create table payments (
  id            text primary key default veyora_id('pay'),
  customer_id   text references users(id) on delete set null,
  amount        numeric(12,2) not null,
  method        text not null default 'transfer'
                check (method in ('transfer','check','credit_card','cash','stripe')),
  reference     text not null default '',
  paid_on       date not null default current_date,
  stripe_payment_intent text,
  created_at    timestamptz not null default now()
);
create table credit_notes (
  id           text primary key default veyora_id('cn'),
  customer_id  text references users(id) on delete set null,
  amount       numeric(12,2) not null,
  reason       text not null default '',
  issued_on    date not null default current_date,
  created_at   timestamptz not null default now()
);

-- ---------- collections (receivables flags) ----------
create table collection_flags (
  id            text primary key default veyora_id('cf'),
  customer_id   text references users(id) on delete cascade,
  status        text not null default 'flagged' check (status in ('flagged','resolved')),
  auto          boolean not null default false,
  notes         text not null default '',
  days_overdue  int not null default 0,
  last_payment  date,
  log           jsonb not null default '[]',
  created_at    timestamptz not null default now()
);

-- ---------- shipping ----------
create table shipping_rules (
  id         text primary key default veyora_id('sr'),
  country    text not null,
  threshold  numeric(12,2) not null default 0,
  cost       numeric(12,2) not null default 0,
  active     boolean not null default true
);
create table free_shipping (
  id           text primary key default veyora_id('fs'),
  customer_id  text references users(id) on delete cascade,
  day_of_week  int not null,
  active       boolean not null default true
);

-- ---------- CRM ----------
create table leads (
  id             text primary key default veyora_id('ld'),
  business       text not null,
  email          text not null default '',
  contact        text not null default '',
  phone          text not null default '',
  city           text not null default '',
  agent_id       text references users(id) on delete set null,
  rating         int not null default 3,
  stage          text not null default 'Prospecting',
  questionnaire  jsonb not null default '{}',
  visits         jsonb not null default '[]',
  customer_id    text references users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create table chains (
  id          text primary key default veyora_id('ch'),
  name        text not null,
  owner_id    text references users(id) on delete set null,
  branch_ids  text[] not null default '{}',
  created_at  timestamptz not null default now()
);
create table suitcases (
  id          text primary key default veyora_id('sc'),
  agent_id    text references users(id) on delete cascade,
  name        text not null,
  trays       jsonb not null default '[]',
  created_at  timestamptz not null default now()
);
create table email_templates (
  id          text primary key default veyora_id('et'),
  name        text not null,
  language    text not null default 'EN',
  purpose     text not null default '',
  subject     text not null default '',
  body        text not null default '',
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------- internal tasks ----------
create table tasks (
  id           text primary key default veyora_id('tk'),
  subject      text not null,
  assigned_to  text references users(id) on delete set null,
  created_by   text references users(id) on delete set null,
  status       text not null default 'open',
  messages     jsonb not null default '[]',
  created_at   timestamptz not null default now()
);

-- ---------- audit log ----------
create table audit_log (
  id          text primary key default veyora_id('ev'),
  actor_id    text,
  actor_name  text not null default 'System',
  actor_role  text not null default 'system',
  action      text not null,
  target      text not null default '—',
  source      text not null default 'web',
  changes     text not null default '',
  payload     jsonb,
  undone      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on audit_log (created_at desc);
create index on audit_log (action);

-- ---------- settings (singleton) ----------
create table settings (
  id    int primary key default 1 check (id = 1),
  data  jsonb not null default '{"sellingFastThreshold":20,"cartRecovery":{"enabled":false,"delayHours":24,"minValue":50}}'
);
insert into settings (id) values (1);

-- ============================================================================
-- Storefront-side tables (features from the old veyora.com portal)
-- ============================================================================

create table cart_items (
  id          text primary key default veyora_id('ci'),
  user_id     text not null references users(id) on delete cascade,
  sku         text not null,                        -- variation sku
  qty         int not null default 1,
  note        text not null default '',
  labels      jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  unique (user_id, sku)
);

create table cart_drafts (
  id          text primary key default veyora_id('cd'),
  user_id     text not null references users(id) on delete cascade,
  name        text not null default '',
  items       jsonb not null default '[]',          -- [{sku, qty, note, labels}]
  created_at  timestamptz not null default now()
);

create table favourites (
  user_id     text not null references users(id) on delete cascade,
  product_id  text not null references products(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, product_id)
);

create table addresses (
  id          text primary key default veyora_id('ad'),
  user_id     text not null references users(id) on delete cascade,
  kind        text not null check (kind in ('billing','shipping')),
  name        text not null default '',
  business    text not null default '',
  phone       text not null default '',
  address     text not null default '',
  city        text not null default '',
  state       text not null default '',
  zip         text not null default '',
  country     text not null default 'US',
  is_default  boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on addresses (user_id);

create table spare_parts (
  id          text primary key default veyora_id('sp'),
  user_id     text not null references users(id) on delete cascade,
  model       text not null default '',
  part        text not null default '',
  notes       text not null default '',
  image       text,
  status      text not null default 'open',
  created_at  timestamptz not null default now()
);

create table restock_notifications (
  user_id     text not null references users(id) on delete cascade,
  sku         text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, sku)
);

create table refresh_tokens (
  token_hash  text primary key,
  user_id     text not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index on refresh_tokens (user_id);

create table otp_codes (
  id          text primary key default veyora_id('otp'),
  user_id     text not null references users(id) on delete cascade,
  purpose     text not null check (purpose in ('activation','forgot_password')),
  code        text not null,
  expires_at  timestamptz not null,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------- shared frame lists ----------
-- A curated set of frames behind one shareable link (veyora.design/#/list/<slug>).
-- Staff paste a list of SKUs (model or model.color); the storefront resolves
-- them to products at view time. Public — guests see frames, prices hidden.
create table shared_lists (
  slug        text primary key,
  name        text not null default '',
  skus        text[] not null default '{}',
  created_by  text references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index on shared_lists (created_at desc);

-- ---------- updated_at auto-touch ----------
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end $$ language plpgsql;
create trigger t_users_touch    before update on users    for each row execute function touch_updated_at();
create trigger t_products_touch before update on products for each row execute function touch_updated_at();
create trigger t_orders_touch   before update on orders   for each row execute function touch_updated_at();

-- ---------- default warehouses ----------
insert into warehouses (id, code, name) values
  ('wh_main',    'main_fulfillment', 'Main Fulfillment'),
  ('wh_reserve', 'reserve',          'Reserve (backstock)');
