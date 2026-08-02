-- A fully backordered checkout creates NO orders row, so until now the only
-- durable record of that request was backorders + backorder_items: customer,
-- SKUs, quantities and prices. Everything else the order carried — who placed
-- it, the currency and the rate it was struck at, the addresses, the promotion
-- that applied, the shipping decision and the customer's note — existed only in
-- the request that created it, and was gone by the time staff converted it.
--
-- These columns give a backorder its own context so conversion can rebuild a
-- faithful order. Partial backorders still link to their originating order and
-- may derive from it; a full backorder now stands on its own.
--
-- Idempotent (add column if not exists), and mirrored in api/src/migrate.js so
-- an existing database picks it up on the next deploy without a manual psql
-- step — the migrations directory only runs on a fresh volume.

alter table backorders add column if not exists agent_id         text references users(id) on delete set null;
alter table backorders add column if not exists source           text not null default 'customer';
alter table backorders add column if not exists currency         text not null default 'USD';
alter table backorders add column if not exists fx_rate          numeric(12,6) not null default 1;
alter table backorders add column if not exists shipping_address jsonb;
alter table backorders add column if not exists billing_address  jsonb;
alter table backorders add column if not exists promo            jsonb;
alter table backorders add column if not exists discount         numeric(12,2) not null default 0;
alter table backorders add column if not exists free_shipping    boolean not null default false;
alter table backorders add column if not exists shipping         numeric(12,2) not null default 0;
alter table backorders add column if not exists comments         jsonb not null default '[]';

-- The customer's own authorisation, kept separate from `eligible`.
-- `customer_authorised` = the customer asked for it knowing it was unavailable.
-- `eligible`            = staff/stock have cleared it for conversion.
-- Conflating the two would make a backorder look convertible the moment it was
-- created, which asserts stock nobody has checked.
alter table backorders add column if not exists customer_authorised boolean not null default false;

create index if not exists backorders_customer_idx on backorders (customer_id);
create index if not exists backorders_status_idx   on backorders (status);
