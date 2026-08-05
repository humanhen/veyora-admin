# 04 — Target Architecture

One firm recommendation, the reasoning behind it, the rejected alternatives, the public/private
boundary, and the minimal data-model additions required.

---

## 1. Recommendation

> **Build the public website as an Astro 5 application in `output: 'server'` mode using the
> `@astrojs/node` standalone adapter, deployed as a new `web` service in the existing Docker
> Compose stack behind the existing Caddy, reading public data exclusively through a new
> read-only `/public/*` surface on the existing Express API.**

Nothing about the authenticated portal, the admin panel, the database or the API's existing
routers changes. The public site is **additive**: one new container, one new Express router, one
new Caddy handler, and a set of additive SQL migrations. The single behavioural change to
existing infrastructure is that the Caddy catch-all stops being the portal SPA — and that change
is gated behind the domain and portal decisions.

---

## 2. Why this, against the alternatives

The evaluation criteria come straight from the brief and the specification: clean path routes,
direct URL requests, meaningful initial HTML, route-specific metadata, true 404s, brand/model/
category pages, public catalogue filtering, sitemap generation, structured data, redirects,
public/private separation, compatibility with Express/PostgreSQL, Caddy/VPS deployment, low local
overhead, and maintainability by Claude Code and the employer.

### 2.1 Astro 5, server mode — **recommended**

| Criterion | Assessment |
|---|---|
| Preserves the existing design language | **Strongest.** `.astro` components are HTML with a frontmatter script. The existing storefront is hand-authored HTML strings and hand-authored CSS. Porting `pages_home.js` markup and the `hm-*` CSS block into `.astro` components is close to a copy, with no JSX translation, no CSS-in-JS and no component-library idiom to fight. |
| Meaningful initial HTML | First-class. Zero client JavaScript by default; every route is server-rendered. |
| Route-specific metadata, canonicals, OG | Trivial — plain `<head>` content computed in frontmatter. No metadata framework to learn. |
| True 404 / 500 | `404.astro` and `500.astro` return real status codes in server mode. |
| Catalogue freshness | Server-rendered per request with an in-process cache mirroring the API's existing 60-second pattern. No rebuild orchestration for a 1,318-product catalogue synchronised from Zoho every 30 minutes. |
| Interactive islands | Filters, model gallery, mobile menu and forms hydrate individually. Everything else ships as HTML. Directly serves the INP budget. |
| Content layer | Content Collections give the policy, resource and article layer schema validation, typed frontmatter and build-time errors when a required governance field is missing — which is exactly what `REQ-CM-024`–`REQ-CM-026` demand. |
| Images | Built-in responsive image handling with `srcset`, `sizes`, width/height and AVIF/WebP output. Closes `REQ-GC-023`, `REQ-RAP-017` and `REQ-SEO-035` without hand-rolling a pipeline. |
| Sitemaps / redirects | Official sitemap integration; redirects are a first-class config plus middleware. |
| Deployment fit | `astro build` produces a self-contained Node server. One `Dockerfile`, one compose service, one Caddy handler. The stack already does this three times over. |
| Local overhead | `astro dev` is light. Dependency tree is roughly a third of a Next.js app. |
| Maintainability | Small conceptual surface: file-based routes, `.astro` files, a handful of directives. A non-specialist can read a route file and see the whole page. |

### 2.2 Next.js — **rejected**

Capable, and would satisfy every technical requirement. Rejected because it is disproportionate
to the problem and hostile to the constraint that matters most here.

- Introduces React to a repository with zero React. The design system would have to be
  re-expressed as JSX components — the highest-risk possible way to satisfy "preserve the
  existing visual language exactly".
- App Router, server components, caching semantics and the `next/image` loader are a materially
  larger learning and review surface than the problem justifies for ~25 routes.
- Heavier install, slower builds, larger local footprint — directly against "low local-machine
  overhead".
- Its main advantage (a large React ecosystem) is worth nothing here: the site has four
  interactive islands and no application state.

### 2.3 Server-rendered Express templates — **rejected, but retained as the fallback**

The closest runner-up, and genuinely attractive: zero new frameworks, the public routes could
live in the existing API container with direct `pool` access, and total control over HTML,
status codes, canonicals and XML.

Rejected because the specification demands a large amount of infrastructure that Astro provides
and a template engine does not: responsive image derivatives with `srcset`/AVIF; a validated
content layer with required governance fields; per-island hydration boundaries; asset
fingerprinting and bundling; sitemap generation; and a component model disciplined enough to keep
25 routes consistent. Every one of those becomes bespoke code that must then be tested and
maintained. The estimated additional build cost is 120–180 hours, and the resulting system is
less legible to a future maintainer than a conventional Astro app.

It remains the documented fallback if Astro is rejected for organisational reasons. If taken, use
Eta or Nunjucks in a **separate `web` container** — not inside the API process — so the public
site cannot accidentally import `pricing.js` or `ordering.js`.

### 2.4 Pure static generation — **rejected**

An 1,318-product catalogue with ~4,000 variations, resynchronised from Zoho every 30 minutes,
would require rebuild-on-change orchestration (webhook → build → deploy) that does not exist and
would be the most fragile part of the system. Catalogue staleness would also directly contradict
`REQ-COL-005` ("cards must use actual inventory data").

**Static generation is still used, selectively**: routes with no live data — `/why-veyora/`,
`/service-model/`, `/private-label/`, `/global-presence/`, all seven policy routes, `/resources/`
and articles — are prerendered with `export const prerender = true`. Everything catalogue-driven
is server-rendered. This is Astro's per-route prerender flag, not a second architecture.

---

## 3. Application shape

```
platform/server/web/                      ← NEW. Nothing outside this directory is rewritten.
├── Dockerfile
├── package.json
├── astro.config.mjs
├── public/
│   ├── robots.txt                        generated at build from the indexing policy
│   └── favicon.svg, favicon.ico, apple-touch-icon.png, site.webmanifest
└── src/
    ├── styles/
    │   ├── tokens.css                    ported from store.css hm-* block (02_VISUAL_SYSTEM_INVENTORY §6)
    │   └── base.css
    ├── layouts/
    │   ├── Base.astro                    <head>, metadata, schema slot, skip link, landmarks
    │   └── Page.astro                    header + breadcrumb + main + footer
    ├── components/
    │   ├── nav/       Header, MobileMenu, Footer, Breadcrumbs
    │   ├── blocks/    Hero, ProofStrip, BenefitGrid, CtaBand, AnswerBlock, ProcessSteps,
    │   │              PortalPreview, Accordion, FactTable, RelatedLinks
    │   ├── catalog/   BrandCard, ModelCard, FilterPanel (island), Gallery (island), Pagination
    │   └── forms/     Form (island), Field, ErrorSummary, ConsentBlock
    ├── lib/
    │   ├── api.ts                        typed client for /public/*
    │   ├── seo.ts                        title/description/canonical/OG/Twitter builder
    │   ├── schema.ts                     JSON-LD builders, one per type
    │   ├── indexing.ts                   THE indexing policy — robots meta + canonical per state
    │   ├── placeholders.ts               placeholder token resolution + registry
    │   └── nav.ts                        single navigation config
    ├── content/                          Astro Content Collections (schema-validated)
    │   ├── policies/                     shipping, warranty-and-exchanges, ordering-guide,
    │   │                                 privacy-policy, terms, accessibility
    │   └── resources/                    guides and articles
    ├── middleware.ts                     redirects, canonical host, security headers
    └── pages/                            file-based routes → 05_ROUTE_TEMPLATE_MATRIX
```

**Islands — the complete list.** Everything else is static HTML.

1. `FilterPanel` — catalogue and brand filtering, URL-state driven, `client:load`
2. `Gallery` — model colour/variant selector, `client:visible`
3. `MobileMenu` — navigation overlay, `client:media="(max-width: 900px)"`
4. `Form` — client-side validation enhancement over a working no-JS form, `client:load`

---

## 4. The public data surface

### 4.1 Principle

The public site must not be able to read a price, a stock depth, a customer or an order **even
if a template asks for one**. Today that is enforced by conditionals scattered through
`loadProducts()` and `getProducts()`. That is good discipline but it is not a boundary, because a
future contributor adding a field to the shaped object gets no warning.

**Move enforcement to one allowlist serializer with a test that cannot be satisfied by a leak.**

### 4.2 New Express router — `platform/server/api/src/routes/public.js`

Mounted at `/public`. No authentication. No access to `pricing.js`, `ordering.js`,
`inventory.js` or the `users`, `orders`, `carts`, `invoices` or `payments` tables. It builds its
responses through `src/public-serialize.js`, which is a **pure allowlist**: it constructs a fresh
object from named fields and never spreads a database row.

| Endpoint | Returns |
|---|---|
| `GET /public/brands` | published brands: slug, name, segment, summary, logo, hero, tier label, counts |
| `GET /public/brands/:slug` | one brand: full record + featured models + verified origin/material claims |
| `GET /public/models` | paginated published models with facets; query `brand,category,audience,shape,material,size,sort,page` |
| `GET /public/models/:brand/:slug` | one model: attributes, variants, media, related models |
| `GET /public/facets` | facet values and counts for the filter panel |
| `GET /public/locations` | published locations with function labels |
| `GET /public/sitemap-data` | slugs + `content_updated_at` for sitemap generation |

Every response passes through the serializer. Reuse the existing `_catalogRows`/`_shapedCache`
pattern with a 60-second TTL and `invalidateCatalogCache()` hooked to admin edits and the Zoho
sync, so public traffic never adds load proportional to page views.

### 4.3 The forbidden-key test

A single test asserts that no response from any `/public/*` endpoint, and no rendered public
HTML or JSON-LD document, contains any of:

```
price, sale_price, purchase_price, basePrice, salePrice, cost, margin, wholesale,
qty, quantity, stock, stockStatus, onHand, available, warehouse, shelf,
customer, customerNumber, customer_id, user_id, email, phone, tax_id, balance,
payment_terms, pricing, hide_prices, order, order_id, invoice, credit, agent_id,
zoho_item_id, tags matching /^label:/
```

It runs against live fixtures, against every rendered route in the crawl suite, and against
every JSON-LD block. It is a **release gate**, not an advisory check. This closes `REQ-OUT-005`,
`REQ-BRD-021`, `REQ-COL-026`, `REQ-MOD-010` and `REQ-QA-023` with one mechanism.

**Note on availability.** The current guest catalogue exposes a collapsed `qty` of `0`/`1`.
Recommendation: the public site should not expose availability at all. The specification is
explicit that real-time availability belongs to the portal, and a boolean is still commercial
information a competitor can scrape across 4,000 SKUs. `available` is therefore on the forbidden
list above; a model page states that live inventory requires an account.

---

## 5. Deployment

### 5.1 Compose — one new service

```yaml
  web:
    build: ./web
    restart: unless-stopped
    environment:
      PUBLIC_API_ORIGIN: http://api:3000       # internal network only
      PUBLIC_SITE_ORIGIN: ${PUBLIC_SITE_ORIGIN} # canonical public origin — DECISION-01
      PORTAL_ORIGIN: ${PORTAL_ORIGIN}           # portal / login target — DECISION-02
      NODE_ENV: production
    depends_on: [api]
```

`PUBLIC_SITE_ORIGIN` and `PORTAL_ORIGIN` are the two values that keep the undecided domains
configurable. Nothing in the codebase may hard-code either.

### 5.2 Caddy — the one behavioural change

The public site takes the catch-all; the portal moves to a named destination. **Recommended:
a portal subdomain.**

```caddyfile
{$PUBLIC_DOMAIN} {
    import security_headers
    handle /api/*   { uri strip_prefix /api; reverse_proxy api:3000 }
    handle /s3/*    { root * /srv/uploads; file_server }
    handle          { reverse_proxy web:4321 }        # ← public site, real 404s from Astro
}

{$PORTAL_DOMAIN} {
    import security_headers
    header X-Robots-Tag "noindex, nofollow"           # portal is never indexable
    handle /api/*   { uri strip_prefix /api; reverse_proxy api:3000 }
    handle /s3/*    { root * /srv/uploads; file_server }
    redir /admin /admin/ 308
    handle_path /admin/* { root * /srv/admin; try_files {path} /index.html; file_server }
    handle          { root * /srv/storefront; try_files {path} /index.html; file_server }
}
```

**Why a subdomain rather than a `/portal/` path prefix.** The portal SPA loads its assets with
relative paths (`css/store.css`, `js/api.js`, `assets/…`) and calls the API with absolute
`/api/...` paths. A path prefix would work but puts two applications in one origin, one cookie
scope and one `try_files` fallback, where a Caddy ordering mistake silently serves the wrong app
at every URL. A separate host makes the boundary structural, lets the portal carry a blanket
`X-Robots-Tag: noindex`, and removes any possibility of the portal shell answering a public
route. The path-prefix variant remains viable and is the documented fallback if a subdomain is
rejected.

**Consequences that must be handled in the same change** (see `08_RISKS_AND_OPEN_DECISIONS.md`
R-01):

- `setPasswordLink()` in `authmw.js` builds `${PUBLIC_URL}/#/set-password/<token>` — must become
  `${PORTAL_URL}`. Password-reset and activation emails already in flight will point at the
  public site.
- `listUrl()` in `catalog.js` builds `${PUBLIC_URL}/#/list/<slug>` — same change. Shared-list
  links already circulated to customers will point at the public site.
- Both are covered by a **legacy hash bridge**: a tiny inline script on the public 404 page (and
  only there) that detects a `#/`-shaped fragment and issues a client-side redirect to
  `PORTAL_ORIGIN` with the fragment intact. Fragments are never sent to the server, so this
  cannot be done in Caddy. The bridge must be strictly allowlisted to known portal route
  prefixes so it cannot become an open redirect.
- Cookies are host-scoped today (`COOKIE_OPTS` sets no `domain`), so sessions continue to work on
  the portal host with no change. Cross-domain analytics measurement is then required
  (`REQ-ANL-013`).

### 5.3 Staging / RC

A third host, `PUBLIC_RC_DOMAIN`, running the same `web` image against the same API, protected by
Caddy `basic_auth` **and** `X-Robots-Tag: noindex, nofollow`. Robots.txt is not a security
control (`REQ-SEO-004`). The RC host is where visual, accessibility, SEO, crawl and performance
gates run before cutover.

### 5.4 `deploy.sh`

One added tar stanza to ship `platform/server/web`, and `web` included in the `docker compose up
-d --build`. The existing health poll extends to `PUBLIC_SITE_ORIGIN/healthz`. No other change.

---

## 6. Rendering strategy per route

| Strategy | Routes | Reason |
|---|---|---|
| **Prerendered** | `/why-veyora/`, `/service-model/`, `/private-label/`, `/global-presence/`, `/contact/`, `/request-b2b-account/`, all 7 policy routes, `/resources/` + articles, `/accessibility/`, `/sitemap/` | No live catalogue data. Rebuild on content publish. |
| **Server-rendered, cached 60 s** | `/`, `/brands/`, `/brands/{slug}/`, `/collections/`, `/collections/{category}/`, `/collections/{brand}/{model}/` | Catalogue data changes with the Zoho sync. |
| **Server-rendered, uncached** | `/search/`, 404, 500, sitemap XML, `robots.txt` | Per-request or generated. |

The homepage is server-rendered because it carries brand cards derived from published brand
records. If brand publication proves stable, it can move to prerender with a publish hook —
a later optimisation, not a launch requirement.

---

## 7. Data-model additions

Minimal and additive. **No existing column is altered, renamed or dropped**, so the portal, the
admin panel and all 27 existing tests are unaffected. Delivered as `0007_public_site.sql`
onwards.

### 7.1 New tables (9)

| Table | Purpose | Key columns |
|---|---|---|
| `brands` | Brand entity — `REQ-CM-002`…`REQ-CM-009` | `slug` unique, `name`, `short_name`, `segment`, `headline`, `summary`, `story`, `ideal_retailer`, `best_for jsonb`, `style_traits text[]`, `price_tier_label`, `design_origin`, `manufacturing_origin`, `component_origins`, `approved_materials text[]`, `logo_media_id`, `hero_media_id`, `seo jsonb`, + governance |
| `locations` | `REQ-CM-019` | `slug`, `name`, `function` enum (`warehouse`\|`supply_base`\|`service_hub`\|`office`\|`support`), `is_public`, `address jsonb`, `regions_served text[]`, `contact jsonb`, `hours`, `coordinates`, + governance |
| `policies` | `REQ-CM-020` | `type` unique, `summary`, `terms`, `effective_date`, `eligible_markets text[]`, `exclusions`, `revisions jsonb`, + governance |
| `media` | `REQ-CM-007`, `REQ-CM-014` | `path`, `alt`, `width`, `height`, `kind`, `rights_holder`, `rights_expiry`, `owner_type`, `owner_id`, `variant_sku` |
| `redirects` | `REQ-CSF-004`, `REQ-CM-027` | `from_path` unique, `to_path`, `status` (301\|302\|410), `reason`, `source`, `created_at` |
| `content_pages` | `REQ-CM-022` | `route` unique, `template`, `modules jsonb`, `seo jsonb`, `index_state`, + governance |
| `forms` | `REQ-CM-023` | `type` unique, `fields jsonb`, `consent_version`, `crm_routing jsonb`, `confirmation jsonb`, `notify_to text[]`, `retention_days` |
| `form_submissions` | `REQ-FRM-009`, `REQ-FRM-010` | `form_type`, `payload jsonb`, `source_url`, `utm jsonb`, `region`, `business_type`, `consent_version`, `consent_at`, `delivery_state` (`pending`\|`sent`\|`failed`), `attempts`, `last_error`, `created_at` |
| `content_approvals` | `REQ-CM-024`…`REQ-CM-026` | `entity_type`, `entity_id`, `field`, `approver_id`, `approved_at`, `source_reference`, `note` |

**Governance columns**, applied identically to `brands`, `locations`, `policies`,
`content_pages` and to the new columns on `products`:

```sql
publication_state  text not null default 'draft'
                   check (publication_state in ('draft','verified','approved','published','retired')),
source_reference   text not null default '',
fact_owner         text references users(id) on delete set null,
verification_status text not null default 'unverified'
                   check (verification_status in ('unverified','sourced','verified')),
last_reviewed_at   timestamptz,
scheduled_review_at timestamptz,
content_updated_at timestamptz not null default now()   -- drives sitemap lastmod, REQ-CM-028
```

`content_updated_at` is deliberately separate from the existing `updated_at` trigger so a Zoho
stock sync does not churn `lastmod` on every product page every 30 minutes.

### 7.2 Additive columns on `products` (11)

`public_slug` (unique, generated from brand + SKU), `brand_id` (FK → `brands`, nullable during
migration so the existing free-text `brand` keeps working), `line`, `shape`, `segment`,
`public_description`, `is_published`, `is_featured`, `is_discontinued`, `replacement_product_id`,
plus the governance block. `is_active` keeps its current meaning as an *ordering* flag;
`is_published` is the new, independent *public visibility* flag — a product can be orderable in
the portal and unpublished on the public site, and vice versa.

### 7.3 Additive columns on `variations` (3)

`color_code` (structured, distinct from the existing free-text `color`), `swatch_media_id`,
`is_published`.

### 7.4 Backfill required before launch

| Field | Coverage today | Action |
|---|---|---|
| `public_slug` | 0% | Generate from brand + SKU; assert uniqueness and URL safety across all 1,318 products |
| `brand_id` | 0% | Map the 8 (or 9/10) approved brands; unmapped products stay unpublished |
| `shape` | 0% | **Manual or assisted classification — the single largest content task.** Filtering by shape is a P0 requirement with no data behind it. |
| `public_description` | 0% | Imported `description` is old-site marketing copy; needs review before it becomes public canonical content |
| `is_published` | n/a | Explicit editorial decision per model; default `false` |
| Media alt text | 0% | Required for every published image |
| `color_code` | 0% | Derive from variation SKU suffix where the pattern is reliable; review the rest |

`REQ-COL-003` (shape facet) cannot be met without the shape backfill. Estimate 40–70 hours
depending on how much can be inferred from names, categories and imagery, and it is on the
critical path for `/collections/`.

### 7.5 Slug-change protection

A trigger on `brands.slug` and `products.public_slug`: when a **published** record's slug
changes, insert a `301` row into `redirects` from the old path. This satisfies `REQ-CM-027`
mechanically rather than by process discipline.

---

## 8. Public / portal boundary

### 8.1 Function split

| Function | Public site | Portal |
|---|---|---|
| Company, brand, model, category discovery | ✅ | (also browsable when signed in) |
| Public catalogue filtering and pagination | ✅ | ✅ (with prices) |
| Policies, resources, ordering guide | ✅ | link out |
| Contact Sales, Request B2B Account, Private Label enquiry | ✅ | — |
| B2B Login handoff | ✅ (link only) | ✅ |
| Customer pricing, live inventory depth | ❌ | ✅ |
| Cart, checkout, orders, backorders, returns | ❌ | ✅ |
| Replenishment, favourites, spare parts, restock alerts | ❌ | ✅ |
| Account, addresses, invoices, documents | ❌ | ✅ |
| Agent-assisted ordering, customer lists, frame lists | ❌ | ✅ |
| Shared curated frame lists (`#/list/<slug>`) | ❌ — stays on the portal host | ✅ |

### 8.2 Login handoff

The public header's B2B Login control is an anchor to `PORTAL_ORIGIN`, with an optional
`?next=` parameter. It emits `b2b_login_click` (`REQ-ANL-009`) and never uses the primary button
style (`REQ-OUT-011`). No public route named `/login` is created, so nothing login-shaped can be
indexed (`REQ-IA-003`).

### 8.3 Data permitted in public output

**Permitted:** brand identity, positioning and verified story; separated design/manufacturing/
component origin where approved; approved material claims; model name, display SKU, public slug;
category, audience, shape, size, dimensions, lens type; colour names and codes; product and
campaign imagery with alt text; approved public price-tier *labels* (never numbers); published
policy text; location name and function; published resource content; governance dates and
reviewer names where approved.

**Never permitted, in HTML, JSON, JSON-LD, meta tags, data attributes, source maps or analytics:**
any price or price range, purchase/supplier cost, discount, promotion, margin; stock quantity,
availability boolean, warehouse or shelf; any customer, user, order, invoice, payment, credit or
lead field; `zoho_item_id`; internal `label:*` tags; agent assignments; the full supplier brand
roster beyond the approved public list.

---

## 9. Testing architecture

Extends the existing `node:test` culture rather than replacing it. The existing 27 tests are
untouched.

| Layer | Tool | Location | Gate |
|---|---|---|---|
| Public serializer / forbidden keys | `node:test` | `api/test/public-*.test.js` | **blocking** |
| Content-model publication gates | `node:test` | `api/test/publication-gate.test.js` | **blocking** |
| Route contract — status, title, description, canonical, H1, robots | Playwright request API | `web/test/routes.spec.ts` | **blocking** |
| Structured data — validity + DOM equality | `node:test` + schema validator | `web/test/schema.spec.ts` | **blocking** |
| Crawl — links, redirects, orphans, JS-disabled reachability | Playwright crawler | `web/test/crawl.spec.ts` | **blocking** |
| Accessibility | `@axe-core/playwright` per route per breakpoint | `web/test/a11y.spec.ts` | **blocking** |
| Visual regression | Playwright screenshots, 6 breakpoints | `web/test/visual.spec.ts` | **blocking** |
| Performance budgets | Lighthouse CI | `web/test/perf/` | **blocking** |
| Placeholder validation | Node script | `web/scripts/check-placeholders.mjs` | **blocking on production build** |
| Forms end-to-end incl. CRM outage | Playwright + fault injection | `web/test/forms.spec.ts` | **blocking** |

Playwright is a **new development dependency confined to `platform/server/web`**. It is not
installed by this audit and must be an explicit, approved step in Batch B1. It does not enter the
API container or the production image.

---

## 10. Configuration

Every undecided value is an environment variable with no hard-coded fallback to a real domain.

| Variable | Purpose | Decision |
|---|---|---|
| `PUBLIC_SITE_ORIGIN` | Canonical public origin; source of every canonical, sitemap and OG URL | DECISION-01 |
| `PORTAL_ORIGIN` | Portal / login destination | DECISION-02 |
| `PUBLIC_RC_DOMAIN` | Protected RC host | — |
| `PUBLIC_API_ORIGIN` | Internal API base (`http://api:3000`) | — |
| `CRM_ADAPTER` | `none` \| `webhook` \| named provider | DECISION-17 |
| `CRM_WEBHOOK_URL` | Target when adapter is `webhook` | DECISION-17 |
| `ANALYTICS_PROVIDER` / `ANALYTICS_ID` | GA4 or approved alternative | DECISION-20 |
| `INDEXNOW_KEY` | IndexNow submissions | — |
| `ALLOW_GPTBOT` | robots.txt policy, independent of OAI-SearchBot | DECISION-19 |
| `PLACEHOLDER_MODE` | `allow` on RC, `block` on production — drives the release gate | — |

A startup assertion refuses to boot the `web` container in production when
`PUBLIC_SITE_ORIGIN` or `PORTAL_ORIGIN` is unset, mirroring the API's existing fail-closed
`startServer()` pattern.

---

## 11. Programme correction — legacy hash bridge location (2026-08-05, B1.3)

Sections 1–10 are retained as written. This section corrects §5.4's original placement of the
legacy-hash bridge and takes precedence where the two disagree. Nothing here revises the
recommendation itself (§1) — see §11.4.

### 11.1 Why a 404-only bridge cannot catch root hash URLs

§5.4 originally proposed the bridge as "a tiny inline script on the public 404 page (and only
there)". That is insufficient, and the reason is structural, not a matter of degree: a URL such as
`{ORIGIN}/#/login` sends only `/` to the server. Everything after `#` is a URL fragment, and a
fragment is **never transmitted in an HTTP request** — the browser keeps it client-side. The
server sees a plain request for `/`, which is a real, existing, 200-status route. It never reaches
404, so a bridge that only lives on the 404 page never runs for the single most common shape of
legacy link: a bookmark or old inbound link to the bare origin with a root-level fragment.

### 11.2 The correction

The bridge now runs from the shared `Base.astro` layout (`platform/server/web/src/layouts/
Base.astro`), which every page — including `/` — renders through. This is not a new mechanism, it
is the same script relocated to the one place guaranteed to load regardless of which path a
fragment happens to be attached to. Implementation: `platform/server/web/src/lib/
legacy-hash-bridge.ts` (the pure, unit-tested decision function) plus a bundled `<script>` in
`Base.astro` that reads `location.hash` and a server-rendered `<meta name="portal-origin">` tag.

### 11.3 It remains allowlisted

The security model is unchanged in substance, only in location: a fixed list of known portal route
prefixes (`products`, `login`, `set-password`, `list`, `cart`, `orders`, `dashboard`, `account`,
`backorders`, `returns`, `favourites`, `replenishment`, `spare-parts`, `customers`, `lists`,
`home`), matched with strict, case-sensitive, non-decoded equality against the first path segment
after `#/`. No decoding and no case-folding is deliberate: either transform would itself be a new
surface for a bypass, so the implementation trades leniency for safety. Unknown prefixes,
protocol-relative fragments (`#//evil.example`), and absolute-URL injection (`#/http://evil.
example`) all fail the allowlist check by construction and receive no redirect. Covered by
`platform/server/web/test/legacy-hash-bridge.test.ts`.

### 11.4 Caddy still cannot process fragments; the portal-subdomain recommendation is unaffected

This correction is about *where the bridge runs*, not a re-litigation of §5.1–§5.2. Fragments are
invisible to any server — Caddy, the `web` container, or the API — so no amount of Caddy
configuration could ever substitute for a client-side script; that constraint is exactly why the
bridge exists in the first place and is unchanged by this correction. The recommendation to use a
separate portal host (§5.2, "Why a subdomain rather than a `/portal/` path prefix") stands as
written: this correction concerns the public `web` application's own layout, not the Caddy
host/handler design.

---

## 12. B2.1 implementation result — 2026-08-05

**Scope executed:** the additive database schema and publication-governance foundation described
in §7, delivered exactly where §7 said it would be — `0007_public_site.sql` — plus its mirror in
`api/src/migrate.js`. Starting commit `f55539d` (completed B1) on `mathew/public-website-rebuild`.
No `/public/*` API route, serializer, catalogue endpoint, live data backfill, admin UI, or Astro
integration was built — all explicitly out of scope for B2.1 and deferred to B2.2 onward. The other
developer's concurrent storefront branch was not inspected, merged or touched.

### 12.1 The migration lifecycle question (§2's "determine whether files under db/migrations are
init-only, incremental, or supplemented by ensureSchema") is answered definitively

Inspection of `0005_order_zoho_push.sql`, `0006_backorder_context.sql`, and every comment inside
`api/src/migrate.js` confirms: `db/migrations/*.sql` runs exactly once, via PostgreSQL's
`docker-entrypoint-initdb.d` mechanism, against a completely fresh data volume. An already-deployed
database never re-runs anything in that directory. The actual incremental mechanism is
`ensureSchema()` in `api/src/migrate.js`, called from `startServer()` on every API boot
(fail-closed), containing hand-written idempotent SQL. There is no ORM and no migration-runner tool
anywhere in the repository. `0007_public_site.sql` and its mirror in `migrate.js` follow this
existing convention exactly — no new mechanism was introduced.

### 12.2 What was implemented

Nine new tables (`brands`, `locations`, `policies`, `media`, `redirects`, `content_pages`, `forms`,
`form_submissions`, `content_approvals`), the governance lifecycle from §7.1 applied identically
across `brands`/`locations`/`policies`/`content_pages` and as additive columns on `products`, the
11 additive `products` columns and 3 additive `variations` columns from §7.2/§7.3 exactly as
specified, and the slug-change redirect trigger from §7.5 for both `brands` and `products`. One
addition beyond §7's text: a database CHECK (`products_published_requires_state`) making
`is_published = true` structurally require `publication_state = 'published'` — not previously
specified, added because it closes the "no current product becomes publicly published" requirement
at the database level rather than by relying on the migration simply not containing a row-updating
statement. Full field-by-field detail:
`docs/public-website-rebuild/14_B2_SCHEMA_REFERENCE.md`.

### 12.3 Confirmed untouched

No migration was applied to any database (no PostgreSQL executable was available or installed —
see `14_B2_SCHEMA_REFERENCE.md` §9). No production, VPS, or live database was contacted.
`platform/server/storefront/**`, `platform/server/web/**`, the root admin application,
`docker-compose.yml`, `Caddyfile`, `deploy.sh`, all `.env` files, and every existing API test file
are unchanged.

---

## 13. B2.2 implementation result — 2026-08-05

**Scope executed:** the unauthenticated, read-only public API boundary described in §4 ("The public
data surface") — the new `/public` router, the pure allowlist serializer, and the forbidden-key
authority. Starting commit `343421e` (completed B2.1). No public-site page integration, database
backfill, publication of any record, admin editing surface, form/CRM work, write endpoint, or
authentication change — all explicitly out of scope and deferred to B2.3+.

### 13.1 §4.1's principle is now implemented, not merely stated

§4.1 said the enforcement must move "to one allowlist serializer with a test that cannot be
satisfied by a leak," because scattered conditionals give a future contributor no warning.
`platform/server/api/src/public-serialize.js` is that serializer: eight functions
(`serializeMedia`, `serializeVariation`, `serializeModelCard`, `serializeModelDetail`,
`serializeBrandSummary`, `serializeBrandDetail`, `serializeLocation`, `serializeSitemapRecord`),
each constructing a **fresh object literal** from named fields. It never spreads a database row,
never returns a row unchanged, and never attaches a jsonb blob wholesale — `best_for` and
`component_origins` are validated into string arrays, and only a validated `lensType` is extracted
from the existing `products.attributes` bag.

### 13.2 §4.3's forbidden-key test exists

`platform/server/api/src/public-forbidden-keys.js` is the single forbidden-key authority: a
normalised (lowercase, separators stripped), **exact-match** key set plus a recursive scanner that
reports the exact object path of any violation, and a `label:*` value check. Exact-match rather
than substring is deliberate — a naive `.includes()` rule would reject harmless public fields like
`isDiscontinued` or `sortOrder`, which is precisely the false-positive trap the B2.2 brief warned
about. Every serializer output and every endpoint response fixture is run through it in tests.

### 13.3 Endpoints delivered, against §4.2's table

All seven endpoints §4.2 specified are implemented as GET-only routes:
`/public/brands`, `/public/brands/:slug`, `/public/models`, `/public/models/:brand/:slug`,
`/public/facets`, `/public/locations`, `/public/sitemap-data`. Mounted at `/public` in `index.js`
after `/admin` and before the terminal 404 handler, with no authentication middleware (verified:
the router has zero non-route middleware layers) and no write handler of any kind (verified: every
registered method is `get`).

**One deliberate divergence from §4.2, and its reason.** §4.2 listed `GET /public/models` as
returning "paginated published models with facets" and the `sitemap-data` endpoint as returning
"slugs + `content_updated_at`" — both implemented. But `/public/models` deliberately returns
`hasMore` and **no total count**, per the B2.2 brief's instruction to avoid "a commercially useful
full-count disclosure." This matches the existing guest-catalogue behaviour in `routes/catalog.js`
(which already withholds `total` from guests) rather than contradicting it.

**Availability is exposed nowhere**, honouring §4.3's "Note on availability" ruling: the public
site does not expose availability at all, not even the collapsed 0/1 boolean the authenticated
guest catalogue uses.

### 13.4 Publication boundary

Every query filters explicitly on published state — `publication_state = 'published'` for brands,
locations and content pages; `products.is_published = true` and `variations.is_published = true`
for catalogue records; `locations.is_public = true` in addition to publication state. `is_active`
(the portal's ordering flag) is referenced **nowhere** in the public boundary — confirmed by an
automated test, because conflating the two would be exactly the "is_active as the publication
authority" mistake §7.2 of the B2.1 schema work warned against.

Every query lists its columns explicitly (no `select *`, no `p.*`) and is fully parameterised. The
one SQL string interpolation is `${MODEL_SORTS[sort]}`, where `sort` has already passed an
allowlist check against a fixed two-key object — verified at runtime to reject `__proto__`,
`constructor`, `toString`, `hasOwnProperty` and injection payloads with a 400 before any query runs.

### 13.5 Confirmed untouched

No live database was contacted — every test uses an injected fake `db` or a monkey-patched
`pool.query` restored after each test. No production system, VPS or DNS was accessed. The only
change to a pre-existing tracked file is `index.js`: one import line and one `app.use('/public', …)`
mount, purely additive. `platform/server/storefront/**`, `platform/server/web/**`,
`platform/server/db/**`, the root admin application, `docker-compose.yml`, `Caddyfile`,
`deploy.sh`, all `.env` files, and every existing API test are unchanged. Full endpoint contract:
`docs/public-website-rebuild/15_B2_PUBLIC_API_CONTRACT.md`.

---

## 14. B2.3 implementation result — 2026-08-06

**Scope executed:** the Astro public website now consumes the read-only `/public/*` API described
in §4, server-side. Starting commit `4fa3f7c` (completed B2.2). No backfill, no publication, no
admin editing, no forms/CRM, no JSON-LD, no XML sitemap, no asset ingestion, no deployment — all
explicitly out of scope and deferred.

### 14.1 §5.1's `PUBLIC_API_ORIGIN` is now real

§5.1's compose sketch listed `PUBLIC_API_ORIGIN: http://api:3000` for the `web` service. That
variable now exists in the application: validated by the same `normalizeOrigin()` as the other two
origins, fail-closed in production through the existing `scripts/validate-env.mjs` gate, and
documented in `.env.example` and the web README. It is server-side only — read from `process.env`
in a server-only module, never through `import.meta.env` (the only mechanism that would inline a
value into a client bundle), and never rendered into a page.

Adding a third required production origin legitimately changed the startup contract, so the B1.1A
command-path tests and B1.3 route-contract tests were updated to supply it. That is a contract
change, not a regression.

### 14.2 The client honours §4's boundary in the direction this batch controls

§4.1 required the enforcement to be structural rather than conventional. On the consuming side
that means: one allowlisted function per endpoint with **no generic fetch-any-path escape hatch**;
no function anywhere accepting an origin, host or absolute path (so an SSRF through a route
parameter is impossible by construction); slugs `encodeURIComponent`-ed into fixed path templates;
`credentials: 'omit'` explicit so no visitor identity is ever forwarded to an API that has no use
for one; and a 5-second `AbortController` timeout.

Runtime validation rebuilds every response into fresh objects from named fields — never spreading
the parsed payload — so an unexpected field cannot survive even if the API sent one. This is
deliberately redundant with the API's own serializer: the boundary is a network hop, and "the
server we called is the version we think it is" is an assumption.

### 14.3 One architectural finding, recorded because it shaped the design

**Setting `Astro.response.status` from inside a nested component has no effect on the response.**
An earlier draft had the shared catalogue listing component set its own status; `/brands/` (which
sets it in page frontmatter) correctly returned 503 during an outage while `/collections/`
returned 200. The shared logic is therefore a plain function (`src/lib/catalogue-page.ts`) called
from page frontmatter, not a component — which satisfies both "category routes must not duplicate
fetching logic" and "an outage must not return 200."

### 14.4 The failure-mode distinction §4 implies is now enforced end to end

Four upstream outcomes map to four different rendered statuses: API 400 → 400, API 404 → 404,
timeout/connection failure/5xx → 503, malformed 200 payload → 502. Verified over real HTTP against
a mock API that an outage renders as "temporarily unavailable" with a 5xx — **never** as an empty
catalogue, and **never** as a false 404 on a detail route that would tell a crawler to drop a real
published record.

### 14.5 Confirmed untouched

No live database, real API, VPS, production system or DNS was contacted — every test runs against a
controlled mock on `127.0.0.1`. `platform/server/api/**`, `platform/server/db/**`,
`platform/server/storefront/**`, the root admin application, `docker-compose.yml`, `Caddyfile`,
`deploy.sh` and every `.env` file are unchanged. Full integration detail:
`docs/public-website-rebuild/17_B2_WEB_API_INTEGRATION.md`.

---

## 15. B2.4A implementation result — 2026-08-06

**Scope executed:** the authenticated administrative API and publication gate for public brand,
product and variation content. Starting commit `71e1ea0` (completed B2.3). No admin UI, no
backfill, no publication of any real record, no media upload, no schema change, no Astro or
storefront change, no deployment.

### 15.1 §7's governance model now has an enforcement layer

§7.1 defined the governance block and §7.5 the slug-change trigger, and B2.1 delivered both plus a
database CHECK tying `products.is_published` to `publication_state`. What a CHECK cannot see is
another row — so "is the linked brand published", "does the replacement reference resolve", "is any
variation publishable" were recorded in `14_B2_SCHEMA_REFERENCE.md` §6 as deferred application-level
rules. `src/publication-gate.js` closes that gap: pure functions, no SQL, evaluated **inside the
publish transaction against the freshly locked row**, so changing `publication_state` alone cannot
bypass them.

### 15.2 The public/private boundary is preserved in the write direction

§4 established the read boundary. This batch adds writes, and keeps them on the other side of it:
the router is mounted at `/admin/public-content` — never under `/public` — behind the repository's
existing `requireAuth`. It imports no pricing, ordering, inventory, cart or Zoho module, and queries
no customer, order, invoice, payment or stock table. Administrative responses use their own explicit
serializers, separate from the public ones, so governance fields available to an editor cannot leak
onto the public surface.

### 15.3 An architectural gap recorded, not papered over

§10's configuration table and this document's earlier sections assume an administrator role is
sufficient authority. Management's stated requirement is **specific permissions for specific
accounts**, and that is **not supported**: the repository has role-based access control only
(`users.role`, a single enum), with no permissions table, per-account column, scope list or ACL
anywhere. B2.4A added a single named permission seam (`requirePublicContentAdmin()`) applied once to
the whole router, so a future capability check has exactly one place to attach — but it did not
implement per-account grants, which require an additive schema change this batch was explicitly
forbidden from making. Full detail: `18_B2_ADMIN_PUBLICATION_API.md` §1.1.

### 15.4 Confirmed untouched

No live database, production system, VPS or DNS was contacted — every test runs against a
controlled fake database. No record was published. `platform/server/web/**`,
`platform/server/storefront/**`, `platform/server/db/**`, the root admin frontend,
`docker-compose.yml`, `Caddyfile`, `deploy.sh` and every `.env` file are unchanged, as are all
existing `/public` response shapes and all pricing, inventory, ordering and Zoho behaviour. Full
contract: `docs/public-website-rebuild/18_B2_ADMIN_PUBLICATION_API.md`.

---

## 16. B2.4P implementation result — account-specific capability permissions — 2026-08-06

Authorisation on the public-content administrative API moved from a role check to **per-account
capability grants**, implementing management's requirement, *"specific permissions for specific
accounts."* This is the architectural change B2.4A's single-point seam was built to accommodate.

### 16.1 The model

Four capability keys, and only four: `public_content.view`, `public_content.edit`,
`public_content.publish`, `permissions.manage`. They are held by **individual accounts**, not by
roles. There are no wildcards, no prefix or hierarchical matching, no client-defined names, and no
role name doubling as a key. Closure is enforced independently at four layers — a database `CHECK`,
the frozen registry, API validation, and a registry filter applied to the resolver's own output — so
a bypass at any single layer still fails.

```
users ──< account_permissions (user_id, permission_key) unique
                is_active · granted_by/at · revoked_by/at
                          │
                          ▼
        permissions.js — resolution (uncached, never reads users.role)
                          │
          ┌───────────────┴────────────────┐
          ▼                                ▼
  requirePermission(key)          /admin/account-permissions
  on every public-content route    (gated on permissions.manage)
```

### 16.2 Layers

- **Schema** — additive `account_permissions` (migration `0008`, mirrored in `ensureSchema()`). One
  row per (account, capability) for the lifetime of the pairing: revocation flips `is_active` and
  stamps the revoker rather than deleting, so grant history survives in place. `is_active` defaults
  to `false`, and the migration contains **no `INSERT`** — nothing is granted automatically.
- **Registry** (`permission-registry.js`) — a frozen constant, no database access, exact-match
  lookup with no normalisation or case-folding.
- **Resolution** (`permissions.js`) — requires an active account, an active grant, and a registered
  key. Never consults `users.role`; there is no admin fallback and no superuser. Deliberately
  uncached, so a revocation takes effect on the next request rather than at session expiry.
- **Enforcement** — the router-level gate is now `requireAuth()` with **no role arguments** (proving
  identity only); each route carries its own capability middleware. Edit and publish are separate
  and non-hierarchical.
- **Management** (`/admin/account-permissions`) — gated on `permissions.manage`, so no account can
  self-grant. Transactional replacement with `SELECT … FOR UPDATE`, an account-bound concurrency
  token, and a last-manager guard counted **inside** the transaction after the lock.

### 16.3 Deliberate boundaries

The unauthenticated read-only `/public/*` API is untouched — public visitors are not accounts and
hold no capabilities. Existing role-protected admin routes keep `requireAuth('admin', 'warehouse')`
unchanged: B2.4P introduced capabilities where the requirement demanded them and did not rewrite the
platform's authorisation model wholesale, which is a separate and larger decision.

### 16.4 Confirmed untouched

No live database, production system, VPS or DNS was contacted — every test runs against controlled
database doubles. **No permission was assigned to any account**, and the production bootstrap was
not performed. No record was published. `platform/server/web/**`, `platform/server/storefront/**`,
the root admin frontend, `docker-compose.yml`, `Caddyfile`, `deploy.sh` and every `.env` file are
unchanged, as are all existing `/public` response shapes and all pricing, inventory, ordering and
Zoho behaviour. Full contract: `docs/public-website-rebuild/19_ACCOUNT_PERMISSION_SYSTEM.md`.

---

## 17. B2.4B1 implementation result — account-permission management interface — 2026-08-06

The operator-facing half of B2.4P. Capability grants can now be viewed and changed from the admin
panel instead of only through direct API calls.

### 17.1 Where it lives

The admin panel is the **vanilla-JS SPA at the repository root** — `index.html`, `css/`, `js/`,
`assets/` — with no framework, no module system and no build step; `deploy.sh` tars exactly those
four paths to `/srv/admin`. The screen is one new page script (`js/pages_permissions.js`) plus three
narrowly scoped client methods and a nav filter. Storefront and Astro public site are untouched.

```
NAV entry (requires:'permissions.manage')  ──filtered by──▶  App.can()
                                                                 │
        App.loadCaps() ── GET /registry ── 200 → held / 403 → not ┘
                                                                 │
#/account-permissions/<userId>                                   ▼
   left:  DB.d.users            (the EXISTING account list — no second directory)
   right: DB.accountPermissions(userId)  →  four checkboxes + history
                  │  explicit Save only
                  ▼
          DB.saveAccountPermissions(userId, completeSet, token)
```

### 17.2 The access model, and why it is a probe

The session object is `{id, name, role}` and carries no capabilities, so the browser cannot know
whether an account holds `permissions.manage` without asking. Deriving it from the `admin` role was
rejected: that is the role bypass account-specific permissions exist to remove. The panel instead
calls the capability registry endpoint — which is itself gated on `permissions.manage` — and reads
`200` as held, `403` as not held, and **anything else, including a network failure, as not held**.

This is a display hint, not a control. The cache can go stale, and that is safe: a stale `true`
shows a menu entry whose every request the server still refuses. Authorisation remains entirely
server-side.

### 17.3 Interface invariants

- **A toggle mutates nothing.** The draft is local until an explicit Save; there is no autosave.
- **Save sends the complete intended active set** plus the concurrency token from the matching read;
  local state is replaced only from a successful response, and the returned token replaces the old.
- **A token is never reused across accounts.**
- **The frontend cannot supply an actor** — no `granted_by`, `revoked_by` or user id in the body.
- **No free-text or wildcard permission input exists**; checkboxes over the server's registry are
  the only input, and duplicates are structurally impossible.
- **No mutation is retried automatically.**
- **Errors are translated, never rendered raw** — no API strings, stacks, SQL, hosts or ports.

### 17.4 Confirmed untouched

No live database, production system, VPS or DNS was contacted. **No permission was assigned to any
account and no bootstrap SQL was executed.** No API endpoint was added or modified, no schema was
touched, and `platform/server/api/**`, `platform/server/db/**`, `platform/server/web/**`,
`platform/server/storefront/**`, `docker-compose.yml`, `Caddyfile`, `deploy.sh` and every `.env`
file are unchanged. Full contract:
`docs/public-website-rebuild/20_ACCOUNT_PERMISSION_INTERFACE.md`.

---

## 18. B2.4B2A implementation result — public-content review and draft editing — 2026-08-06

The editorial surface over B2.4A's administrative API, gated by B2.4P's per-account capabilities.
Review and draft editing only — publication remains B2.4B2B.

### 18.1 A capability bypass found and closed

Building the editor over the PATCH allowlist surfaced a real hole in B2.4A. **Brands have no
`is_published` column** — `publication_state = 'published'` *is* the publication flag, and
`routes/public.js` selects brands on exactly that predicate. But `publication_state` was
PATCH-editable, and PATCH requires only `public_content.edit` and never runs the gate.

An account with **edit alone could publish a brand to the live public site**, bypassing the
`public_content.publish` capability, the publication gate and the `content_approvals` record.

`assertPublicationBoundaryNotCrossed()` now runs inside `patchAdminEntity`'s transaction against the
locked row and refuses to cross the published boundary in either direction; ordinary editorial
transitions stay editable. Products were never affected — their flag is the separate, immutable
`is_published` column.

The architectural lesson is worth keeping: **a capability split is only as strong as the fields each
capability can reach.** A field that is both editable and load-bearing for publication silently
merges two capabilities into one.

### 18.2 Capability discovery

```
session {id,name,role}  ──has no capabilities──▶  GET /admin/public-content/capabilities
                                                   (authenticated, UNGATED)
                                                          │
                                          { view, edit, publish } — three booleans
                                                          │
App.loadCaps() ─┬─ registry probe (200/403) ─────▶ permissions.manage
                └─ capabilities endpoint ────────▶ public_content.{view,edit,publish}
```

B2.4B1's 200/403 probe could not scale here: a `200` on a read proves only `view`, and separating a
viewer from an editor would mean attempting a write. The new endpoint is the one route on the router
without a capability gate — deliberately, so an account holding none still gets an honest all-false
answer instead of a failure. It returns three booleans about the caller and nothing else.

`loadCaps()` now clears its cache before probing, so a failed re-probe cannot leave a previous
session's capabilities in place, and every failure path — `401`, `403`, network, malformed body —
resolves to no capability.

### 18.3 Interface invariants

- **View and edit are separate.** `view` renders every control disabled and visibly greyed; `edit`
  makes them editable. Neither implies the other; neither implies publish.
- **No publish control exists anywhere**, at any capability level. The publication-state select
  offers only `draft`, `verified`, `approved`, `retired`.
- **Only changed fields are sent**, filtered through a frozen mirror of the API's own allowlist, so
  `is_published`, `fact_owner`, `approver_id`, `sku` and `price` are structurally unsendable.
- **Every response is allowlist-shaped**, never spread — a response can never be fed back as a
  request, and no price, cost, stock or availability data can reach the screen.
- **A failed load is an error with a retry, never an empty list.**
- **A variation is saved with its own token**, never the product's.

### 18.4 Confirmed untouched

No live database, production system, VPS or DNS was contacted. **No permission was granted to any
account, no bootstrap SQL was executed, and no record was published or unpublished.** No schema
change. `platform/server/db/**`, `platform/server/web/**`, `platform/server/storefront/**`,
`api/src/migrate.js`, `api/src/routes/public.js`, `docker-compose.yml`, `Caddyfile`, `deploy.sh` and
every `.env` file are unchanged, as are all public API response shapes and all pricing, inventory,
ordering and Zoho behaviour. Full contract:
`docs/public-website-rebuild/21_PUBLIC_CONTENT_EDITOR.md`.

---

## 19. B2.4B2B implementation result — publication evaluation, publish and unpublish — 2026-08-06

The governed publication workflow, completing the public-content administration surface. Every
endpoint already existed in B2.4A; this batch adds no route and changes no response shape.

### 19.1 A deadlock found and fixed

B2.4B2A closed the PATCH publication bypass. That was correct — and it made a latent gate defect
fatal.

**The gate required a record to be already published in order to be publishable.**
`governanceReasons()` demanded `publication_state === 'published'`. For brands, whose
`publication_state` *is* the live flag (no `is_published` column), the only route to that state was
the publish endpoint whose own gate demanded it first: **no brand could ever be published.** For all
three entity types it also made unpublication one-way, because `unpublishEntity` returns a record to
`approved` — which the same rule refused to re-publish.

That `approved` is exactly what unpublish leaves behind is the evidence for the intended rule: the
record must have been **signed off**, not already live. `approved` and `published` now both pass.

```
draft → verified → approved ──publish endpoint──▶ published
                      ▲                              │
                      └────── unpublish endpoint ────┘
```

The two defects together are the architectural lesson of this sequence: **a capability split is only
as strong as the state machine underneath it.** The first merged `edit` and `publish` into one; the
second made the governed path impossible — which is precisely what pushes an operator back toward a
bypass.

### 19.2 Capability mapping

| Action | Capability | Note |
|---|---|---|
| Readiness check (`evaluate`) | `public_content.view` | A read. Computes a verdict, writes nothing — a reviewer can see why a record is blocked without being able to act. |
| Publish / Unpublish | `public_content.publish` | Does **not** require `edit`, and is not implied by it. |

A publish-only account gets the decisions with every form control disabled; an edit-only account gets
the form with no publication control. Both enforced by the API independently of the UI.

### 19.3 Workflow invariants

- **Evaluation is explicit** — opening a record never evaluates and never mutates. The detail
  response happens to embed a verdict; the interface ignores it, so what is shown is always a verdict
  the operator asked for.
- **Server reason order is preserved exactly**; nothing is re-sorted, regrouped or reworded, and an
  unrecognised code still renders with the server's message. Advisories stay separate from blockers.
- **A decision requires a fresh verdict**, an explicit confirmation naming the record, and the
  current concurrency token. The confirm button disables on first click; nothing is retried
  automatically.
- **Unsaved edits block evaluation and both decisions**, and are never silently discarded — a
  decision acts on the stored record, so acting while the screen shows different copy is refused.
- **Any verdict is discarded** the moment the record changes: a save, a reload, or a decision.
- **The browser can neither set the flag nor supply the approver.** The decision body carries only a
  token and an optional note; the server takes the approver from the session and writes
  `content_approvals` itself.
- **Unpublish is never presented as deletion** — content, approvals and URLs are preserved, and the
  record can be published again.

### 19.4 Confirmed untouched

No live database, production system, VPS or DNS was contacted. **No record was published or
unpublished, no permission was granted to any account, and no bootstrap SQL was executed.** No schema
change, no new route, no changed response shape. `platform/server/db/**`, `platform/server/web/**`,
`platform/server/storefront/**`, `api/src/index.js`, `api/src/migrate.js`,
`api/src/routes/public.js`, `docker-compose.yml`, `Caddyfile`, `deploy.sh` and every `.env` file are
unchanged, as are all public API response shapes and all pricing, inventory, ordering and Zoho
behaviour. Full contract:
`docs/public-website-rebuild/22_PUBLICATION_WORKFLOW_INTERFACE.md`.

---

## 20. B2.4C1 implementation result — catalogue readiness audit and dry-run planner — 2026-08-06

A read-only planning tool, added because the governed editing and publication machinery
(B2.4A–B2.4B2B) says nothing about how much of the existing ~1,300-model catalogue is anywhere near
ready, or what a backfill would actually involve.

### 20.1 Position in the architecture

```
catalogue export (JSON fixture)
        │  closed allowlist — unknown/forbidden fields REJECTED
        ▼
src/catalogue-audit/   ── pure, deterministic, no pg, no env, no network ──▶ JSON + CSV reports
        │                                                                        │
        │                                                                        ▼
        └── proposals only ─────────────────────────────────────────▶  human review (B2.4C2)
                                                                                 │
                                          applied ONLY through the governed admin API (B2.4C3)
```

The tool sits entirely outside the request path. It imports no database driver, reads no environment
variable, performs no network access and generates no SQL — all asserted by test rather than assumed.

### 20.2 What it decides, and what it refuses to decide

**Decides deterministically:** brand links where the name matches exactly or differs only by case,
accents or punctuation; public slugs; whitespace normalisation; colour-code normalisation.

**Refuses to decide:** anything requiring judgement. There is no fuzzy brand matching — no edit
distance, no token overlap — so two names differing by one character stay two review items rather
than being silently merged. A slug that cannot be derived meaningfully is a review item, never an
internal id pressed into a public URL.

**Cannot decide, structurally:** `is_published`, `publication_state`, `verification_status`,
`source_reference`, `last_reviewed_at`, descriptions, media and replacement relations are on a
forbidden-proposal list that the plan builder throws on. They appear only as *missing* — named so a
reviewer knows what to supply, never filled in.

### 20.3 Readiness is not publishability

`READY_FOR_EDITORIAL_REVIEW` means only that the deterministic structural prerequisites are present.
The publication gate remains the sole authority on publishability, runs server-side against stored
data at the moment of publication, and is neither consulted nor simulated as a verdict here.
`publicationsProposed` is `0` in every report, by construction.

This is the same separation the rest of B2.4 enforces, one step earlier in the pipeline: the machine
prepares, the human decides, the governed API applies.

### 20.4 Confirmed untouched

No live database, production system, VPS or DNS was contacted, and **no real catalogue data was
processed** — every run used synthetic fixtures. No schema change, no API route, no response shape,
no admin frontend change. `platform/server/db/**`, `platform/server/web/**`,
`platform/server/storefront/**`, the root admin frontend, `api/src/index.js`, `api/src/migrate.js`,
`api/src/routes/public.js`, `api/src/routes/admin-public-content.js`, `docker-compose.yml`,
`Caddyfile`, `deploy.sh` and every `.env` file are unchanged, as are all pricing, inventory, ordering
and Zoho behaviour. Nothing existing was modified at all — this batch adds files only. Full contract:
`docs/public-website-rebuild/23_CATALOGUE_BACKFILL_PLAN.md`.
