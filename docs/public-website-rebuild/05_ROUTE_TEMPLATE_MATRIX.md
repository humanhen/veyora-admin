# 05 — Route and Template Matrix

Every public route, its template, rendering strategy, indexing disposition, schema, data source
and acceptance test. Metadata strings are the specification's own, treated as implementation-ready
starting points to be re-checked after final terminology and the domain decision
(`REQ-META-001`).

`{ORIGIN}` = `PUBLIC_SITE_ORIGIN` (DECISION-01). `{PORTAL}` = `PORTAL_ORIGIN` (DECISION-02).
No literal domain appears anywhere in the codebase.

---

## 1. Indexable routes

| # | Route | Template | Render | Index | Canonical | Schema |
|---|---|---|---|---|---|---|
| 1 | `/` | `Home` | SSR (60 s) | index, follow | self | Organization + WebSite + WebPage |
| 2 | `/why-veyora/` | `WhyVeyora` | prerender | index, follow | self | AboutPage + Organization + BreadcrumbList |
| 3 | `/brands/` | `BrandIndex` | SSR (60 s) | index, follow | self | CollectionPage + ItemList + BreadcrumbList |
| 4 | `/brands/{brand}/` | `BrandDetail` | SSR (60 s) | index, follow | self | WebPage + Brand (mainEntity) + ItemList + BreadcrumbList |
| 5 | `/collections/` | `CollectionsIndex` | SSR (60 s) | index, follow | self | CollectionPage + ItemList + BreadcrumbList |
| 6 | `/collections/optical/` | `CategoryLanding` | SSR (60 s) | index, follow | self | CollectionPage + ItemList + BreadcrumbList |
| 7 | `/collections/sun/` | `CategoryLanding` | SSR (60 s) | index, follow | self | CollectionPage + ItemList + BreadcrumbList |
| 8 | `/collections/kids/` | `CategoryLanding` | SSR (60 s) | index, follow | self | CollectionPage + ItemList + BreadcrumbList |
| 9 | `/collections/{brand}/{model}/` | `ModelDetail` | SSR (60 s) | index, follow | self | Product or ProductGroup + Brand + BreadcrumbList — **no Offer** |
| 10 | `/service-model/` | `ServiceModel` | prerender | index, follow | self | Service + FAQPage + BreadcrumbList |
| 11 | `/private-label/` | `PrivateLabel` | prerender | index, follow | self | Service + FAQPage + BreadcrumbList |
| 12 | `/global-presence/` | `GlobalPresence` | prerender | index, follow | self | Organization + Place + BreadcrumbList |
| 13 | `/resources/` | `ResourceHub` | prerender | index, follow | self | CollectionPage + ItemList + BreadcrumbList |
| 14 | `/resources/{category}/` | `ResourceCategory` | prerender | index, follow | self | CollectionPage + ItemList + BreadcrumbList |
| 15 | `/resources/{slug}/` | `Article` | prerender | index, follow | self | Article + BreadcrumbList |
| 16 | `/contact/` | `ContactForm` | prerender | index, follow | self | ContactPage + Organization + BreadcrumbList |
| 17 | `/request-b2b-account/` | `B2BForm` | prerender | index, follow | self | WebPage + Organization + BreadcrumbList |
| 18 | `/private-label-enquiry/` | `PrivateLabelForm` | prerender | index, follow | self | WebPage + Organization + BreadcrumbList |
| 19 | `/shipping/` | `Policy` | prerender | index, follow | self | WebPage + BreadcrumbList |
| 20 | `/warranty-and-exchanges/` | `Policy` | prerender | index, follow | self | WebPage + BreadcrumbList |
| 21 | `/ordering-guide/` | `Policy` | prerender | index, follow | self | WebPage + BreadcrumbList |
| 22 | `/privacy-policy/` | `Policy` | prerender | index, follow | self | WebPage + BreadcrumbList |
| 23 | `/terms/` | `Policy` | prerender | index, follow | self | WebPage + BreadcrumbList |
| 24 | `/accessibility/` | `Policy` | prerender | index, follow | self | WebPage + BreadcrumbList |
| 25 | `/sitemap/` | `HtmlSitemap` | SSR | index, follow | self | WebPage + BreadcrumbList |

Route 18 is an addition required by `REQ-PL-009` ("a private-label enquiry path with
context-specific fields instead of sending every prospect to the generic contact form"). The
specification names the requirement but not the route.

## 2. Non-indexable and system routes

| Route | Behaviour | Status | Robots | In sitemap |
|---|---|---|---|---|
| `/search/?q=` | `SiteSearch` template | 200 | `noindex, follow` | no |
| `/collections/?brand=&shape=&…` | filtered state of route 5 | 200 | `noindex, follow`, canonical → unfiltered | no |
| `/collections/?sort=` | sorted state | 200 | `noindex, follow`, canonical → unsorted | no |
| `/collections/?page=N` (N>1) | paginated state | 200 | `index, follow`, **self-canonical** | no |
| `/robots.txt` | generated | 200 | n/a | n/a |
| `/sitemap.xml` | sitemap index | 200 | n/a | n/a |
| `/sitemap-pages.xml` etc. | child sitemaps | 200 | n/a | n/a |
| `/healthz` | deploy health probe | 200 | `noindex, nofollow` | no |
| any unknown path | `404` template | **404** | `noindex, follow` | no |
| server error | `500` template | **500** | `noindex, nofollow` | no |
| `{PORTAL}/**` | portal SPA on its own host | — | `X-Robots-Tag: noindex, nofollow` (whole host) | no |

**The pagination rule is deliberate and matters.** `REQ-SEO-031` forbids canonicalising every
paginated page to page 1, so `?page=2` is self-canonical and indexable, while filter and sort
states are not. All three states live on the same path, so the disposition is computed by
`src/lib/indexing.ts` from the parsed query — one function, one test per state, no per-template
decisions.

---

## 3. Metadata per route

| Route | Title | H1 |
|---|---|---|
| `/` | Wholesale Eyewear Distributor for Optical Retailers \| Veyora | More than eyewear distribution. A growth partner for optical retailers. |
| `/why-veyora/` | About Veyora \| Global Eyewear Distribution Partner | An international eyewear distribution partner built for modern retail. |
| `/brands/` | Wholesale Eyewear Brands for Every Retail Segment \| Veyora | A wholesale eyewear portfolio structured for every retail role. |
| `/brands/{brand}/` | {Brand} Wholesale Eyewear for Optical Retailers \| Veyora | {Brand}: {approved distinctive positioning statement} |
| `/collections/` | Wholesale Eyewear Collections and Frames \| Veyora | Explore wholesale eyewear collections for modern optical retail. |
| `/collections/optical/` | Wholesale Optical Frames for Retailers \| Veyora | *derive — must be unique, not the index H1* |
| `/collections/sun/` | Wholesale Sunglasses for Optical Retail \| Veyora | *derive — must be unique* |
| `/collections/kids/` | Wholesale Kids Eyewear for Optical Retail \| Veyora | *derive — must be unique* |
| `/collections/{brand}/{model}/` | {Model} by {Brand} \| Wholesale Eyewear \| Veyora | {Brand} {Model/SKU} |
| `/service-model/` | B2B Eyewear Distribution Services \| Veyora | Retailer-friendly eyewear distribution built to reduce friction. |
| `/private-label/` | Private Label Eyewear Programs for Retailers \| Veyora | Launch your own eyewear program without building the supply chain alone. |
| `/global-presence/` | Eyewear Distribution in Canada, USA and Europe \| Veyora | Global eyewear distribution with local support. |
| `/resources/` | Eyewear Retail Resources and Guides \| Veyora | Practical eyewear retail guidance from Veyora. |
| `/contact/` | Contact Veyora Sales \| Wholesale Eyewear Distribution | Let's build the right eyewear assortment for your business. |
| `/request-b2b-account/` | Request a Veyora B2B Account \| Wholesale Eyewear | Request a Veyora B2B account. |

The three category-landing titles and H1s and the private-label-enquiry metadata are **not
supplied by the specification** and must be authored. They are registered placeholders
(`PH-META-CATEGORY-*`) until approved. Every value carries a length check and a
cross-route uniqueness assertion.

**Global head requirements on every indexable route** (`REQ-SEO-006`, `REQ-SEO-008`,
`REQ-SEO-037`): unique `<title>`, unique `<meta name="description">`, absolute self-referential
`<link rel="canonical">` built from `{ORIGIN}` + route, `og:type`, `og:site_name`, `og:title`,
`og:description`, `og:url`, `og:image` (per-route with a designed default, 1200×630),
`twitter:card=summary_large_image`, `<html lang>`, and a `<script type="application/ld+json">`
block whose every value is present in the rendered DOM.

---

## 4. Template composition

Modules are listed in the specification's required order. `[NEW]` marks a module with no
ancestor in the current design language, to be authored per `02_VISUAL_SYSTEM_INVENTORY.md` §8.

### `/` — Home
Header → Hero *(extend existing editorial hero)* → AnswerBlock 40–80 words `[NEW]` → ProofStrip
`[NEW]` → BenefitGrid ×4 *(extend value strip)* → BrandCardGrid `[NEW]` → CommercialArchitecture
`[NEW]` → PortalPreview `[NEW]` → CtaBand *(extend closing CTA)* → Footer *(extend)*.
Data: `/public/brands`. Placeholders: brand count, proof-strip claims, portal screenshots.

### `/why-veyora/` — Why Veyora
Header → Breadcrumbs `[NEW]` → Hero → MissionVision `[NEW]` → FootprintSummary `[NEW]` (links to
`/global-presence/`) → VerifiedFacts `[NEW]` → AudienceGrid `[NEW]` → DifferentiatorAccordion
`[NEW]` → CompanyFacts `[NEW]` → CtaBand → Footer.
Data: organisation record, `/public/locations`.

### `/brands/` — Brand index
Header → Breadcrumbs → Hero → SegmentFilter island `[NEW]` → BrandCardGrid `[NEW]` →
PortfolioArchitecture `[NEW]` → BrandComparisonTable `[NEW]` → CtaBand → Footer.
The full brand list renders server-side before any filtering (`REQ-BRX-002`).

### `/brands/{brand}/` — Brand detail
Header → Breadcrumbs → BrandHero → BrandFacts `[NEW]` → BrandStory → FeaturedModels
(ModelCardGrid + B2B notice) `[NEW]` → BestFor `[NEW]` → StyleTraits `[NEW]` → ServiceBenefits
(policy-linked) `[NEW]` → CtaBand → Footer.
404 when the slug is unknown or the brand is unpublished.

### `/collections/` — Catalogue
Header → Breadcrumbs → Hero → SearchAndCategoryTabs `[NEW]` → FilterPanel island `[NEW]` →
ResultsSummary `[NEW]` → ModelCardGrid `[NEW]` → Pagination `[NEW]` → B2BGate `[NEW]` →
CategoryExplainers `[NEW]` → CtaBand → Footer.
First page of results and all descriptive copy render server-side (`REQ-COL-020`).

### `/collections/{category}/` — Category landing
Same skeleton with a category-scoped result set, **unique** hero copy and a unique explainer.
Must not be a filtered view of the index with a different title (`REQ-COL-017`).

### `/collections/{brand}/{model}/` — Model detail
Header → Breadcrumbs (Home › Collections › Brand › Model) → ModelIdentity → Gallery island
`[NEW]` → AttributeTable `[NEW]` → PublicDescription → B2BNotice `[NEW]` → RelatedModels `[NEW]`
→ WarrantySummary (policy-linked) `[NEW]` → CtaBand → Footer.
Colour selection changes gallery and displayed SKU only — **never the URL** (`REQ-IA-007`).
Discontinued models render a status notice plus alternatives and stay 200 (`REQ-CSF-014`).

### `/service-model/` — Service model
Header → Breadcrumbs → Hero → ServicePillars (policy-linked) `[NEW]` → OperationalOutcomes
`[NEW]` → ProcessSteps `[NEW]` → PortalPreview `[NEW]` → FaqAccordion `[NEW]` → CtaBand → Footer.

### `/private-label/` — Private label
Header → Breadcrumbs → Hero → WhoItIsFor `[NEW]` → ProcessSteps → WhatWeProvide `[NEW]` →
Deliverables `[NEW]` → WhyVeyora `[NEW]` → QualificationBlock `[NEW]` → CtaBand → Footer.
Primary CTA targets `/private-label-enquiry/`.

### `/global-presence/` — Global presence
Header → Breadcrumbs → Hero → LocationCards `[NEW]` → MarketCoverageTable `[NEW]` →
HowTheNetworkWorks `[NEW]` → RegionalCta `[NEW]` → CtaBand → Footer.
Every location card renders its function label or the build fails (`REQ-GP-002`).
No map graphic — the concept was retired and `landing-map.test.js` guards its absence.

### `/contact/`, `/request-b2b-account/`, `/private-label-enquiry/`
Header → Breadcrumbs → Hero → IntentSwitcher `[NEW]` → Form island `[NEW]` → ConsentBlock `[NEW]`
→ CrossLink → Footer.
Desktop may show a compact secondary panel for the other intent; **mobile shows intent selection
then one form** (`REQ-FRM-002`, `REQ-RAP-005`). The form works without JavaScript.

### Policy routes ×6
Header → Breadcrumbs → PolicyHeader (effective date, markets, last reviewed) `[NEW]` →
AnswerBlock → PolicyBody → Exclusions `[NEW]` → RelatedLinks `[NEW]` → CtaBand → Footer.
Body from the `policies` table; nothing renders while `publication_state <> 'published'`.

### `/resources/`, `/resources/{category}/`, `/resources/{slug}/`
Hub: Header → Breadcrumbs → Hero → CategoryGrid → ArticleCardGrid → CtaBand → Footer.
Article: Header → Breadcrumbs → ArticleHeader (author, reviewer, published, updated) →
AnswerBlock → TableOfContents `[NEW]` → Body → Sources `[NEW]` → RelatedLinks → CtaBand → Footer.

### `/sitemap/` — HTML sitemap
Header → Breadcrumbs → grouped link lists generated from published records → Footer.

### `404` and `500`
`404`: real 404 status, editorial layout, search field, links to Brands / Collections /
Contact, `noindex, follow`, plus the allowlisted legacy-hash bridge script (see §6).
`500`: real 500 status, no data access, no dependency on the API, `noindex, nofollow`.

---

## 5. Data sources

| Template | Endpoint / source | Cache | Failure behaviour |
|---|---|---|---|
| Home | `/public/brands` | 60 s | Render without the brand grid; log; never 500 |
| Brand index / detail | `/public/brands`, `/public/brands/{slug}` | 60 s | Unknown slug → 404; upstream failure → 500 |
| Collections, category | `/public/models`, `/public/facets` | 60 s | Upstream failure → 500 with a real 500 status |
| Model detail | `/public/models/{brand}/{slug}` | 60 s | Unknown → 404 |
| Global presence, Why Veyora | `/public/locations` | 5 min | Render without location cards |
| Policies | `policies` table via content build | build-time | Missing published policy → build failure |
| Resources | Astro Content Collections | build-time | Schema violation → build failure |
| Sitemaps | `/public/sitemap-data` | 5 min | Upstream failure → serve the previous good sitemap |

**Failure principle:** a public page must never render a *partial commercial claim*. If a
policy-linked claim cannot resolve its policy, the claim is omitted, not shown unqualified.

---

## 6. Redirects

### 6.1 Host and protocol (Caddy)

| From | To | Status |
|---|---|---|
| `http://{any}` | `https://{same}` | 301 |
| non-canonical host (incl. `www` and the alternate domain) | `{ORIGIN}` same path | 301 |
| `{ORIGIN}/index.php` | `{ORIGIN}/` | 301 |
| trailing-slash variants | canonical trailing-slash form | 301 |

The route set uses **trailing slashes** throughout, matching the specification's own notation.
One form, enforced by middleware, tested in both directions.

### 6.2 Specification-named legacy redirects (`REQ-CSF-012`)

| From | To | Status |
|---|---|---|
| `/about-us/` | `/why-veyora/` | 301 |
| `/contact-us/` | `/contact/` | 301 |
| `/shop/` | `/collections/` | 301 |
| `/index.php` | `/` | 301 |
| `/product/{slug}/` | `/collections/{brand}/{model}/` | 301 per mapped row; 410 or category fallback where no equivalent exists |

### 6.3 Portal continuity (`R-01`)

| From | To | Mechanism |
|---|---|---|
| `{ORIGIN}/#/set-password/<token>` | `{PORTAL}/#/set-password/<token>` | Client-side bridge on the 404 page — fragments never reach the server |
| `{ORIGIN}/#/list/<slug>` | `{PORTAL}/#/list/<slug>` | same |
| `{ORIGIN}/#/products`, `#/login`, `#/cart`, `#/orders`, … | `{PORTAL}/#/…` | same |

The bridge matches an **explicit allowlist** of portal route prefixes and rewrites only the host.
It must not accept an arbitrary target, or it becomes an open redirect. Covered by a dedicated
security test.

### 6.4 Data-driven redirects

Everything else lives in the `redirects` table and is applied by `src/middleware.ts` before
routing. Slug changes on published records write rows automatically (`REQ-CM-027`). Gates: no
loops, no chains longer than one hop, no more than 20% of rows targeting `/`
(`REQ-CSF-011`, `REQ-QA-010`).

---

## 7. Sitemaps

| File | Contents |
|---|---|
| `/sitemap.xml` | index referencing the four or five children below |
| `/sitemap-pages.xml` | routes 1, 2, 10–14, 16–25 |
| `/sitemap-brands.xml` | route 3 + every published brand |
| `/sitemap-products.xml` | routes 5–8 + every published model |
| `/sitemap-resources.xml` | published articles |
| `/sitemap-images.xml` | optional; product and campaign imagery |

Only canonical, indexable, 200-status URLs. `lastmod` comes from `content_updated_at`, never
from build time or the Zoho sync (`REQ-CM-028`, `REQ-SEO-012`). A rebuild with no content change
must produce a byte-identical sitemap — that is the test.

---

## 8. robots.txt

Generated at build from `src/lib/indexing.ts`, not hand-maintained.

```
User-agent: *
Disallow: /search/
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: GPTBot
{ALLOW_GPTBOT ? "Allow: /" : "Disallow: /"}        # DECISION-19

Sitemap: {ORIGIN}/sitemap.xml
```

The portal is protected by authentication and a host-wide `X-Robots-Tag`, **not** by robots.txt
(`REQ-SEO-016`). Filter and search states carry `noindex` in the response and are deliberately
**not** blocked in robots.txt, so crawlers can see the directive (`REQ-SEO-016`).

---

## 9. Route acceptance tests

Applied to every indexable route:

1. Direct request returns **200**
2. Exactly one `<h1>`; heading order has no skipped level
3. `<title>` and `<meta name="description">` present, non-empty, unique site-wide, within length bounds
4. Absolute self-referential canonical built from `{ORIGIN}`
5. OG/Twitter tags complete; `og:image` resolves 200 with correct dimensions
6. Robots directive matches `indexing.ts` for that route and query state
7. Primary copy and all navigation links present with JavaScript disabled
8. JSON-LD parses, validates, and every value appears in the DOM
9. Breadcrumb: visible trail == `BreadcrumbList` == URL path
10. Zero forbidden keys in HTML, inline JSON or JSON-LD
11. Zero unresolved `VEY_PLACEHOLDER::` tokens when `PLACEHOLDER_MODE=block`
12. axe reports no violations at 1440, 1280, 900, 768 and 375
13. Screenshot matches the approved baseline at all six breakpoints
14. Lighthouse LCP / INP / CLS within budget

Plus, site-wide: unknown paths return **404**; the error template returns **500**; every redirect
in §6 resolves in one hop; no route in the sitemap returns anything but 200; no `noindex` route
appears in any sitemap.

---

## 10. Programme correction — legacy hash bridge location (2026-08-05, B1.3)

§6.3 above is retained as written but is corrected by this section, which takes precedence where
the two disagree: **"Client-side bridge on the 404 page"** is not where the bridge runs.

A URL like `{ORIGIN}/#/login` sends only `/` to the server — the fragment after `#` is never part
of the HTTP request, so it never reaches any server-side logic, including the logic that decides a
request is a 404. `/` is a real, existing, 200-status route (route 1 in §1), so a bridge that only
lives on the 404 page never runs for a root-level legacy fragment at all — which is the single most
common shape this bridge exists to handle.

**Corrected:** the bridge is implemented once, in `platform/server/web/src/lib/
legacy-hash-bridge.ts` (the pure allowlist-matching function, unit tested), and loaded from the
shared `Base.astro` layout — meaning every one of the 25 routes in §1, not only the 404 template,
carries it. The allowlist, the "must not accept an arbitrary target" rule, and the dedicated
security test named in §6.3 are all unchanged in substance; only the loading location moved. Full
detail: `04_TARGET_ARCHITECTURE.md` §11.
