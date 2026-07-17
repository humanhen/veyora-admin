-- Orders placed on the site are pushed to Zoho Inventory as sales orders
-- while Zoho is authoritative (Sam: "I should see it in Zoho").
alter table orders add column if not exists zoho_so_id text;
