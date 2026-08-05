# 07 — Implementation Plan

One complete release. Production stays live on `mathew/monday-release` throughout. Nothing ships
to the public domain until every gate in §6 is green.

---

## 1. Shape of the programme

| | |
|---|---|
| Batches | 12 (B0–B11) |
| Estimated engineering effort | **660–820 hours**, central estimate **~720 hours** |
| Excluded from the estimate | Veyora content writing, fact approval, legal review, photography, CRM licensing, DNS administration |
| Calendar, one engineer + reviewer | 17–20 weeks |
| Calendar, Claude Code implementing with a reviewer | 9–11 weeks, limited by review throughput and content approval rather than by coding |
| Release model | Single cutover to the canonical domain, with rollback |

The estimate assumes the Astro recommendation. The Express-templates fallback adds 120–180 hours.

---

## 2. Batches

### B0 — Decisions, freeze and discovery · **30 h** · no code

| Work | Hours |
|---|---|
| Capture the pre-build design freeze: every current public route at 6 breakpoints, desktop and mobile (`REQ-EXEC-004`) | 6 |
| Drive DECISION-01 (domain), DECISION-02 (portal), DECISION-03/04 (brands), DECISION-17 (CRM) to written answers | 8 |
| Obtain the legacy URL inventory from Search Console, Bing, analytics and backlink tooling (`REQ-CSF-010`) | 8 |
| Product-data audit: slug safety, shape coverage, description quality, image coverage across 1,318 products | 8 |

**Exit:** four coding decisions answered in writing; baseline screenshots archived; legacy URL
list delivered; data-gap report produced.

---

### B1 — Foundation · **95 h**

Scaffold `platform/server/web`; token layer ported from `store.css` `hm-*`; `Base`/`Page`
layouts; Header, MobileMenu (new editorial pattern), Footer, Breadcrumbs; navigation config;
routing skeleton for all 25 routes; metadata framework; canonical builder; `indexing.ts`;
404/500 with real status codes; redirect middleware; self-hosted font pipeline; focus-ring and
reduced-motion tokens (the two confirmed accessibility gaps); Dockerfile; local compose profile;
Playwright installed **scoped to `web/`**.

Closes 40 requirements including `REQ-CSF-001`, `REQ-SEO-001`–`003`, `REQ-IA-008`–`015`,
`REQ-GC-001`–`010`, `REQ-RAP-008`–`010`, `REQ-RAP-013`.

**Exit:** every route returns 200 with unique metadata and a real 404 for unknown paths; header
and footer pass axe and keyboard at all breakpoints; visual regression baseline accepted for the
shell.

---

### B2 — Content model and public data surface · **85 h**

Migrations `0007`+ : `brands`, `locations`, `policies`, `media`, `redirects`, `content_pages`,
`forms`, `form_submissions`, `content_approvals`; additive columns on `products` and
`variations`; governance block; publication state machine; slug-change redirect trigger.
`routes/public.js` + `public-serialize.js` allowlist serializer + cache; forbidden-key test
suite; slug generation and backfill; brand-record seeding; admin editing surfaces for brand copy,
publication and governance.

Closes 36 requirements including `REQ-CM-001`–`028`, `REQ-OUT-005`, `REQ-CM-016`.

**Exit:** forbidden-key test green against live data; publication gate rejects a record missing
approval or source; slugs unique and URL-safe across all 1,318 products; slug change writes a 301.

**Runs in parallel from here:** shape backfill and public-description review — **40–70 h of
content work**, on the critical path for `/collections/`.

---

### B3 — Core marketing templates · **120 h**

Home, Why Veyora, Service Model, Private Label, Global Presence. Includes the new editorial
modules: ProofStrip, AnswerBlock, BenefitGrid, CommercialArchitecture, PortalPreview,
ProcessSteps, Accordion, FactTable, LocationCards, MarketCoverageTable, CtaBand — each authored
per `02_VISUAL_SYSTEM_INVENTORY.md` §8 with its derivation recorded.

Closes 72 requirements.

**Exit:** five routes pass the full route-acceptance list; visual review signed; all pending facts
render as registered placeholders, never as invented values.

---

### B4 — Brands, catalogue and model templates · **135 h**

Brand index with segment filtering; brand detail; collections index; three category landings;
model detail; FilterPanel island with URL state; Gallery island; crawlable pagination; responsive
comparison and attribute tables; related models; discontinued handling; B2B gate components.

Closes 69 requirements. **The largest and riskiest batch** — it carries the URL-state filter
model, the shape facet (dependent on backfill) and the 1,318-page model route.

**Exit:** filters keyboard-operable, deep-linkable and back/forward-correct; first result page and
category copy in server HTML; every card link resolves to 200; no forbidden key in any catalogue
output; indexing policy correct for every query state.

---

### B5 — Policy, resources and search · **60 h**

Six policy routes from `policies`; ordering guide; resource hub, category and article templates
with Content Collections schema; `/sitemap/`; `/search/` with `noindex, follow`; source and
reviewer rendering; related-links component.

Closes 33 requirements.

**Exit:** policy body renders only when published; article schema rejects a missing reviewer or
source at build; search excluded from sitemaps.

---

### B6 — Forms, CRM, consent and analytics · **80 h**

Shared accessible Form component working without JavaScript; three form variants; server-side
validation; rate limiting; honeypot and timing spam controls; consent capture with version;
`form_submissions` persistence; pluggable CRM adapter with durable queue, retry and operations
alert; confirmation email via the existing `emails.js`; consent-gated analytics loader; all ten
events; PII-exclusion enforcement.

Closes 28 requirements including all ten `REQ-ANL-*` events and `REQ-FRM-001`–`017`.

**Exit:** end-to-end submission verified including a simulated CRM outage that persists the lead
and alerts operations; no PII in any analytics payload, URL or log; forms pass axe and a manual
screen-reader pass.

---

### B7 — SEO and GEO · **80 h**

Sitemap index + five children from `content_updated_at`; robots generation; canonical rules
including pagination; all eleven JSON-LD builders with DOM-equality tests; redirect map loaded
from the legacy inventory with loop, chain and homepage-concentration analysis; responsive image
pipeline with `srcset`/AVIF; OG images; favicon set; IndexNow submission on publish events;
image sitemap.

Closes 65 requirements.

**Exit:** sitemaps contain only canonical 200 URLs; a no-content rebuild produces a byte-identical
sitemap; schema validates with zero critical errors and matches the DOM; every legacy URL
resolves in one hop.

---

### B8 — Placeholder register and gate · **20 h**

Registry file; resolution helper; RC rendering; `check-placeholders.mjs` running against rendered
output; wiring into CI and the production build; ownership report.

Closes 4 requirements but gates the entire release (`REQ-DOD-011`).

**Exit:** production build fails while any blocking placeholder is unresolved; RC build succeeds
and renders placeholders visibly.

---

### B9 — QA automation and gates · **95 h**

Route contract suite across all 25 routes; crawl suite with JS disabled; axe across routes ×
breakpoints; visual regression at six breakpoints; Lighthouse CI budgets; schema validation;
forbidden-key scan across HTML, JSON and JSON-LD; form abuse and fault-injection tests;
200% zoom and reflow checks; reduced-motion simulation; manual assistive-technology pass;
device pass.

Closes 82 requirements — every `REQ-QA-*` and `REQ-DOD-*`.

**Exit:** all gates green and wired to block merges.

---

### B10 — RC deployment and staging protection · **35 h**

`web` service added to compose; Caddy restructured for public host, portal host and RC host;
basic auth and `X-Robots-Tag` on RC; `deploy.sh` extended; asset caching and compression headers;
health probe; legacy hash bridge with its allowlist security test; full redirect matrix;
rollback rehearsal.

Closes 10 requirements.

**Exit:** RC serves the complete site against production data, is not indexable, and a rollback
to the current Caddy configuration is proven in under 10 minutes.

---

### B11 — Cutover and post-launch · **35 h**

DNS and canonical-domain switch; alternate-domain 301; Search Console and Bing verification;
sitemap submission; IndexNow activation; field Web Vitals wiring; launch dashboard; 30/60/90-day
monitoring of indexing, redirect errors, crawler access, form quality and conversion.

Closes 14 requirements.

**Exit:** canonical domain serving; one indexable host; sitemaps submitted and accepted; field
data flowing within seven days; zero regressions in the portal.

---

## 3. Effort summary

| Batch | Hours | Cumulative |
|---|---:|---:|
| B0 Decisions and freeze | 30 | 30 |
| B1 Foundation | 95 | 125 |
| B2 Content model + public surface | 85 | 210 |
| B3 Core marketing templates | 120 | 330 |
| B4 Brands, catalogue, model | 135 | 465 |
| B5 Policy, resources, search | 60 | 525 |
| B6 Forms, CRM, analytics | 80 | 605 |
| B7 SEO and GEO | 80 | 685 |
| B8 Placeholder gate | 20 | 705 |
| B9 QA automation | 95 | 800 |
| B10 RC and deployment | 35 | 835 |
| B11 Cutover and post-launch | 35 | 870 |
| **Subtotal** | **870** | |
| Less parallelisable overlap (B5/B6/B7 alongside B3/B4; B9 written alongside each batch) | −150 | |
| **Net engineering estimate** | **~720 h** | |
| Range with risk | **660–820 h** | |

**Separately tracked, not engineering hours:** shape and public-description backfill 40–70 h
(content); brand copy authoring ~8 h per brand × 8–10 brands (Veyora marketing); policy drafting
and legal review (Veyora legal); resource articles 8–12 h each (Veyora).

---

## 4. Dependency order and critical path

```
B0 ──┬─> B1 ──┬─> B3 ──┐
     │        │        ├─> B9 ──> B10 ──> B11
     └─> B2 ──┼─> B4 ──┤
              ├─> B5 ──┤
              ├─> B6 ──┤
              └─> B7 ──┘
                  B8 ──┘   (B8 can start any time after B1; must complete before B10)
```

**Critical path:** `B0 → B2 → B4 → B9 → B10 → B11`
≈ 30 + 85 + 135 + 95 + 35 + 35 = **415 hours of unavoidable sequence.**

Three things sit on it and deserve watching:

1. **DECISION-01 and DECISION-02** (B0) gate the Caddy work in B10 and every canonical URL in B7.
   Late answers do not stop building — the values are configuration — but they do stop cutover.
2. **The shape backfill** (parallel from B2) gates `/collections/` filtering in B4. Start it the
   day B2's schema lands.
3. **The legacy URL inventory** (B0) gates B7's redirect map and B10's cutover validation. It
   depends entirely on Veyora-side console access and is the item most likely to be late.

---

## 5. Work packages for Claude Code

Sized so each is one reviewable unit with a clear machine-checkable exit.

| # | Package | Batch | Hours | Exit condition |
|---|---|---|---:|---|
| WP-01 | Astro scaffold, Dockerfile, compose profile, healthz | B1 | 10 | container builds and serves |
| WP-02 | Token layer ported from `store.css`, base styles, self-hosted fonts | B1 | 14 | token-diff test green |
| WP-03 | Layouts, Header, Footer, MobileMenu, Breadcrumbs, nav config | B1 | 26 | axe + keyboard green at 6 widths |
| WP-04 | Metadata framework, canonical builder, `indexing.ts`, 404/500 | B1 | 20 | route contract suite green |
| WP-05 | Redirect middleware + `redirects` table + slug trigger | B1/B2 | 14 | slug change writes a 301 |
| WP-06 | Migrations for the nine new tables + governance block | B2 | 22 | migration applies clean; publication gate test green |
| WP-07 | `routes/public.js` + allowlist serializer + cache | B2 | 26 | forbidden-key suite green |
| WP-08 | Slug generation + backfill scripts + data-quality report | B2 | 16 | 1,318 unique URL-safe slugs |
| WP-09 | Admin editing surfaces for brand, location, policy, publication | B2 | 21 | round-trip edit → publish → render |
| WP-10 | Editorial block library (Hero, ProofStrip, AnswerBlock, BenefitGrid, CtaBand, ProcessSteps, Accordion, FactTable) | B3 | 40 | visual review signed; axe green |
| WP-11 | Home template | B3 | 20 | route acceptance green |
| WP-12 | Why Veyora + Global Presence | B3 | 30 | route acceptance green; no location without a function |
| WP-13 | Service Model + Private Label | B3 | 30 | every claim policy-linked |
| WP-14 | BrandCard, ModelCard, grids, responsive tables | B4 | 26 | 4→2→1 columns; target sizes met |
| WP-15 | Brand index + brand detail | B4 | 28 | uniqueness tests green |
| WP-16 | FilterPanel island with URL state | B4 | 30 | deep link, back/forward, keyboard, axe |
| WP-17 | Collections index + three category landings + pagination | B4 | 28 | first page in server HTML; indexing policy correct |
| WP-18 | Model detail + Gallery island + related models | B4 | 23 | one canonical URL across colours |
| WP-19 | Policy routes + Content Collections | B5 | 24 | unpublished policy never renders |
| WP-20 | Resource hub, category, article templates | B5 | 24 | schema rejects missing reviewer/source |
| WP-21 | `/sitemap/` + `/search/` | B5 | 12 | search noindex; absent from sitemaps |
| WP-22 | Form component + three variants, no-JS baseline | B6 | 30 | works with JS disabled; axe green |
| WP-23 | Submission persistence, spam controls, rate limiting | B6 | 18 | abuse tests green |
| WP-24 | CRM adapter, durable queue, retry, ops alert, confirmation email | B6 | 20 | outage test persists and alerts |
| WP-25 | Consent-gated analytics + ten events | B6 | 12 | no PII in any payload |
| WP-26 | Sitemap index + five children + lastmod discipline | B7 | 18 | byte-identical rebuild |
| WP-27 | robots generation + IndexNow | B7 | 10 | agent rules configurable |
| WP-28 | Eleven JSON-LD builders + DOM-equality tests | B7 | 26 | validates with zero critical errors |
| WP-29 | Responsive image pipeline, OG images, favicon set | B7 | 26 | srcset/AVIF on every content image |
| WP-30 | Placeholder registry, resolver, gate script | B8 | 20 | production build fails while blocked |
| WP-31 | Route contract + crawl suites | B9 | 24 | all 25 routes green |
| WP-32 | axe suite across routes × breakpoints | B9 | 20 | zero violations |
| WP-33 | Visual regression suite + baselines | B9 | 22 | baselines approved |
| WP-34 | Lighthouse CI budgets | B9 | 14 | LCP/INP/CLS within budget |
| WP-35 | Forbidden-key scan across all output surfaces | B9 | 15 | scan clean |
| WP-36 | Caddy restructure, RC protection, legacy hash bridge | B10 | 22 | redirect matrix green; bridge cannot open-redirect |
| WP-37 | `deploy.sh` extension, caching headers, rollback rehearsal | B10 | 13 | rollback proven under 10 minutes |
| WP-38 | Cutover runbook, console verification, dashboards | B11 | 20 | one indexable host; sitemaps accepted |
| WP-39 | 30/60/90-day monitoring | B11 | 15 | reports delivered |

---

## 6. Gates

Nothing merges to the release branch until every gate applicable to the change is green.
Nothing cuts over until all are green on the RC host.

| Gate | Mechanism | Blocks |
|---|---|---|
| Existing platform tests | `node --test` — all 27 must stay green | merge |
| Public data boundary | forbidden-key scan of `/public/*`, HTML, JSON, JSON-LD | merge |
| Route contract | status, title, description, canonical, H1, robots, heading order | merge |
| Crawl | JS-disabled reachability, link validity, redirect hops, orphans | merge |
| Structured data | validity + DOM equality | merge |
| Accessibility | axe across 25 routes × 5 breakpoints, plus a manual AT pass before cutover | merge |
| Visual regression | 6 breakpoints against approved baselines | merge |
| Performance | Lighthouse CI budgets, LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 | merge |
| Placeholder | no unresolved blocking placeholder in rendered output | production build |
| Forms | submission, validation, spam, CRM outage, duplicate, confirmation | merge |
| SEO/crawl validation | sitemap correctness, robots, legacy redirect map | cutover |
| Portal regression | portal and admin verified on the new host layout | cutover |
| Rollback | proven revert of the Caddy layout in under 10 minutes | cutover |

---

## 7. Cutover and rollback

**Cutover (target: a low-traffic weekday morning, not a Friday)**

1. Freeze content publication.
2. Deploy the release build to the RC host; run all gates.
3. Snapshot the database and the current `Caddyfile` and compose file.
4. Apply the new Caddy layout; portal moves to `PORTAL_ORIGIN`; public site takes the canonical host.
5. Verify in order: portal login, password reset email link, shared-list link, admin panel, public routes, redirects, sitemaps, robots.
6. Point DNS for the canonical domain; 301 the alternate.
7. Verify HTTPS issuance, canonical host resolution and the redirect matrix.
8. Verify Search Console and Bing; submit sitemaps; trigger IndexNow.
9. Unfreeze publication.

**Rollback triggers:** portal login broken; API errors above baseline; public site 5xx above
0.1%; redirect loop; any forbidden key detected in public output.

**Rollback:** restore the previous `Caddyfile` and compose file and reload Caddy — the portal
returns to the catch-all immediately. The `web` container can keep running harmlessly. Database
migrations are additive and are **not** rolled back; no existing column is altered, so the
previous application code runs unchanged against the new schema. This is the main reason the data
model was designed as additive-only.

---

## 8. Post-launch

| Window | Checks |
|---|---|
| 0–48 h | Portal login and password-reset volume vs baseline; 5xx rate; redirect errors; crawl errors; form submissions arriving in the CRM |
| Week 1 | Indexing coverage; canonical selection; sitemap acceptance; field Web Vitals flowing; no staging or filter URLs indexed |
| Week 2–4 | Non-branded impressions; brand and model page discovery; crawler access from Googlebot, Bingbot and OAI-SearchBot in server logs; accessibility defect intake |
| 30 / 60 / 90 days | Indexed canonical page count; redirect error decay; conversion and qualified-lead rate; Core Web Vitals field pass rate; stale-content review queue |

---

## 9. Programme ruling — traceability correction (2026-08-04)

Sections 1–8 are retained as written. This section takes precedence where they disagree.

### 9.1 Effort estimate — unchanged

**660–820 hours, central estimate ~720 hours.** The corrected register adds 37 net rows and
extracts 57 engineering controls, but neither changes scope: the added rows are re-atomisation of
work already estimated (one route row became twelve, one schema row became eleven), and the
controls were already costed inside batches B2, B8 and B9 as implementation detail. Per-batch
hours in §2 and §3 stand.

### 9.2 What the correction does change

The release-readiness picture, not the build. **148 production blockers instead of 376.** Of those,
34 sit in B9 (the QA gates), 17 each in B3 and B4, 16 in B7, 15 each in B1 and B6, and only 2 in B8
— and just 21 wait on Veyora content approval rather than on engineering.

The practical effect is that batches B3, B4 and B5 can now complete and be signed off with pending
facts omitted, instead of being held open by content that has no engineering dependency.

### 9.3 Corrected gate table

The gates in §6 are unchanged in substance. They are now traceable to two registers rather than one:

| Gate | Backed by |
|---|---|
| Existing platform tests | `CTL-021`, `CTL-054` |
| Public data boundary | `REQ-OUT-007`, `REQ-CM-016`, `REQ-QA-023` via `CTL-001`, `CTL-002`, `CTL-003` |
| Route contract | `REQ-DOD-002`, `REQ-QA-001` via `CTL-034` |
| Crawl | `REQ-IA-022`, `REQ-COL-020`, `REQ-QA-007` via `CTL-035` |
| Structured data | `REQ-SEO-019`…`REQ-SEO-029`, `REQ-GEO-025` via `CTL-024`, `CTL-025` |
| Accessibility | `REQ-RAP-007`…`REQ-RAP-014`, `REQ-QA-018`…`REQ-QA-021` via `CTL-036`, `CTL-037`, `CTL-038`, `CTL-039` |
| Visual regression | `REQ-EXEC-012`, `REQ-DOD-001` via `CTL-033` |
| Performance | `REQ-SEO-039`…`REQ-SEO-041`, `REQ-DOD-009` via `CTL-041`, `CTL-042` |
| Placeholder | `REQ-DOD-011` via `CTL-008`, `CTL-009` |
| Forms | `REQ-FRM-004`…`REQ-FRM-009`, `REQ-DOD-007` via `CTL-013`, `CTL-044`, `CTL-045` |
| SEO / crawl validation | `REQ-SEO-012`…`REQ-SEO-016`, `REQ-QA-010` via `CTL-022`, `CTL-026`, `CTL-043` |
| Portal regression | `REQ-CSF-021` via `CTL-004`, `CTL-005`, `CTL-007` |
| Rollback | `CTL-049`, backed by the additive-only migration policy `CTL-021` |

Two controls are **new gates** that Phase 0 did not name explicitly and that must be scheduled:
`CTL-039` (contrast measurement of every token pair, before the visual baseline is accepted, B1)
and `CTL-047` (shape-backfill coverage threshold with an explicit ship-without-the-facet fallback,
B4).

### 9.4 Corrected immediate next actions

1. Approve the Astro recommendation, or elect the Express-templates fallback — **blocks B1**
2. Approve Astro, Playwright and sharp as `web/`-scoped dependencies — **blocks WP-01**
3. Answer DECISION-01 (canonical domain) — **blocks cutover, not the build**
4. Answer DECISION-02 (portal destination) — **blocks the B10 Caddy work**
5. Request the legacy URL inventory — **blocks B7**; highest schedule risk in the programme
6. Capture the design freeze (`REQ-EXEC-008`, `CTL-052`) — **blocks any code change**
7. Run the product data audit, sizing the shape backfill (`CTL-047`) — **blocks B2 planning**
8. Decide the display serif (`CTL-040`) — **blocks the visual-regression baseline**
9. Circulate the **21** blocking placeholders to their six owners — blocks release, not build

DECISION-03 (brand list) and DECISION-17 (CRM) have **dropped off the pre-coding critical path**.
Under rulings 7, 8 and 10 both are now configuration: the brand count derives from published
records and the CRM adapter defaults to a durable store with an operations alert. They remain
required before cutover, not before coding.

---

## 10. B2.1 implementation result — 2026-08-05

**Scope executed:** WP-06's schema half only — "Migrations for the nine new tables + governance
block" (§2, B2, WP-06) — delivered as `platform/server/db/migrations/0007_public_site.sql` plus its
mirror in `api/src/migrate.js`, with the additive `products`/`variations` columns from §7.2/§7.3 of
`04_TARGET_ARCHITECTURE.md` included in the same file. WP-06's stated exit condition ("migration
applies clean") is **not yet demonstrated against a real PostgreSQL instance** — no executable was
available (see `14_B2_SCHEMA_REFERENCE.md` §9) — so that half of the exit condition is met by
static/semantic test coverage instead (65 new tests, `api/test/public-schema.test.js`). WP-06's
other exit condition, "publication gate test green," is application-level work belonging to B2.2
and was not started.

**Not started, all confirmed still pending:** WP-07 (`routes/public.js` + allowlist serializer +
cache), WP-08 (slug generation + backfill scripts + data-quality report), WP-09 (admin editing
surfaces). All three remain exactly where §2's dependency graph places them — after WP-06, which is
now partially complete (schema only).

Full detail: `docs/public-website-rebuild/14_B2_SCHEMA_REFERENCE.md`;
`04_TARGET_ARCHITECTURE.md` §12; `09_FIRST_BUILD_PACKAGE.md`'s B2.1 section.

---

## 11. B2.2 implementation result — 2026-08-05

**Scope executed: WP-07 — `routes/public.js` + allowlist serializer + cache.** Its stated exit
condition in §5 is "forbidden-key suite green," and that suite now exists and is green:
`api/test/public-serialize.test.js` (15 tests, adversarial rows carrying every forbidden field),
`api/test/public-forbidden-keys.test.js` (9), `api/test/public-cache.test.js` (9) and
`api/test/public-router.test.js` (35) — **68 new tests, 634/634 total API suite passing, zero
regressions**.

**One qualification on that exit condition, stated plainly.** §6's gate table describes the
public-data-boundary gate as a "forbidden-key scan of `/public/*`, HTML, JSON, JSON-LD" running
"against live fixtures." What B2.2 delivered is the scan against *serializer outputs and endpoint
response fixtures produced through the real handlers with an injected fake database* — there is no
live database or rendered HTML to scan yet (no data has been published; the Astro site does not
consume these endpoints until B2.3). The mechanism is built and enforcing; extending it across
rendered HTML and JSON-LD remains part of B9's crawl/QA work, exactly where §2 places it.

**Still not started, unchanged from the B2.1 note above:** WP-08 (slug generation + backfill
scripts + data-quality report) and WP-09 (admin editing surfaces). WP-06 remains partially complete
(schema landed in B2.1; its "publication gate test green" exit condition is application-level work
that B2.2 did not take on either — the serializer enforces *what may be exposed*, not *what may be
promoted to published*, which is still a B2.4-era editorial concern).

**The cache-invalidation hook is deliberately unwired.** `invalidatePublicCache()` is exported and
unit-tested but is called by no admin or Zoho module — wiring it (mirroring
`invalidateCatalogCache()`'s existing hook points) belongs to WP-09/B2.4, and doing it in B2.2
would have required modifying admin/Zoho modules the brief placed out of scope.

Full detail: `docs/public-website-rebuild/15_B2_PUBLIC_API_CONTRACT.md`;
`04_TARGET_ARCHITECTURE.md` §13; `09_FIRST_BUILD_PACKAGE.md`'s B2.2 section.
