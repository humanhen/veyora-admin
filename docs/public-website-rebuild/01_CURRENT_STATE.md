# 01 — Current State

Factual audit of the repository as it stands on branch `mathew/public-website-rebuild`
(working tree clean, HEAD `8637f49`). Every statement below is traceable to a file in the
repository. Nothing here was inferred from a rendered page or from a production system.

---

## 1. Repository map

```
veyora-admin/
├── index.html, css/styles.css, js/*.js      ADMIN PANEL SPA (vanilla, no build)
├── assets/                                   admin avatar + logout gif
├── CNAME                                     "veyora.design"  (legacy GitHub Pages artefact)
├── docs/
│   ├── mobile-app-handover/                  (empty)
│   └── public-website-rebuild/               (this document set)
└── platform/
    ├── docs/                                 6 platform documents (build plan, runbook,
    │                                         onboarding, old-API map, SOW analyses, handoff)
    ├── supabase/migrations/                  SUPERSEDED — abandoned Supabase plan, not deployed
    └── server/                               EVERYTHING THAT DEPLOYS
        ├── docker-compose.yml                db (postgres:16) + api + caddy
        ├── Caddyfile                         reverse proxy + static hosting
        ├── deploy.sh                         tar-over-ssh to IONOS VPS
        ├── .env.example                      documented, secret-free template
        ├── db/migrations/                    0001..0006 plain SQL, run by initdb
        ├── api/                              Node 22 / Express 4 / pg
        │   ├── src/                          18 modules, 7 routers
        │   ├── scripts/                      10 one-off import / migration scripts
        │   └── test/                         27 node:test files
        └── storefront/                       CUSTOMER PORTAL SPA + the public homepage
            ├── index.html                    single hash-routed shell
            ├── css/store.css                 806 lines — app + editorial homepage
            ├── js/                           12 modules
            └── assets/                       logos, hero/product photography, video
```

Two separate front-ends are deployed from this one repository: the **admin panel** (repo root,
served at `/admin/`) and the **storefront** (`platform/server/storefront`, served at `/`). They
share no CSS, no JS and no design language.

---

## 2. Deployment and infrastructure — PROTECTED, DO NOT MODIFY

**`platform/server/docker-compose.yml`** — three services:

| Service | Image / build | Notes |
|---|---|---|
| `db` | `postgres:16-alpine` | `db/migrations` mounted read-only into `docker-entrypoint-initdb.d`; healthcheck gates the API |
| `api` | build `./api` | 27 environment variables, all optional except `DATABASE_URL` / `JWT_SECRET` |
| `caddy` | `caddy:2-alpine` | ports 80/443, mounts storefront, admin and the uploads volume read-only |

**`platform/server/Caddyfile`** — one reusable `(veyora_site)` snippet imported by both `:80`
and `{$DOMAIN}`. Handler order:

1. `/api/*` → strip prefix → `reverse_proxy api:3000`
2. `/s3/*` → `file_server` from `/srv/uploads` (product photography)
3. `/admin/*` → admin SPA with `try_files {path} /index.html`
4. everything else → storefront SPA with `try_files {path} /index.html`

Security headers are already set (HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `-X-Powered-By`, `-Server`). `encode gzip` is on. CSS/JS/HTML are served
`no-cache` so deploys reach browsers immediately.

**The final `handle` block is the single most important fact for this project:** the storefront
SPA is the catch-all, and `try_files … /index.html` means *every* unmatched path returns the SPA
shell with **HTTP 200**. There is no 404 status anywhere on the public site. The specification
makes a true 404 a P0 launch requirement and an explicit definition-of-done item.

**`deploy.sh`** — `tar czf - … | ssh veyora-vps "tar xzf - -C /opt/veyora"`, then
`docker compose up -d --build`, then a 30×2s health poll against `/api/health`. It writes `.env`
**only on first run** and never touches an existing one. Target host `veyora-vps`
(`209.46.125.226`), destination `/opt/veyora`.

**Status: untouched.** No file in `platform/server` other than new additive ones should change,
and the compose/Caddy/deploy files require an explicit, reviewed change when the public site is
added — planned in `04_TARGET_ARCHITECTURE.md` §5 and gated behind the domain decision.

---

## 3. Public surface as it exists today

### 3.1 The HTML shell — `platform/server/storefront/index.html` (53 lines)

Everything the crawler receives on every route:

```html
<title>Veyora — Wholesale Eyewear</title>
<meta name="description" content="Veyora — wholesale eyewear for optical retailers. Browse
      frames, colours and sizes; sign in for pricing and to order." />
<meta property="og:url" content="https://veyora.design/" />
<meta property="og:image" content="https://veyora.design/assets/logo-white.svg" />
<body class="notranslate">
  <div id="app"></div>
  <div id="toasts"></div>
  … 12 <script> tags …
```

Observations, each of which maps to a specification requirement:

- **One title, one description, one OG package for the entire site.** Requirement: unique per
  indexable route.
- **Empty `<div id="app">`.** No H1, no body copy, no links in the initial response.
  Requirement: meaningful HTML before hydration.
- **`og:url` and `og:image` hard-code `veyora.design`.** Requirement: canonical production
  domain, self-referential absolute canonicals. There is no `<link rel="canonical">` at all.
- **No `robots` meta, no `robots.txt`, no sitemap, no favicon file** (`/favicon.svg` is
  referenced but absent from the repository), **no structured data**.
- **A Meta Pixel fires on load and on every `hashchange`.** This is the only analytics present.
  There is no GA4, no consent gate and none of the ten events the specification requires.
- **Google Fonts is loaded from a third-party origin** (`fonts.googleapis.com` /
  `fonts.gstatic.com`), Montserrat, seven weights. The specification asks for self-hosted subset
  fonts where licensing permits, and this is also an LCP and privacy consideration.
- **`translate="no"` / `notranslate`.** Deliberate on a pricing app; must be reconsidered for a
  public marketing site the specification wants machine-readable and potentially localised.

### 3.2 The router — `platform/server/storefront/js/app.js`

`route()` reads `location.hash`, splits `#/segment/arg/arg`, looks the segment up in a `Routes`
registry and renders into `#app`. `document.title` is assigned client-side. There is no History
API use anywhere in the storefront. Unknown hashes silently fall back to `Routes['#/']` — a soft
404 with a 200 status **and** the homepage content, which is worse than a shell.

Public (`public: true`) or session-optional (`optional: true`) routes today:

| Hash route | Module | Public? |
|---|---|---|
| `#/`, `#/home` | `pages_home.js` | public — the editorial marketing homepage |
| `#/products` | `pages_catalog.js` | optional — guest catalogue, prices hidden |
| `#/login`, `#/set-password/<jwt>` | `pages_auth.js` | public |
| `#/list/<slug>` | `pages_lists.js` | optional — shared curated frame list |

Everything else (`#/orders`, `#/cart`, `#/dashboard`, `#/account`, `#/backorders`, `#/returns`,
`#/favourites`, `#/replenishment`, `#/spare-parts`, `#/customers`, `#/lists`) requires a session
and redirects to `#/login` with a `veyora_after_login` handoff.

### 3.3 The editorial homepage — the visual source of truth

`pages_home.js` renders seven composed sections plus header, footer and a WhatsApp float:

1. asymmetric split hero (single campaign photograph, `fetchpriority="high"`)
2. three-item retailer value strip (numbered 01/02/03)
3. "collections in focus" — copy plus a paired photographic composition
4. full-bleed campaign statement with a directional scrim
5. product portfolio — one feature shot plus a three-up detail row
6. "Veyora in motion" — a framed, auto-playing, muted, looping video
7. dark closing CTA
8. dark footer with four links and a dynamic copyright year

The source carries unusually good design documentation: crop percentages chosen against the
actual photographs, rejected alternatives with reasons, explicit statements of what is
deliberately absent (the retired global distribution map). This is treated as authoritative
design intent in `02_VISUAL_SYSTEM_INVENTORY.md`.

**Content-wise it is thin against the specification.** It has no proof strip, no brand cards, no
commercial-architecture module, no portal preview, no "what Veyora does" answer paragraph, no
Request B2B Account CTA and no real footer information architecture — the four footer links all
point at `#/` except the WhatsApp link. Three of the four are dead links to the homepage:
`Privacy policy`, `Terms of service` and `Accessibility Statement`.

### 3.4 The guest catalogue — `pages_catalog.js`

The nearest thing to the specification's `/collections/` page. It has a real filter language
already: a search field, four filter groups (Lens type: Sunglasses/Eyeglasses; Gender:
Men/Women/Kids; Size: M/L/Kids; Material: Metal/Plastic/Acetate), a "New" chip, an eight-brand
chip row, a density toggle, a mobile bottom-sheet filter drawer, a clear-all control and
sessionStorage filter persistence.

Against the specification this is the right shape and the wrong mechanics: filter state lives in
`sessionStorage`, not in the URL, so no filter state is shareable, linkable, crawlable or
indexable; results are fetched by `POST /user/get-products`, so nothing is in the initial HTML;
there is no shape facet; there is no per-model page — product detail is a **modal**, and the
specification requires every "View Details" action to reach one stable public URL.

---

## 4. API — `platform/server/api`

Node 22, Express 4, `pg`, `jsonwebtoken`, `bcryptjs`, `nodemailer`, `multer`, `csv-parse`.
No framework beyond Express, no ORM, no build step. `src/index.js` mounts:

| Mount | Router | Auth |
|---|---|---|
| `/health` | inline | none |
| `/auth` | `routes/auth.js` | none (login, activation OTP, password reset) |
| `/user` | `catalog`, `cart`, `orders`, `account`, `agent` (all five on the same prefix) | `requireAuth()` except three catalogue paths |
| `/admin` | `routes/admin.js` | `requireAuth()` + role |

`app.use((req,res) => res.status(404).json({error:'not found'}))` — the API does return a real
404. The error handler logs and maps to 500/413. `startServer()` **fails closed**: if
`ensureSchema()` fails the process exits non-zero rather than serving against a schema it does
not have.

### 4.1 The existing public/private boundary — the most reusable asset in the repository

`src/authmw.js`:

```js
export function optionalAuth() { … req.user = { id: null, role: 'guest', hide_prices: true,
                                                country: 'US', pricing: {mode:'none'},
                                                status: 'active' }; … }
```

`src/routes/catalog.js` applies it to exactly three paths and then suppresses, for guests:

| Field | Guest treatment | Line reference |
|---|---|---|
| `price`, `basePrice`, variation `price` | `null` (via `hide_prices`) | `loadProducts()` |
| variation `qty`, product `qty` | collapsed to `1` / `0` — availability only, never depth | `guest ? (vqty > 0 ? 1 : 0) : vqty` |
| `total` (catalogue size) | `null`; guests get `hasMore` only | `getProducts()` |
| `tags` matching `/^label:/i` | stripped | `loadProducts()` |
| brand facet | filtered through `PUBLIC_BRANDS` (8 names) | `/product-filter-data` |
| `priceRange` facet | omitted entirely for guests | `/product-filter-data` |
| `productId` on shared-list frames | `undefined` for guests | `framesForSkus()` |

`PUBLIC_BRANDS = ['Charlett','Essedue','Extreme','Kyme','Laura Ferre','Liv London','Puro','Spike']`
— eight names, matching `FILTER_BRANDS` in the storefront. **This is the current de-facto answer
to the specification's brand-count question, and it lists Essedue and Kyme separately.** It is a
hard-coded constant in two places, not data, and it does not include Extreme Next.

### 4.2 Performance pattern worth reusing

`catalog.js` maintains two short-lived caches: `_catalogRows` (raw DB rows, identical for
everyone) and `_shapedCache` keyed by a pricing signature, both 60 s TTL, invalidated by
`invalidateCatalogCache()` on admin product edits. All guests share one shaped entry. The
comment records that shaping ~1,000 products cost ~1 s per filter click before this existed.
The public site will have exactly the same read pattern and should reuse the approach.

### 4.3 Full public/private route inventory

**Never public** — every one of these must be unreachable from, and unreferenced by, the public
site: all of `/admin/*`; `/user/get-cart`, `/add-to-cart`, `/delete-cart-item*`, `/cart-item-note`,
`/cart-item-labels`, `/cart/drafts*`, `/promotions/*`; `/user/place-order`, `/get-user-orders`,
`/get-order-detail/:id`, `/repeat-order`, `/orders/:orderId/items/:itemId`; `/user/backorders*`,
`/returns*`, `/invoices`, `/invoice/:id`; `/user/get-user-detail`, `/checkout-context`, `/fx`,
`/update-profile`, `/change-password`, `/toggle-hide-prices`, `/get-addresses`,
`/save-*-address`, `/shipping-info`, `/shipping-options`, `/favourites*`, `/restock-notify`,
`/replenishment`, `/scan-tray`, `/*spare-part*`; `/user/customer-list`, `/create-customer`,
`/my-customer/:id`, `/update-customer/:id`, `/sa/leads`, `/tasks*`;
`/user/products/top-sellers` and `/user/new-since-last-login` (both require a session and both
are commercially sensitive).

**Currently guest-reachable:** `/user/get-products`, `/user/product-filter-data`,
`/user/shared-lists/:slug`.

---

## 5. Database — `platform/server/db/migrations` (0001–0006)

PostgreSQL 16, plain SQL, text primary keys with app-style prefixes (`u_ab12cd`), money as
`numeric(12,2)`, status/role fields as `text` + `CHECK`.

**Tables (28):** `warehouses`, `users`, `products`, `variations`, `stock`, `orders`,
`order_items`, `backorders`, `backorder_items`, `returns`, `return_items`, `promotions`,
`campaigns`, `invoices`, `payments`, `credit_notes`, `collection_flags`, `shipping_rules`,
`free_shipping`, `leads`, `chains`, `suitcases`, `email_templates`, `tasks`, `audit_log`,
`settings`, `cart_items`, `cart_drafts`, `favourites`, `addresses`, `spare_parts`,
`restock_notifications`, `refresh_tokens`, `otp_codes`, `shared_lists`.

### 5.1 What the catalogue model gives the public site

`products`: `sku` (model number, unique), `name`, `description`, `brand` (plain text),
`size`, `ean`, `categories text[]`, `tags text[]`, `images text[]` (paths under `/s3/`),
`attributes jsonb`, `price`, `sale_price`, `production_status`, `estimated_arrival`,
`is_active`, `zoho_item_id`, `created_at`, `updated_at`. GIN index on `categories`, btree on
`brand`.

`variations`: `sku` (e.g. `20894.1`), `color`, `image`, `price`, `sale_price`,
`purchase_price` **(supplier cost — must never surface publicly)**, `ean`, `stock_status`,
`is_active`, `zoho_item_id`.

`attributes` keys in active use (from `pages_catalog.js`): `lens_w`, `lens_h`, `bridge`,
`temple`, `lens_type`, `case_code`.

### 5.2 Content-model gaps, precisely

| Specification requirement | Present? | Note |
|---|---|---|
| Brand entity | **No** | `products.brand` is free text; brands exist only as a hard-coded 8-name array in JS |
| Brand publication status / slug / metadata / story / origin fields | **No** | — |
| Model publication status separate from `is_active` | **No** | `is_active` is an ordering flag, not a publication flag |
| Canonical slug for a model | **No** | Only `sku`; URL-safety unverified |
| Public model description separate from internal | **No** | One `description` column, populated from the old-site import |
| Shape attribute | **No** | Filter groups cover lens type, gender, size, material — no shape |
| Material as a structured field | **Partial** | Present as a `categories[]` value (Metal/Plastic/Acetate), not a model-level verified claim |
| Colour code vs colour name vs variant SKU | **Partial** | `variations.color` is one free-text field |
| Media rights / expiry / alt text | **No** | `images text[]` is bare paths |
| Discontinued state + replacement pointer | **No** | — |
| Location records | **No** | — |
| Policy records | **No** | — |
| Resource articles | **No** | — |
| Form definitions + consent version + retention | **No** | — |
| Governance: source reference, fact owner, verification status, last reviewed, scheduled review | **No** | Nothing anywhere in the schema |
| Redirect / slug-history table | **No** | — |

`leads` exists (`business`, `email`, `contact`, `phone`, `city`, `agent_id`, `rating`, `stage`,
`questionnaire jsonb`, `visits jsonb`, `customer_id`) and is an **agent-facing CRM record**, not a
public web-form submission. It carries no source URL, campaign parameters, form type, consent
timestamp or delivery state. It should not be repurposed; a separate `form_submissions` table is
proposed.

`audit_log` exists and is a good precedent for the governance/review-trail requirement.

---

## 6. Tests — `platform/server/api/test` (27 files)

Run with `node --test "test/*.test.js"`. No test runner dependency, no browser, no fixtures
server. Two distinct kinds:

**API/domain tests** — `ordering`, `pricing`, `allocation`, `commercial-allocation`,
`stock-guard`, `backorder-state`, `backorder-conversion`, `checkout-submission`,
`cart-snapshot`, `display-currency`, `assisted-*` (3), `sync-race`, `postcommit`,
`terminal-delete`, `credential-migration`, `emails`, `email-plaintext`, `config`, `startup`,
`module-wiring`, `admin-*` (3).

**Source-level front-end tests** — `landing-map.test.js` (28 KB) and `storefront-modal.test.js`
(18 KB) read the real storefront files off disk, strip comments, and assert on markup and CSS
rules. `landing-map.test.js` is written as an *inverted* guard: it asserts the retired
distribution map cannot come back, and checks the editorial homepage that replaced it.

**Consequence for this project:** `landing-map.test.js` and `storefront-modal.test.js` are
pinned to the current storefront source. They must keep passing. The new public site must be a
**new** application with its **own** test suite rather than a mutation of
`platform/server/storefront`, or these gates will have to be rewritten — which the brief
forbids at this phase and which would destroy a genuine regression guard.

**What is not tested anywhere today:** HTTP status codes, response headers, rendered HTML,
metadata, structured data, accessibility, colour contrast, keyboard behaviour, responsive
layout, visual regression, performance budgets, crawlability, redirects, sitemaps.

---

## 7. Assets

`platform/server/storefront/assets/`:

| Asset | Notes |
|---|---|
| `logo-black.svg`, `logo-white.svg` | 1,793 bytes each, intrinsic 937×125 |
| `home/hero-01..10` | `.webp`, 20–229 KB; hero-04, -05, -10, -02 in active use |
| `home/product-shot-01..04.webp` | 27–42 KB, 4:5 studio frames |
| `home/charlett-video.mp4` + `charlett-poster.webp` | 3.69 MB video, 18.5 KB poster |
| `login-hero.jpg` | 519 KB — **unoptimised JPEG, no WebP/AVIF sibling** |
| `landing/veyora-global-distribution-map.webp`, `global-distribution-map-B9WDMC-1.webp` | 187 KB + 155 KB, **orphaned** — the map concept was retired |
| Product photography | 4,829 files, **not in the repository** — they live in the `veyora_uploads` Docker volume, served at `/s3/…` |

No favicon file. No OG share image other than the white logo SVG (which will render poorly as a
social card). No AVIF anywhere. No `srcset` anywhere.

---

## 8. Reuse / extend / replace / protect / missing

### Reuse as-is
- Design tokens, type scale, component language and motion of the editorial homepage
- Guest identity model (`optionalAuth`) and every guest suppression rule in `catalog.js`
- The `_catalogRows` / `_shapedCache` caching pattern
- Docker Compose stack shape, Caddy snippet structure, security headers, `deploy.sh` mechanics
- `emails.js` branded transactional email for form confirmations
- `audit_log` as the precedent for governance trails
- Product/variation/stock tables as the catalogue source of truth
- `node:test` as the test runner

### Extend
- `products` — publication state, canonical slug, public description, shape, verified materials, governance fields
- `variations` — colour code separate from colour name, image-to-variant mapping, media alt text
- Guest suppression — promote from ad-hoc conditionals to one enforced serializer with a test that no forbidden key can appear
- Caddyfile — one new handler for the public site, one changed catch-all
- `deploy.sh` — ship the new web build artefact
- Admin panel — minimal editing surfaces for the new content entities (brand copy, publication, governance)

### Replace
- Hash routing → path-based routing with real HTTP statuses
- Empty SPA shell → server-rendered HTML per route
- Client-assigned `document.title` → per-route server-rendered metadata, canonical, OG/Twitter
- Product modal as the only detail view → indexable model pages, with the modal retained inside the portal
- `sessionStorage` filter state → URL query state with a defined indexing policy
- The four dead footer links → a real footer information architecture
- Meta Pixel as the only analytics → the specification's ten-event model with consent control
- Third-party Google Fonts → self-hosted subset (licence permitting)

### Protect — do not touch
- `mathew/monday-release` and everything deployed from it
- All 27 existing tests
- Every authenticated route and its auth middleware
- `pricing.js`, `ordering.js`, `inventory.js`, `zoho.js`, `credential-migration.js`
- `.env`, `.env.example`, `docker-compose.yml`, `Caddyfile`, `deploy.sh` — until the domain and
  portal decisions are made and the change is reviewed
- `platform/server/storefront/**` — the working portal; the public site is additive, not a rewrite

### Missing entirely
Path routing · server-rendered HTML · per-route metadata · canonical tags · structured data ·
`robots.txt` · sitemaps · true 404/500 · redirects · breadcrumbs · brand pages · model pages ·
category landings · Why Veyora · Service Model · Private Label · Global Presence · Resources ·
seven policy/support routes · Contact and Request B2B forms · CRM handoff · consent · analytics
events · image `srcset`/AVIF · self-hosted fonts · favicon · OG images · accessibility statement ·
placeholder register · any browser-based test.

### Migration risk register (detail in `08_RISKS_AND_OPEN_DECISIONS.md`)
1. Portal URL change breaks live sessions, password-reset emails and circulated shared-list links
2. Caddy catch-all reordering — a mistake serves the portal SPA at every public URL, or vice versa
3. Legacy `#/` URLs in the wild cannot be redirected server-side (fragments are not transmitted)
4. `CNAME` (`veyora.design`) is a stale GitHub Pages artefact and a live duplicate-domain hazard
5. Product photography is a Docker volume, not repository content — the public site's image
   pipeline depends on infrastructure the build cannot see
6. `PUBLIC_BRANDS` duplicated in API and storefront; the brand-count decision must change both
7. `landing-map.test.js` / `storefront-modal.test.js` pin the current storefront source
8. Zoho sync (30-minute cadence) can change catalogue content under a cached or prerendered page
9. No legacy URL inventory exists in the repository
10. `platform/supabase/` is superseded and misleading to a newcomer
