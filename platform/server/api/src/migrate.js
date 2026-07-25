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
}
