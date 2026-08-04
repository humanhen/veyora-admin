# 09 — First Build Package

The first batch of implementation work, specified tightly enough to execute without further
discovery. **Nothing in this document has been implemented.** This phase was read-only.

---

## 1. Scope

Batch **B0** (decisions and freeze, no code) followed by batch **B1** (foundation).
Together: **125 hours**, work packages WP-01 to WP-05.

The goal of B1 is a public web application that returns real HTML with real status codes on all
25 routes, wearing the approved design language, with the header, footer, navigation, breadcrumbs,
metadata framework, indexing policy, error handling and the two confirmed accessibility gaps
closed — and **no page content yet**. Templates come in B3 and B4, on top of a foundation that is
already gated.

---

## 2. Preconditions

| | |
|---|---|
| Branch | `mathew/public-website-rebuild` — no merge to or from `main` or `mathew/monday-release` |
| Untouched | `platform/server/storefront/**`, `platform/server/api/src/**` except the new `routes/public.js` in B2, all 27 existing tests, `docker-compose.yml`, `Caddyfile`, `deploy.sh`, `.env*` |
| New dependency approval required | Astro 5, `@astrojs/node`, `@astrojs/sitemap`, `sharp`, Playwright + `@axe-core/playwright` — **all confined to `platform/server/web/package.json`**, none entering the API container or the production API image |
| Decisions needed | DECISION-01 and DECISION-02 should be answered during B0. B1 can complete without them because both are environment variables — but the container will refuse to start in production mode until they are set. |

---

## 3. B0 — Decisions and freeze · 30 h · no code

### B0.1 Design freeze · 6 h
Capture the current public routes at 1440, 1280, 1024, 900, 768, 560 and 375, desktop and mobile
user agents: `/` (editorial homepage), `/#/products` (guest catalogue), `/#/login`,
`/#/list/<slug>`. Archive under `docs/public-website-rebuild/baseline/` with a capture date and
the commit hash. This is `REQ-EXEC-004` and it must happen before any code changes.

### B0.2 Decision drive · 8 h
Written answers for DECISION-01, DECISION-02, DECISION-03 and DECISION-17. Recommendations to put
in front of Veyora:

- **DECISION-01** — the specification recommends `veyora.com`, keeping `veyora.design` as
  protected staging then 301-ing it. No engineering reason to disagree.
- **DECISION-02** — portal on its own host. Structural boundary, blanket `noindex`, no shared
  `try_files` fallback, no path-prefix asset bugs.
- **DECISION-03** — separate Essedue and Kyme pages, as the specification recommends and as the
  code already assumes, with an optional Premium Italy grouping in the portfolio UI.
- **DECISION-17** — start with `CRM_ADAPTER=none`: submissions persist durably and operations is
  alerted, so no lead is ever lost while the CRM choice is made.

### B0.3 Legacy URL inventory · 8 h
Exports from Search Console, Bing Webmaster Tools, analytics, the old CMS and any backlink tool,
consolidated into `docs/public-website-rebuild/legacy-urls.csv` with columns
`url, source, clicks, impressions, backlinks, proposed_target, disposition, rationale`. Highest
schedule risk in the programme (R-05) — request it first.

### B0.4 Product data audit · 8 h
Read-only report over all 1,318 products and 3,982 variations:

- slug safety — which SKUs produce URL-unsafe or colliding slugs
- shape coverage — expected 0%; how much is inferable from name, categories and imagery
- `description` quality — how much of the old-site import is publishable as-is
- image coverage — products with no image, variations with no image
- `attributes` completeness — `lens_w`, `lens_h`, `bridge`, `temple`, `lens_type`
- colour-code derivability from variation SKU suffixes
- brand mapping — which products map to which of the approved public brands

Output: `docs/public-website-rebuild/data-audit.md` plus a per-product CSV. This sizes the B2
backfill and tells us early whether the shape facet is achievable.

---

## 4. B1 — Foundation · 95 h

### WP-01 · Scaffold · 10 h

```
platform/server/web/
├── Dockerfile              multi-stage: build → node:22-alpine runtime, non-root
├── package.json
├── astro.config.mjs        output:'server', adapter node({mode:'standalone'}), site: PUBLIC_SITE_ORIGIN
├── tsconfig.json
└── src/pages/healthz.ts    returns 200 {ok:true}, X-Robots-Tag: noindex
```

Plus `platform/server/docker-compose.override.web.yml` — a **local development profile only**, so
the production compose file is not touched until B10.

Startup assertion mirroring the API's fail-closed `startServer()`: refuse to boot when
`NODE_ENV=production` and `PUBLIC_SITE_ORIGIN` or `PORTAL_ORIGIN` is unset.

**Exit:** `docker compose --profile web up` serves `/healthz` with 200.

---

### WP-02 · Token layer and fonts · 14 h

`src/styles/tokens.css` — the block in `02_VISUAL_SYSTEM_INVENTORY.md` §6, ported verbatim from
`body.hm-dark` in `store.css`, plus the two **new** tokens the current system lacks:
`--focus-ring` and `--focus-ring-dark`.

`src/styles/base.css` — reset, `overflow-x: clip` with the `@supports not` fallback,
`-webkit-tap-highlight-color: transparent`, 16px form inputs (iOS zoom), `img { max-width: 100% }`,
a `prefers-reduced-motion` block that disables every transition and pauses autoplaying media.

Fonts: self-hosted subset Montserrat (600 and 400 are the only weights the editorial layer uses),
`font-display: swap`, preloaded. **Serif decision (DECISION deferred in §3 of
`08_RISKS_AND_OPEN_DECISIONS.md`) must be made here** — keep the local platform-dependent stack,
or self-host one licensed serif. Self-hosting is recommended because a platform-dependent display
face cannot have a stable visual-regression baseline.

**Tests:** `token-diff.test.js` asserts every value in `tokens.css` matches the documented literal
from `store.css`, so a drift is a test failure rather than a review miss. A CSS lint rule rejects
colour literals outside the token set.

**Exit:** token-diff green; no third-party font request in any response.

---

### WP-03 · Layouts, header, footer, navigation, breadcrumbs · 26 h

`Base.astro` — `<html lang>`, head slot, skip link, `<header>/<nav>/<main>/<footer>` landmarks,
JSON-LD slot.
`Page.astro` — header + breadcrumb + main + footer.

`src/lib/nav.ts` — the single navigation config:

```ts
export const primary = [
  { label: 'Why Veyora',     href: '/why-veyora/' },
  { label: 'Brands',         href: '/brands/' },
  { label: 'Collections',    href: '/collections/' },
  { label: 'Service Model',  href: '/service-model/' },
  { label: 'Private Label',  href: '/private-label/' },
  { label: 'Global Presence',href: '/global-presence/' },
  { label: 'Contact',        href: '/contact/' },
];
export const utility = [
  { label: 'Request B2B Account', href: '/request-b2b-account/', style: 'primary' },
  { label: 'Contact Sales',       href: '/contact/',             style: 'text'    },
  { label: 'B2B Login',           href: PORTAL_ORIGIN,           style: 'bordered', external: true },
];
```

`Header.astro` — extends `.hm-nav`: sticky, `rgba(245,242,236,.93)` with `backdrop-filter:
blur(10px)`, `1px --rule` bottom border, logo at `clamp(17px,4.8vw,24px)`, links at
`clamp(10px,1.6vw,11.5px)` uppercase with `.14em` tracking. `aria-current="page"` on the active
section. **Below 900px it must collapse to a menu button** — the current shrink-don't-collapse
strategy cannot hold ten items. Request B2B Account and B2B Login stay visible outside the menu
(`REQ-IA-011`).

`MobileMenu.astro` — island, `client:media="(max-width: 900px)"`. Full-height ivory overlay,
serif section headings, uppercase links, focus trap, `Escape` to close, focus returned to the
trigger, `inert` on background content. Authored in editorial language — **not** the portal's dark
`.drawer`.

`Footer.astro` — extends `.hm-foot`: `#0d0b0a`, `1px rgba(255,255,255,.08)` top border, four
`minmax(0,1fr)` columns per `REQ-GC-006`–`009` collapsing to one at 820px, legal row with the
dynamic year. **Every one of the four current dead `#/` links is replaced.**

`Breadcrumbs.astro` — derived from the route tree, emitting the visible trail and the
`BreadcrumbList` from the same data structure so they cannot disagree.

Focus: `:focus-visible` on every interactive element using `--focus-ring` / `--focus-ring-dark`.
This is `REQ-GC-003`, `REQ-RAP-009` and the first of the three confirmed accessibility gaps.

**Exit:** axe clean at 1440/1280/900/768/375; full keyboard walkthrough of header, menu and footer;
no focus trap; visual regression baseline accepted for the shell.

---

### WP-04 · Metadata, indexing policy, errors · 20 h

`src/lib/seo.ts` — builds title, description, absolute canonical from `PUBLIC_SITE_ORIGIN`,
`og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image`,
`twitter:card`. Throws at build when a required field is missing, so an incomplete route cannot
ship.

`src/lib/indexing.ts` — **the single indexing authority.** Given a path and parsed query it
returns `{ robots, canonical, inSitemap }`:

- clean path → `index, follow`, self-canonical, in sitemap
- `?page=N` (N>1) → `index, follow`, **self-canonical**, not in sitemap
- any filter parameter → `noindex, follow`, canonical to the unfiltered path, not in sitemap
- `?sort=` only → `noindex, follow`, canonical to the unsorted path, not in sitemap
- `/search/` → `noindex, follow`, not in sitemap
- 404 → `noindex, follow`; 500 → `noindex, nofollow`

One function, one test table, every state covered. This is what makes `REQ-SEO-032`,
`REQ-COL-014`, `REQ-COL-015` and `REQ-SEO-031` mechanically checkable rather than per-template
judgement.

`404.astro` — real 404 status, editorial layout, search field, links to Brands / Collections /
Contact, plus the allowlisted legacy-hash bridge (see WP-05).
`500.astro` — real 500 status, no data access, no API dependency.

All 25 routes stubbed with correct metadata and a placeholder body, so the route contract suite
can run from the end of B1.

**Exit:** route contract suite green on all 25 routes; unknown paths return 404; indexing policy
table test green.

---

### WP-05 · Redirects and the legacy hash bridge · 14 h

`src/middleware.ts`, in order: canonical host redirect → protocol redirect → trailing-slash
normalisation → `redirects` table lookup → route.

The `redirects` table and its slug-change trigger land in B2; B1 ships the middleware reading a
seed file so the mechanism is testable before the data model exists.

**Legacy hash bridge** — inline on the 404 page only:

```js
// Legacy portal links used #/ fragments. Fragments are never sent to the server,
// so this is the only place the redirect can happen. Allowlisted by design:
// an open redirect here would be a security defect, not a convenience.
(function () {
  var ALLOWED = ['products','login','set-password','list','cart','orders','dashboard',
                 'account','backorders','returns','favourites','replenishment',
                 'spare-parts','customers','lists','home'];
  var h = location.hash;
  if (h.indexOf('#/') !== 0) return;
  var seg = h.slice(2).split('/')[0];
  if (ALLOWED.indexOf(seg) === -1) return;
  location.replace(PORTAL_ORIGIN + h);
})();
```

**Tests:** every allowlisted prefix redirects to `PORTAL_ORIGIN` with the fragment intact; an
arbitrary or absolute-URL fragment does **not** redirect; no redirect loops; no chains longer than
one hop.

**Exit:** redirect matrix green; the bridge cannot be made to redirect off-host.

---

## 5. Definition of done for B1

1. `platform/server/web` builds and runs in a container; `/healthz` returns 200
2. All 25 routes return 200 with unique title, description, absolute canonical, OG and Twitter tags
3. Unknown paths return a real **404**; the error template returns a real **500**
4. Header, mobile menu, footer, breadcrumbs complete and matching the approved design language
5. Zero axe violations across all routes at five breakpoints
6. Full keyboard operation with a visible focus indicator on every interactive element
7. `prefers-reduced-motion` honoured globally
8. No third-party font or script request
9. Token-diff test green; CSS lint rejects off-palette colours
10. Indexing policy correct for every path and query state
11. Redirect middleware and hash bridge tested, including the negative security cases
12. Visual regression baseline accepted for header, footer and error pages at six breakpoints
13. **All 27 existing platform tests still green**
14. Production compose, Caddyfile, deploy.sh, `.env*` and the storefront **unchanged**

---

## 6. Explicitly out of scope for B1

Page content and templates (B3, B4) · content-model migrations and the public API surface (B2) ·
forms and CRM (B6) · sitemaps, robots, schema and image pipeline (B7) · placeholder registry
(B8) · production Caddy restructure and RC deployment (B10) · any DNS change · any commit to
`main` or `mathew/monday-release`.

---

## 7. Immediate next actions

| # | Action | Owner | Blocks |
|---|---|---|---|
| 1 | Approve the Astro recommendation, or elect the Express-templates fallback | Veyora + engineering | all of B1 |
| 2 | Approve Astro, Playwright and sharp as `web/`-scoped dependencies | Veyora | WP-01 |
| 3 | Answer DECISION-01 (canonical domain) | Veyora | cutover, not build |
| 4 | Answer DECISION-02 (portal destination) | Veyora | B10 Caddy work |
| 5 | Answer DECISION-03 (brand list) | Veyora commercial | B4 brand routes |
| 6 | Request the legacy URL inventory | Veyora | B7 redirect map |
| 7 | Capture the design freeze | engineering | any code change |
| 8 | Run the product data audit | engineering | B2 backfill sizing |
| 9 | Decide the serif face: local stack or self-hosted | Veyora design | visual regression baseline |
| 10 | Circulate the placeholder register to its six owners | Veyora | release, not build |

---

## 8. Programme ruling — traceability correction (2026-08-04)

Sections 1–7 are retained as written. This section takes precedence where they disagree.

### 8.1 Scope and effort — unchanged

B0 remains 30 hours, B1 remains 95 hours, work packages WP-01 to WP-05 are unchanged. The corrected
register did not move the foundation scope.

### 8.2 Preconditions — two decisions dropped

Section 2 listed DECISION-01 and DECISION-02 as the decisions B1 needs. That stands. **DECISION-03
(brand list) and DECISION-17 (CRM) are no longer pre-coding decisions** — under rulings 8 and 10
both are configuration. They remain B0 activities because they are needed before cutover, but they
no longer gate any code.

**One precondition is added:** the display-serif decision (`CTL-040`). A platform-dependent serif
stack cannot have a stable visual-regression baseline, so this must be settled inside WP-02 rather
than deferred. Self-hosting one licensed face is recommended.

### 8.3 B0 — corrected exit criteria

| Was | Now |
|---|---|
| Four coding decisions answered in writing | **Two** coding decisions answered (DECISION-01, DECISION-02); DECISION-03 and DECISION-17 recorded as pre-cutover configuration |
| Baseline screenshots archived | unchanged, and now traceable as `REQ-EXEC-008` with provenance control `CTL-052` (capture date + commit hash) |
| Legacy URL list delivered | unchanged — `REQ-CSF-011`, still the highest schedule risk |
| Data-gap report produced | unchanged, and must now state the **shape-facet coverage threshold** required by `CTL-047` |

### 8.4 B1 — traceability of the exit criteria

The fourteen definition-of-done items in §5 are unchanged. They now map to the registers as follows,
so each can be signed off against a numbered requirement rather than a description:

| DoD item | Requirements | Controls |
|---|---|---|
| Container builds and serves | — | `CTL-028` (fail-closed startup) |
| 25 routes return 200 with unique metadata | `REQ-IA-002`…`REQ-IA-013`, `REQ-SEO-006` | `CTL-023`, `CTL-034` |
| Real 404 and 500 | `REQ-SEO-003`, `REQ-QA-004` | — |
| Header, mobile menu, footer, breadcrumbs | `REQ-GC-001`…`REQ-GC-010`, `REQ-IA-018`…`REQ-IA-021`, `REQ-IA-026` | `CTL-057` |
| Zero axe violations | `REQ-RAP-007`, `REQ-RAP-008`, `REQ-RAP-011` | `CTL-036` |
| Visible focus on every control | `REQ-GC-003`, `REQ-RAP-009` | `CTL-037` |
| Reduced motion honoured | `REQ-RAP-013` | `CTL-038` |
| No third-party font or script | `REQ-RAP-016` | `CTL-040` |
| Token-diff green, CSS lint rejects off-palette colours | `REQ-EXEC-001`, `REQ-EXEC-011` | `CTL-030`, `CTL-031` |
| Indexing policy correct per state | `REQ-COL-014`, `REQ-COL-015`, `REQ-SEO-033` | `CTL-022` |
| Redirects and hash bridge tested | `REQ-CSF-021` | `CTL-004`, `CTL-027` |
| Visual regression baseline accepted | `REQ-EXEC-012` | `CTL-033`, `CTL-040` |
| All 27 existing tests green | — | `CTL-021`, `CTL-054` |
| Production infrastructure unchanged | — | `CTL-021` |

**One new B1 gate**, not present in the Phase 0 plan: `CTL-039` — measure the contrast of every
token pair in use **before** the visual baseline is accepted. The faint ink token at 10.5px is the
most likely WCAG 2.2 AA failure in the ported palette, and accepting a baseline that embeds a
contrast failure would mean re-baselining every subsequent template.

### 8.5 Blocking placeholders relevant to B0 and B1

Of the 21 blocking placeholders, four land inside this package: `PUBLIC_SITE_ORIGIN` and
`PORTAL_ORIGIN` (engineering, WP-01/WP-04), and `PH-FAVICON-SET` and `PH-OG-DEFAULT-IMAGE` (Veyora
design, needed before the metadata framework in WP-04 can be considered complete). The other
seventeen belong to later batches.
