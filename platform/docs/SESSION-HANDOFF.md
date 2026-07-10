# Veyora — Session Handoff Summary

Snapshot of everything done and what's next, so a new chat can continue seamlessly.

## Status: THE NEW PLATFORM IS LIVE (2026-07-09)

The full production platform runs on the **IONOS VPS 209.46.125.226**
(SSH alias `veyora-vps`, key `~/.ssh/veyora_ionos`). Docker Compose stack in
`/opt/veyora`: Postgres 16 + Node API + Caddy. See `platform/docs/RUNBOOK.md`
for all operations.

- **Storefront** (rebuilt veyora.com portal): http://209.46.125.226/
- **Admin panel** (wired to real DB): http://209.46.125.226/admin/
- Waiting on DNS: point **veyora.design A record → 209.46.125.226** and it
  becomes https://veyora.design automatically (Caddy auto-HTTPS).
- Admin login: info@veyora.com (password given to user in chat — change it
  via My Account or seed-admin script).

### Data migrated
- 1,318 products / 3,982 variations / 31,286 units on hand from the Zoho
  `Item.csv` export (includes the 14 new Liv London models). Real Zoho
  creation dates preserved. Purchase prices + EANs stored per variation.
- 85 photos for the 14 Liv models imported and linked (55 variation-level).
- Pseudo-items (brand "shiping") imported inactive.

### Verified end-to-end
- Login, catalog + filters + search, product modal w/ photos, add-to-cart.
- Place order → stock allocation, **backorder auto-split** (tested: SO11877
  took available 16 units, BO5001 held the 85-unit shortfall — then reverted).
  Order numbering continues from the old system (SO11877+).
- Admin snapshot (full dataset) + row-diff sync (browser edit → Postgres, verified).
- Nightly DB backups (03:20, 14-day retention) — first backup taken.

## Repo layout (new)
- `platform/server/` — everything deployed: `docker-compose.yml`, `Caddyfile`,
  `api/` (Node/Express, all endpoints from `docs/OLD-API-MAP.md`),
  `db/migrations/` (schema + reporting views), `storefront/` (new customer
  portal, vanilla JS SPA), `admin-overrides/` (API-backed `data.js`/`app.js`
  that replace the demo layer at deploy), `deploy.sh` (one-command deploy),
  `api/scripts/` (import-zoho, import-photos, seed-admin).
- Repo root — the admin panel UI (unchanged; still the veyora.design demo
  until DNS flips; deploy overlays the API-backed data layer).
- `platform/docs/OLD-API-MAP.md` — extracted old veyora.com API surface.
- `platform/supabase/` — superseded (Supabase plan replaced by IONOS VPS).

## UPDATE 2026-07-10
- **veyora.design DNS is pointed and HTTPS is live** — the new platform serves
  at https://veyora.design (homepage), /#/products (guest catalog), /admin/.
- **Homepage rebuilt as an exact replica of old veyora.com** (hero carousel,
  Global Distribution map, collections collage, portfolio, Charlett video,
  CTA, footer, WhatsApp float wa.me/16467731000). All assets mirrored into
  `platform/server/storefront/assets/`. New `pages_home.js`; guest browsing
  supported (optionalAuth on get-products — guests see catalog, no prices).
- **Old-site catalog data + ALL photos migrated**: harvested the old public
  API (773 products) → `scripts/import-oldsite.mjs` enriched 653 products
  (display names, sizes, descriptions, attributes, real categories, variation
  colors, shelf codes) and downloaded 4,829 photos into the uploads volume.
  120 old-site products aren't in Zoho (discontinued) — skipped.
- User feedback: ALWAYS `git push` after committing.

## UPDATE 2026-07-10 (later) — customers + order history migrated
- Harvested from the **logged-in old veyora.com admin session** in the browser
  (session token in a readable cookie → replayed the admin API's own GET/POST
  read calls). Old admin API base: `veyora.com/veyora/api/admin/*`
  (`get-all-user`, `order-list` POST, `order-detail/:id`).
- Piped into the new platform via a one-time **/ingest** endpoint (key-gated,
  CORS) → `scripts/import-oldsite-data.mjs`.
- Imported: **157 customers** (status=pending, activate via email OTP once SMTP
  is on) and **1,117 historical orders** (998 linked to their customers by
  business name; 1,090 line-items so far). Real order numbers/dates/statuses/
  totals preserved; SO sequence bumped past imported numbers.
- The old site **rate-limits** bursts hard (429 + multi-minute cooldown). Safe
  sustained rate ≈ 100 req/min (~600ms spacing), sequential, not concurrent.
- INGEST_KEY is in `/opt/veyora/.env`. The ingest endpoint should be removed or
  the key rotated once migration is fully done.

## OPEN ITEMS
1. **SMTP**: need a Google App password for info@veyora.com so activation /
   order emails send (see RUNBOOK). Customers are imported as `pending` and
   can't log in until they activate — which needs email working first.
2. **Backfill remaining order line-items** (~967 of 1,117 orders have header
   only, no items yet, because of the old site's rate-limit block). Re-harvest
   `order-detail/:id` slowly (≤100/min) while logged into old veyora.com, POST
   to `/api/ingest/order-details`, re-run `import-oldsite-data.mjs`. Order
   headers/totals/history are already complete; this only fills per-order
   product breakdowns.
3. **Signed-in storefront pages** (customer-facing cart/checkout/product-detail
   with prices) are sensible but NOT pixel-replicas of the old site — those need
   a customer/agent login on the old storefront (admin panel doesn't show them).
4. **Stripe**: schema + payments table ready; checkout is on-terms (B2B) for
   now. Add Stripe keys + an endpoint when they want card payments.
5. **Zoho decommission**: keep dual-running until cutover confidence, then
   the platform is the single source of truth (Zoho export re-import is
   idempotent by SKU meanwhile).
6. Rotate the VPS root password (was pasted in chat) — key auth is set up.
7. veyora.com domain itself: later, point it at the VPS too (add to
   Caddyfile DOMAIN list) or keep as marketing.

## TRACK 1 — Old-system operational tasks (unchanged)
- ⚠️ Memo models 162/166/178/61/62/124/41/192/66 — not Zoho SKUs; likely
  field-sales sample cases. Confirm with Avichai/boss whether any system
  change is needed.
- 🔶 14 Liv London models: photos + products are now IN THE NEW PLATFORM.
  Old-site CSV upload (Products → Import CSV with
  `C:\Users\sunda\Downloads\veyora-liv-upload\*.csv`) still pending if they
  want them on the OLD site before cutover.

## Accounts involved
- veyora.com admin: Info@veyora.com · Zoho: info@veyora.com (org 875980504)
- IONOS VPS: root@209.46.125.226 (key auth; rotate password)
- Platform admin: info@veyora.com (role admin)
