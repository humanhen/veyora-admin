-- Supplier purchasing (the last Zoho-only capability): purchase orders with
-- receiving into stock. Items ride along as jsonb — the admin panel syncs
-- whole rows and nothing needs SQL-level access to individual lines.
create table if not exists purchase_orders (
  id          text primary key,
  number      text unique,
  supplier    text not null default '',
  status      text not null default 'ordered'
              check (status in ('draft','ordered','partially received','received','cancelled')),
  notes       text not null default '',
  expected_on date,
  items       jsonb not null default '[]',
  created_at  timestamptz not null default now()
);
create sequence if not exists po_number_seq;
