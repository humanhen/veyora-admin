# Veyora Platform — Onboarding

Read this first. It gets a new contributor productive without reading the whole history.
For the running change-log see [SESSION-HANDOFF.md](./SESSION-HANDOFF.md); for ops see [RUNBOOK.md](./RUNBOOK.md).

---

## 1. What this is

Veyora is a **B2B wholesale eyewear** business. This repo is a **from-scratch replacement**
for the old `veyora.com` storefront + admin (which was a React/MUI app backed by Zoho).

The new platform is **live at https://veyora.design** and is ready to become `veyora.com`
at cutover. It is designed to be the **single source of truth** — the goal is to retire Zoho
entirely, not integrate with it.

Business owner is **non-technical** and directs the build. Ship complete, verified work.

---

## 2. Status in one line

**Functionally done and load/pen/data tested — verdict GO-with-fixes (0 blockers).**
What remains is operational: schedule the cutover, wire Stripe, finish retiring Zoho, add
staff order-alerts. See §9.

---

## 3. Stack & hosting

- **Server:** IONOS VPS `209.46.125.226`, Ubuntu, Docker Compose in `/opt/veyora`.
  SSH alias **`veyora-vps`** (key auth already set up): `ssh veyora-vps "..."`.
- **Containers:** `veyora-db-1` (Postgres 16), `veyora-api-1` (Node/Express), `veyora-caddy-1` (Caddy, auto-HTTPS).
- **Surfaces** (all behind Caddy): `/` storefront · `/admin/` admin panel · `/api` API · `/s3` product images.
- **Repo:** `github.com/humanhen/veyora-admin`, branch `main`.
  Convention: **commit and push after every change** (owner preference). End commit messages with the
  `Co-Authored-By:` trailer.
- **Secrets:** all live in `/opt/veyora/.env` on the server (DB creds, JWT secret, Gmail SMTP,
  `PUBLIC_URL=https://veyora.design`). Admin login is `info@veyora.com` — get the password from the
  owner or `.env`; do not hard-code secrets in the repo.

---

## 4. Deploy

- **Everything:** `sh platform/server/deploy.sh` (builds the API image, tars the stack over SSH,
  recreates containers, waits for `/api/health`).
- **Frontend only (fast):** from `platform/server/`:
  `tar czf - storefront/css storefront/js storefront/index.html | ssh veyora-vps "tar xzf - -C /opt/veyora"`
- **Caddyfile / infra:** `scp platform/server/Caddyfile veyora-vps:/opt/veyora/Caddyfile && ssh veyora-vps "cd /opt/veyora && docker compose restart caddy"`
- CSS/JS/HTML are served `Cache-Control: no-cache` (ETag revalidation) so deploys reach browsers
  immediately. If you still see stale assets in a test tab, `fetch(url,{cache:'reload'})` then reload.

---

## 5. Repo layout

```
platform/server/
  docker-compose.yml, Caddyfile, deploy.sh
  db/migrations/        0001_schema.sql (schema), 0002_views.sql (reporting views)
  api/src/              Express API
    index.js            app + route mounts
    db.js  authmw.js  mail.js  emails.js  pricing.js  shape.js
    routes/  auth.js  catalog.js  cart.js  orders.js  account.js  agent.js  admin.js
  api/scripts/          import-zoho.mjs, import-oldsite.mjs (enrich+photos),
                        import-oldsite-data.mjs (customers+orders), fix-categories.mjs, seed-admin.mjs
  storefront/           customer SPA (vanilla JS, no framework)
    index.html  css/store.css
    js/  api.js  ui.js  app.js  pages_home.js  pages_auth.js  pages_catalog.js
         pages_cart.js  pages_orders.js  pages_account.js  pages_agent.js
    assets/             logos, hero images, login-hero.jpg
  admin-overrides/      API-backed data.js/app.js that OVERLAY the repo-root admin at deploy
platform/docs/          ONBOARDING.md (this), SESSION-HANDOFF.md, RUNBOOK.md, OLD-API-MAP.md
<repo root>  index.html, js/, css/   the ADMIN panel UI (demo look; deploy overlays the real data layer)
```

The storefront SPA is **hash-routed** (`#/products`, `#/cart`, …). `Routes[hash]` objects with a
`render(el, args)`; `route()` in `app.js` is the dispatcher (runs on `hashchange`/`DOMContentLoaded`).

---

## 6. API shape (things that surprise people)

- Routers mount as: `/auth/*`, **`/user/*`** (catalog + cart + orders + account + agent all live here,
  each router ignores paths it doesn't define), `/admin/*`, `/health`.
  → e.g. create-customer is `POST /api/user/create-customer`, not `/api/agent/...`.
- **Catalog:** `POST /user/get-products {search,brands[],genders[],materials[],types[],sizes[],isNew,inStockOnly,sort,page,perPage}`.
  Guests get products with **all prices null** (price-hiding is enforced server-side).
- **Auth:** cookie sessions (`veyora_access` 30m JWT + `veyora_refresh` 30d, both HttpOnly + Secure).
  Magic-link "set password" = a 3-day JWT → `#/set-password/<token>`.
- **Admin is NOT REST.** It's a **snapshot/sync** model: `GET /admin/snapshot` returns all collections;
  `POST /admin/sync {changes:[{collection,upserts,deletes}]}` applies them. `upsertProduct` **full-replaces**
  a product's variations + per-warehouse stock, so round-trip the whole object when editing.
  Editable collections incl. products, variations, stock (per warehouse: qty + shelf), users, warehouses,
  promotions, orders, backorders, plus a singleton `settings` blob.

---

## 7. Data & migration

Migrated and live: **~1,280 active products** (1,318 total) / 3,982 variations / stock, **~156 customers**,
**1,117 orders / 9,804 line items**. Sources:
- **Zoho `Item.csv` export** → `import-zoho.mjs` (products, variations, stock, prices, EANs; idempotent by SKU).
- **Old veyora.com** (harvested via its admin session) → `import-oldsite.mjs` enriched 653 products
  (names, categories, colors, attributes, seller badges) + 4,829 photos; `import-oldsite-data.mjs`
  brought customers + full order history.
- ~120 old-site products are discontinued / not in Zoho → intentionally absent (new site is inventory-driven).
- **Zoho is an import, not a live sync.** To refresh stock, re-run the import with a fresh export
  (idempotent). Long-term goal is to replace Zoho — see §9.

---

## 8. Key conventions & features (read before touching UI)

- **Old-site visual parity by MEASUREMENT, never eyeballing.** Open `veyora.com` in a browser, read
  exact `getComputedStyle` values, use fixed px with a single ~900px breakpoint (the old site is
  fixed desktop sizes, not viewport-scaled). Homepage, products, filters, product viewer, and login
  were all matched this way.
- **Filters** (`catalog.js`): gender / material / lens-type filter by the product's **`categories`** array
  (values like `Men`, `Women`, `Kids`, `Metal`, `Plastic`, `Acetate`, `Sunglasses`, `Eyeglasses`, `New`).
  **Brand** chips match the brand **category OR** the `brand` column (Zoho splits e.g. `Charlett` vs
  `Charlett Sunglass`; the old site groups them). **Sizes** map `M/L/Kids → Medium/Large/Small`.
  If a filter ever returns 0, suspect missing category data — `fix-categories.mjs` rebuilds categories
  from the old-site source (this fixed a Men/Women/Acetate = 0 bug).
- **Price hiding** — two mechanisms, both keyed off `Store.session.user.hidePrices` (every price reads it):
  - **Permanent:** per-account `hide_prices` (My Account toggle → server). `Store.realHide` mirrors it.
  - **Presentation mode:** a temporary, per-browser toggle (eye icon in the top bar, `Store.presenting`,
    persisted in `localStorage.veyora_present`) so an agent can hide their own prices to show frames to
    customers. Effective value = `realHide || presenting`, set in `applyPricingMode()`.
- **Guest vs customer product click:** guests → fullscreen image viewer (`imageLightbox`);
  logged-in customers → the ordering modal (`productModal`).
- **Default sort** demotes photoless products to the end (popular/newest only) so the landing page
  leads with real images.
- **Emails** (`emails.js`, Gmail SMTP): welcomeActivation, passwordReset, activationCode,
  orderConfirmation. Admin can bulk-send activation. Order confirmation goes to the **customer only**
  (no staff alert yet — see §9).

---

## 9. What's left (roadmap)

1. **Cutover** — pick a date; fresh Zoho stock import → final old-site order sync (before DNS flip) →
   point `veyora.com` A-record at `209.46.125.226` (add the host to Caddy's `DOMAIN`) → verify HTTPS →
   send the activation-email blast to 157 customers → rotate admin + VPS-root passwords + fresh Gmail
   app password. Rollback = revert the one DNS record (old site is untouched).
2. **Stripe** — not wired. Groundwork exists (a `payments` table + `stripePaymentIntent` field in
   `shape.js`); checkout is B2B **on-terms** today, same as the old site. Add SDK + keys + an endpoint.
3. **Fully retire Zoho** — core inventory (products, per-warehouse stock, prices) is already editable in
   admin. Confirm/build the last operational workflows the team uses Zoho for: **receiving stock**,
   **bulk product import** (there's a CSV path via script; wants an admin button), and **reports**.
4. **Order alerts** — no staff/warehouse notification fires on a new order (customer gets email; order is
   visible in the admin but nothing is pushed). Would add: alert email(s) + a settings field for recipients,
   backorder notice to customer, "back in stock" emails (the `restock_notifications` table captures intent
   but nothing sends yet), and shipped/ready emails.
5. **Off-site backups** — nightly DB backups run on the VPS (03:20, 14-day retention, restore verified),
   but they live on the same disk as the DB. Add an off-host copy.
6. **Cleanup before launch** — delete the test customer **`u_e35faedcf84e` "Claude Test Optics" #1001**
   and its leftover test orders (e.g. SO11879/SO11880 pending; SO11881/SO11882 cancelled by testing).

---

## 10. Gotchas / learnings

- **Migration harvest rate-limit:** the old veyora.com admin API bans hard (~150 req/window, then 10–16 min
  cooldown). If you ever re-harvest, pace ~1.1s wall-clock in driver-side batches; abort on the first 429.
- **Windows dev:** `git` prints harmless `LF will be replaced by CRLF` warnings. `node --check` files before
  deploying (there's no bundler/test suite yet — verification is manual + in-browser).
- **Browser tooling:** product pages lazy-load photos; screenshot tools can hang on image-heavy pages —
  prefer DOM/`getComputedStyle` assertions for verification, screenshots for final proof.
- **No live Zoho / Stripe:** don't assume either is connected (see §7, §9).
- **Security posture:** the one-time `/ingest` migration endpoint was removed; cookies are Secure; Caddy
  sends HSTS + `X-Content-Type-Options` + `X-Frame-Options` + `Referrer-Policy` and strips `X-Powered-By`.

---

## 11. First things to do

1. `ssh veyora-vps "cd /opt/veyora && docker compose ps"` — confirm the stack is up.
2. Open https://veyora.design as a guest, then log in (ask owner for a test login) and click around.
3. Skim `api/src/routes/catalog.js` (filters/sort) and `api/src/routes/orders.js` (order + stock + backorder
   allocation) — that's the commercial core.
4. Read `SESSION-HANDOFF.md` for the detailed dated history.
