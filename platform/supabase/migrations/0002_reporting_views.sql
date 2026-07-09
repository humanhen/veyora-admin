-- ============================================================================
-- VEYORA — Reporting views
-- Migration 0002
--
-- These views make the "units sold" number unambiguous, which directly
-- answers the supplier-payment question: sold = actually fulfilled,
-- backorders are NEVER counted.
-- ============================================================================

-- Units actually SOLD per product model (excludes backorders / unshipped).
-- Reads order_items.collected_qty (what left the warehouse), NOT qty ordered.
create or replace view units_sold_by_model as
select
  split_part(oi.variation_sku, '.', 1) as model_sku,
  date_trunc('month', o.order_date)    as month,
  sum(oi.collected_qty)                as units_sold,       -- fulfilled only
  sum(oi.collected_qty * oi.price_cents) / 100.0 as revenue_usd
from order_items oi
join orders o on o.id = oi.order_id
where o.status <> 'cancelled'
group by 1, 2;

-- For contrast/audit: units ORDERED (includes not-yet-shipped). Use this only
-- to see the gap vs. sold — never for supplier payments.
create or replace view units_ordered_by_model as
select
  split_part(oi.variation_sku, '.', 1) as model_sku,
  date_trunc('month', o.order_date)    as month,
  sum(oi.qty)                          as units_ordered,
  sum(oi.qty - oi.collected_qty)       as units_backordered  -- the gap
from order_items oi
join orders o on o.id = oi.order_id
where o.status <> 'cancelled'
group by 1, 2;

-- Side-by-side: what you SHOULD pay suppliers on vs. what an ordered-based
-- number would wrongly inflate it to.
create or replace view supplier_reconciliation as
select
  s.model_sku,
  s.month,
  s.units_sold                          as pay_suppliers_on,   -- correct
  coalesce(ord.units_ordered, 0)        as if_counting_ordered,-- wrong (inflated)
  coalesce(ord.units_backordered, 0)    as backordered_not_shipped
from units_sold_by_model s
left join units_ordered_by_model ord
  on ord.model_sku = s.model_sku and ord.month = s.month;
