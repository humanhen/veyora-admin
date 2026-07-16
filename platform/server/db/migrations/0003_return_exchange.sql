-- Exchanges must say which frame the customer wants instead (2026-07-15,
-- requested by the boss: "have the exchange also make them choose another frame").
alter table return_items add column if not exists exchange_sku text;
