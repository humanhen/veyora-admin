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

## UPDATE 2026-07-10 (evening) — emails live, product modal + lightbox matched
- **Branded HTML emails shipped & verified** (`api/src/emails.js`):
  welcomeActivation / passwordReset / activationCode / orderConfirmation.
  Wired into auth (activation + forgot), agent create-customer, admin
  `send-activation/:userId` + `send-activation-bulk`, order placement.
  Magic link = 3-day JWT → `#/set-password/<token>` storefront page.
  Verified live: welcome + order-confirmation emails sent via Gmail SMTP to
  the user's test gmail; set-password → login round-trip tested end-to-end.
  Test customer created for this: **u_e35faedcf84e "Claude Test Optics"
  (customer #1001)** — delete when no longer needed.
- **Product modal gallery**: big square image + zoom hint + thumbstrip;
  color rows jump the gallery; variation images merged into the gallery.
- **Fullscreen image viewer matched to old site by measurement**
  (getComputedStyle on veyora.com): white card #fafbfc r12, rgba(0,0,0,.2)
  backdrop, square stage min(78vh,85vw), 44px grey circle arrows, 38px close,
  dark title chip bottom-left, black color caption, 6→18px elongated active dot.
- Router now closes any open modal/lightbox overlay on hash navigation.
- **Line-item backfill COMPLETE**: all 522 remaining order details harvested
  (limiter learnings: ~150 requests per window then a 10-16 min ban; paced
  1.1s wall-clock in driver-side batches, proactive pause at ~140/window).
  Final DB: **1,117 orders / 9,804 line items**; the 97 orders without items
  have no products on the old site either (90 SO, 3 SHTP, 4 VEYO) — verified
  1:1 reconciliation. Order migration is DONE.
- **Ingest endpoint REMOVED** (routes/ingest.js deleted, mount removed,
  INGEST_KEY dropped from /opt/veyora/.env, API rebuilt; POST /api/ingest/*
  now 404s even with the old key).

## UPDATE 2026-07-13 — parity sweep + mobile hardening
- **Login page** rebuilt as an exact old-site /my-account replica (split
  photo left using the old site's login-hero-v3.jpg, warm-white panel right,
  eye toggle, WhatsApp float). Forgot-password now also activates pending
  users (so the removed "activate" link isn't needed).
- **Filter bar** matched to old site (M/L/Kids sizes, only "New", 8 public
  brands, measured chip/divider styling). Products page h1/badge/search/
  order-bar remeasured.
- **Mobile bulletproofing** (audited at 375px across home, products, modal,
  login, orders, cart, account, backorders, returns, favourites, reorder —
  scrollW==viewport everywhere, no page pan, no broken images):
  - collage full-bleed margin was overflowing → page could pan sideways;
    fixed + `overflow-x:clip` on html/body (hidden fallback).
  - **Mobile filters** = old-site pattern: chip bar hidden, a "Filters"
    button (in the header row) opens a bottom sheet holding the same chip
    bar (groups stacked). The sheet is a fade-in overlay pinned to the
    bottom — deliberately NO transform-slide, because a throttled/skipped
    transition was stranding it off-screen. Same `.fbar` node moves in/out
    so filter state + bindings stay live. Body scroll locks while open.
  - Products mobile: 2-col grid, 16px title, density toggle hidden, 12px pad.
- **Caddy**: `Cache-Control: no-cache` on *.css/*.js so deploys reach
  browsers immediately (ETag revalidation).
- Verified core commerce on desktop: product modal → qty → add-to-cart →
  cart line + total + badge → remove-from-cart all work.
- Parity caveat unchanged: signed-in customer pages (cart/checkout/orders)
  have no old-site reference to measure against (need a customer login on
  veyora.com); they're verified functional + overflow-clean, not pixel-matched.

## OPEN ITEMS
1. **SMTP**: need a Google App password for info@veyora.com so activation /
   order emails send (see RUNBOOK). Customers are imported as `pending` and
   can't log in until they activate — which needs email working first.
2. ~~Backfill remaining order line-items~~ **DONE 2026-07-10** — all orders
   that have items on the old site now have them here (9,804 line items).
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

## UPDATE 2026-07-15 — feedback round from the Veyora Development group
Source: WhatsApp (Sam / Yehuda / Avichai notes 7/14-7/15). All deployed to
veyora.design and verified live (measured via DOM, mobile 375px + desktop).
- **Liv London photos fixed server-side**: the 14 new models' raw 6000x4000
  studio shots (3.7MB each; 170 files incl. the admin-uploaded product
  copies) were square-cropped around the frame (bg-aware bbox, 7% margin,
  real backdrop kept — NOT white-padded) and capped at 2000px/~100KB.
  This was Yehuda's "pictures very small + viewer closes" report: 24MP
  images were letterboxing tiny in the square boxes and blowing up mobile
  Safari. Originals: uploads volume `products-orig-liv/` (~248MB).
- **No quantities anywhere** (Sam: "Copy the web. No quantities please"):
  stock pills now say just "in stock"; cart over-order note de-numbered.
- **Per-item price reveal** (Sam): presentation/hidden-price mode now shows
  a "Show price" eye-button per product modal; prices render pre-hidden
  (.pr-hidden) and toggle per item. Global eye toggle still enters/exits.
- **Swipe galleries**: bindSwipe() (ui.js) on modal stage + fullscreen
  viewer; drag-click suppression so a swipe never triggers zoom/close.
- **Notify me** reflects true subscription state (GET /user/restock-notify
  marks buttons; press flips to "✓ We'll email you").
- **Mobile fit**: modal color rows wrap 2 lines; order detail Price column
  hides <760px (Shipped→"Shp."); modal padding tightened. No page pans.
- **Returns exchange**: return_items.exchange_sku (migration 0003, applied
  live) end-to-end — form asks "Exchange for — SKU", API stores, customer
  list + admin return view show "exchange → SKU". Admin snapshot/upsert
  round-trips it.
- **Home**: motion video autoplays on scroll (IO + scroll fallback — IO
  alone can be throttled; plays/pauses on visibility). Footer links
  centered on mobile. Mobile home header = OG copy: centered 150px
  transparent logo only (measured veyora.com: toolbar justify center,
  logo 150px, bg transparent; pill/account hidden <=820px, home only).
- **Misc**: Favourites→Favorites (labels only, hashes/API unchanged); nav
  auto-scrolls active tab into view; modal stage borderless w/ multiply
  blend; tap-highlight + user-select killed on controls (iPad blue copy
  sign).
- Verification note: logged-in flows checked with a server-minted 45-min
  JWT for test customer u_e35faedcf84e (no password entry); cookie cleared
  after. Return-submit UI not exercised end-to-end (permission classifier);
  storage path proven via rolled-back SQL insert.
- **Still open from the group chat**: Zoho API connection (Sam: "connect it
  to Zoho first of all... APIs") — needs Zoho OAuth credentials/decision;
  and Sam's broader "cleaner, more international" design pass (base layout
  explicitly kept per his message).
- Avichai's 7:01-7:13pm notes are about the **AmeriSelect USA app**, not
  veyora — tracked separately, nothing done here.

## UPDATE 2026-07-16 — Zoho live sync CONNECTED and running
- Credentials installed in /opt/veyora/.env (self client under
  info@veyora.com, org 875980504, scope ZohoInventory.FullAccess.all).
- First sync: 3,983 Zoho items / 3,982 matched / 264 stock corrections /
  0 price changes / 1 new SKU auto-created (95011 "WARRANTY KYME") /
  0 local-only SKUs. 14s. Runs every 30 min; summary in settings.zohoSync,
  each run in audit_log.
- The 264 stock corrections = drift since the July-10 CSV import — this was
  the "copied data isn't ready" complaint; it can't drift anymore.
- Zoho hygiene worth doing (their side): mark WARRANTY KYME + test items
  (ANDRII_TEST_0001, "111") Inactive in Zoho so they stay off the site —
  local deactivation gets overwritten because Zoho is authoritative.
- Still open: order push (site orders → Zoho sales orders) not built;
  needed only if they fulfill/account out of Zoho during dual-running.

## UPDATE 2026-07-17 — customer dashboard (post-login landing) migrated
The old site's /dashboard index page (lazy chunk Dashboard-CRGwRZTJ.js —
missed in the original route sweep) is now rebuilt: '#/dashboard' with the
old page's exact content in the new panel style. Stat tiles (Total Orders
w/ This month / Last 90 days / Year to date picker, Items in Cart + total,
Backorders open + "N ready to approve", Returns open — all clickable),
"Time to reorder" (cadence "Every Nd" / "Overdue by Nd" computed from
first/last order dates + distinct order count, now returned by
/user/replenishment), shortcuts My Account / Cart / Report a defect
(→ returns, same as old). Login now lands on '#/dashboard' (was products);
logo click → dashboard. Money respects hide-prices/presentation mode.
NOT migrated (old dashboard had them, super-agent only): sales-coaching
leaderboard / team widgets — no super-agents active; revisit if needed.
Verified live desktop+mobile with test-customer session; cookie cleared.

## UPDATE 2026-07-17 (later) — old-site app layout under 900px
Moshe compared old vs new side by side and asked for old-site look. Decoded
the old PrivateLayout chunk: below 900px (MUI md) it runs an app shell.
Now replicated on veyora.design for logged-in users at <=900px:
- topbar = burger + centered logo (desktop >900 unchanged: left logo,
  icon buttons, top tab nav)
- bottom tab bar exactly like old: Home (public home), Products,
  Spare parts, Cart (badge), My Account (-> dashboard, like old)
- burger drawer: Dashboard + full nav + presentation-mode toggle
  (fade-in pattern, no transform transitions — throttle-proof)
- products page <=900: filters behind the Filters button (breakpoint
  raised 760->900 to match old), "Total: $X + Cart" row under search
  (hidden for guests and in presentation mode)
- dashboard restyled to old look: welcome card + "Manage your orders,
  account, and explore our latest products." subtitle, icon-chip tiles
  (bag/cart/$/clock/undo) incl. separate Cart Total tile (hidden when
  prices hidden)
Verified live at 830px (the comparison width), and 1280px desktop
unchanged. Old desktop (lg 1200+) actually uses a permanent 280px left
sidebar — NOT replicated; our approved top-tab desktop stays.

## UPDATE 2026-07-17 (evening) — colorway regrouping (Sam: "missing colors")
Sam's tablet photo showed Essedue cards with one color circle each. Cause:
brands whose Zoho SKUs have no dot (Essedue VEDETTE-2002, Kyme CAMERON-1,
Spike/Puro/Laura dash styles) were imported as one product per colorway.
Nothing was missing — 202 Essedue colorways existed as 202 cards vs the
old site's 55 grouped models.
Fix: scripts/regroup-oldsite.mjs (kept in repo, idempotent) regrouped
using the old site's own public catalog as truth (snapshot at
data/import/old-products.json on the VPS): moved 330 variations across
103 models, deleted 323 empty per-colorway products. DB 1318->996
products, all 3,983 variations intact. DB backup taken first
(veyora-20260717-1723.sql.gz).
Zoho sync made grouping-agnostic: product rollup now groups items by the
owning product of each variation (not sku-dot parsing), and brand-new
dash colorways attach to their siblings' product instead of creating a
new card. Post-regroup sync verified: 3983/3983 matched, 0 new, no error.
Old parents with synthetic SKUs (312-LAU, Spike414...) were already
grouped via dot-SKUs — skipped correctly.
