# 08 — Risks and Open Decisions

---

## 1. Risk register

Scored as Likelihood × Impact, both 1–5. Ordered by score.

### R-01 · Portal URL change breaks live customer access · L4 × I5 = **20**

The portal currently owns `/` on `veyora.design`. The public site must own it. Three concrete
breakages follow, and all three affect real customers immediately:

- `setPasswordLink()` (`api/src/authmw.js`) builds `${PUBLIC_URL}/#/set-password/<token>`.
  Activation and password-reset emails **already in inboxes** carry that URL. Tokens live three
  days.
- `listUrl()` (`api/src/routes/catalog.js`) builds `${PUBLIC_URL}/#/list/<slug>`. Shared frame
  lists have been circulated to customers and sales staff and have no expiry at all.
- Every bookmarked portal URL is a `#/` fragment. **Fragments are never transmitted to the
  server**, so no server-side redirect can fix them.

**Mitigation.** Introduce `PORTAL_URL` as a separate configuration value and update both link
builders in the same change as the Caddy restructure. Ship an allowlisted client-side legacy-hash
bridge on the public 404 page that maps known portal route prefixes to `PORTAL_ORIGIN` with the
fragment intact — with a security test proving it cannot redirect to an arbitrary host. Rehearse
on the RC host with real token and slug values. Notify customers before cutover. Keep the bridge
for at least twelve months.

**Residual.** A customer who bookmarked a portal deep link and has JavaScript disabled lands on
the public 404. Accepted.

---

### R-02 · Caddy catch-all reordering serves the wrong application · L3 × I5 = **15**

The current `Caddyfile` ends with `handle { root * /srv/storefront; try_files {path}
/index.html }`. Any mistake in the new host/handler layout either serves the portal SPA at every
public URL (total SEO failure, 200 status on everything) or serves the public site to
authenticated users (total portal outage).

**Mitigation.** Separate hosts rather than path prefixes, so the two applications never share a
`try_files` fallback. A redirect and routing matrix test that runs against the RC host before
cutover and against production immediately after. Snapshot the working `Caddyfile` before the
change; rollback is a file restore plus a reload.

---

### R-03 · Shape data does not exist and gates a P0 filter · L5 × I3 = **15**

`REQ-COL-003` requires a shape facet. There is no shape field anywhere in the schema and no
source for one — the current filter groups are lens type, gender, size and material. Classifying
~1,318 models is 40–70 hours of content work with no automated source of truth, and it sits on
the critical path for `/collections/`.

**Mitigation.** Start the backfill the day the B2 schema lands. Attempt inference from model
names, categories and imagery, then human-review. Build the filter so an unclassified model is
simply absent from shape-filtered results rather than mislabelled. If coverage is below an agreed
threshold at the gate, ship without the shape facet and record it as a known deferral — a missing
facet is recoverable; wrong shape data on 1,300 indexed pages is not.

---

### R-04 · Approved facts arrive late and block the release · L4 × I3 = **12**

Forty-three blocking placeholders across six Veyora owners. The build can be complete and still
unreleasable.

**Mitigation.** The placeholder register with named owners and a gate that reports exactly what
is outstanding and who owns it. Neutral wording so no page depends structurally on a pending
fact. Weekly outstanding-placeholder report from B2 onwards. Escalate anything still `pending`
four weeks before the target cutover.

---

### R-05 · Legacy URL inventory never materialises · L4 × I3 = **12**

The redirect map is a P0 launch requirement and there is no legacy inventory in the repository.
It depends on Veyora-side Search Console, Bing, analytics and backlink access. If it is late or
incomplete, the site launches losing whatever equity those URLs carry.

**Mitigation.** Requested in B0, before any code. Build the redirect mechanism data-driven so
rows can be added after launch without a deploy. Seed with the five specification-named redirects
plus a legacy `/product/{slug}/` pattern rule. Monitor 404s in server logs from day one and
convert real traffic into redirect rows during the first 90 days.

---

### R-06 · Public data leak through a future code change · L3 × I4 = **12**

Today's guest suppressions are conditionals inside `loadProducts()`. A contributor adding a field
to the shaped product object gets no warning. On a public, indexed, crawled site a leaked price
is permanent — it will be cached and scraped.

**Mitigation.** Replace conditionals with a pure allowlist serializer that constructs a fresh
object and never spreads a row. A forbidden-key test over `/public/*` responses, rendered HTML,
inline JSON and JSON-LD, wired as a merge gate. Recommend not exposing an availability boolean at
all — across 4,000 SKUs it is competitive intelligence.

**Implementation update — 2026-08-05 (B2.2).** The original entry above is retained as written.
The core of this mitigation is now built, and the residual risk is materially lower than L3 × I4,
though **not yet fully retired**:

- *Built:* `platform/server/api/src/public-serialize.js` — eight pure serializers, each constructing
  a fresh object literal from named fields. It never spreads a row (enforced by test), never returns
  a row unchanged, and never attaches a jsonb blob wholesale. A contributor adding a field to a
  database row now gets nothing new in public output by default — the failure mode the original
  entry described (silent leakage through an unnoticed field) is inverted: a new field is invisible
  until someone deliberately adds it to a serializer.
- *Built:* `platform/server/api/src/public-forbidden-keys.js` — one central forbidden-key authority
  with a recursive scanner reporting exact violation paths, run over every serializer output and
  every endpoint response fixture in 68 new tests. Adversarial-row tests hand the serializers a
  product/variation row carrying *every* forbidden field and assert none survives.
- *Adopted:* the recommendation not to expose availability at all. No `/public/*` response contains
  availability in any form — not a count, not the collapsed 0/1 boolean the authenticated guest
  catalogue uses.

**Why the risk is not closed.** The original mitigation specified a forbidden-key test over
"`/public/*` responses, rendered HTML, inline JSON and JSON-LD, wired as a merge gate." B2.2
delivered the first of those four surfaces. Rendered HTML and JSON-LD do not exist yet (the Astro
site does not consume these endpoints until B2.3, and JSON-LD is B7), and nothing is wired as a CI
merge gate — the scan runs as part of the test suite, which is not the same control. Additionally,
no live database was contacted, so the boundary has been proven against fixtures and fake database
clients rather than real rows. **Score unchanged pending those items**; revisit at B9, when the
crawl/QA suite can run the same scanner across rendered output and the gate can be wired.

---

### R-07 · Visual drift from the approved design · L3 × I4 = **12**

Roughly twenty modules have no ancestor in the editorial layer. Each is an opportunity to drift
toward generic template design — rounded cards, drop shadows, an accent colour, an icon set.

**Mitigation.** The twelve extension rules in `02_VISUAL_SYSTEM_INVENTORY.md` §8. A CSS lint rule
rejecting colour literals outside the token set. Visual regression at six breakpoints against
approved baselines. Every new module records its derivation in a source comment, as the current
homepage already does — that comment is what a reviewer checks against.

---

### R-08 · Existing storefront source tests break · L3 × I3 = **9**

`landing-map.test.js` (28 KB) and `storefront-modal.test.js` (18 KB) assert against the real
storefront files on disk. `landing-map.test.js` is an inverted guard protecting the retired
distribution map. Any refactor of `platform/server/storefront` breaks them.

**Mitigation.** The public site is a **new application** in `platform/server/web`. Do not refactor
the storefront to share code. Accept some duplication of tokens and markup between the two —
that duplication is what keeps the portal's regression guards intact and the portal deployable
independently.

---

### R-09 · Zoho sync changes content under a cached or prerendered page · L4 × I2 = **8**

The Zoho sync runs every 30 minutes and can deactivate a product, change a name or move stock.
A model page could 404 for a crawler mid-crawl, or a sitemap `lastmod` could churn on every sync.

**Mitigation.** `is_published` is independent of `is_active`, so a Zoho deactivation does not
unpublish a public page — unpublishing is an editorial act. `content_updated_at` is separate from
the trigger-maintained `updated_at`, so stock changes never move `lastmod`. Public caches are
60 seconds, matching the API's existing pattern.

---

### R-10 · Duplicate indexable domains during development · L3 × I3 = **9**

The specification records that both `veyora.design` and `veyora.com` are publicly discoverable.
The repository still contains a `CNAME` file reading `veyora.design` — a stale GitHub Pages
artefact. Adding an RC host without protection creates a third.

**Mitigation.** RC protected by basic auth **and** `X-Robots-Tag: noindex, nofollow`; robots.txt
is not a security control. Resolve DECISION-01 in B0 and 301 the alternate at cutover. Delete the
`CNAME` artefact as part of the cutover change (it is inert today but misleading, and it is a
one-line change that must not be made during this read-only phase).

---

### R-11 · Accessibility gaps are systemic, not cosmetic · L4 × I2 = **8**

Three confirmed gaps in the current system: no `:focus-visible` style anywhere,
`prefers-reduced-motion` not honoured while the homepage video auto-plays, and `--hm-ink-faint`
at 10.5px is a likely contrast failure. WCAG 2.2 AA is a stated target.

**Mitigation.** Focus-ring and reduced-motion tokens land in B1, before any template is written,
so nothing is built on top of the gap. Measure every token pair in use and adjust the faint token
if it fails. axe in CI plus a manual assistive-technology pass before cutover.

---

### R-12 · Performance regression from images and fonts · L3 × I2 = **6**

No `srcset` anywhere, no AVIF, fonts loaded from a third-party origin, a 519 KB unoptimised
login hero, product images served from an uploads volume with no derivatives and no CDN.

**Mitigation.** Astro's image pipeline generates derivatives for repository assets. `/s3/` product
images need a derivative strategy — generate on upload or introduce a resizing proxy; decide in
B7. Self-host subset fonts. Lighthouse CI budgets as a merge gate, with field measurement wired
at cutover because lab data alone is not the outcome measure.

---

### R-13 · CRM undecided while forms are a P0 requirement · L3 × I2 = **6**

`REQ-FRM-009` requires source, campaign, form type, region and consent timestamp pushed to "the
approved CRM", and `REQ-FRM-010` forbids silently losing a lead. No CRM is chosen.

**Mitigation.** Persist every submission to `form_submissions` first, then attempt delivery
through a pluggable adapter (`none` | `webhook` | named provider). With `CRM_ADAPTER=none` the
lead is still durably stored and operations is still alerted, so the requirement's substance —
never lose a lead — is met before the decision is made.

---

### R-14 · Photography rights are undocumented · L2 × I3 = **6**

`REQ-CM-007` requires rights holder and expiry as first-class media fields. The repository has
bare file paths. The campaign portraits are already public on the current site, which evidences
intended use but is not a rights record or a model release.

**Mitigation.** Rights and expiry are required fields on the `media` table. `MEDIA_RIGHTS_*` and
`MODEL_RELEASE_STATUS` are blocking placeholders for any asset used publicly.

---

### R-15 · Meta Pixel carried onto a public site without consent · L3 × I2 = **6**

`index.html` fires a Meta Pixel unconditionally on load and on every `hashchange`, with no
consent gate. That is defensible on an authenticated B2B portal and materially riskier on a
public marketing site targeting European buyers.

**Mitigation.** `META_PIXEL_RETAINED` is a blocking placeholder. Analytics on the public site load
only through the consent-gated loader. This is a legal question for Veyora, not an engineering
preference.

---

## 2. Decisions required **before coding begins**

Four. Each changes what gets built, not merely what gets published.

| # | Decision | Why it blocks | Owner | Default if no answer |
|---|---|---|---|---|
| **DECISION-01** | Canonical production domain | Determines every canonical URL, sitemap entry, OG url, Organization schema value, `PUBLIC_URL`, and the Caddy host layout | Veyora | **None — must be answered.** Build proceeds against `PUBLIC_SITE_ORIGIN`, but cutover cannot happen. |
| **DECISION-02** | Portal destination and login-handoff shape (subdomain vs path prefix) | Determines the Caddy layout, cookie scope, whether `setPasswordLink()` and `listUrl()` change, and whether the legacy-hash bridge is needed | Veyora + engineering | Recommended: portal subdomain |
| **DECISION-03** | Public brand list — are Essedue and Kyme separate | Determines the brand route set, the brand-count claim on four surfaces, the `PUBLIC_BRANDS` allowlist and the segment taxonomy | Veyora commercial | Build supports either; **specification recommends separate pages** |
| **DECISION-17** | CRM target | Determines the adapter, field mapping and confirmation flow | Veyora | `CRM_ADAPTER=none` — leads persist durably and operations is alerted |

DECISION-04 (Extreme Next scope) is close behind: it can default to *not published*, so it blocks
publication rather than implementation.

---

## 3. Decisions that may remain configurable

Implemented as environment variables or database rows; changeable without a code change.

| # | Decision | Mechanism |
|---|---|---|
| DECISION-15 | Localisation and hreflang | Locale-prefixed routes supported; not built for launch |
| DECISION-19 | GPTBot allow or disallow (independent of OAI-SearchBot) | `ALLOW_GPTBOT` env var → generated robots.txt |
| DECISION-20 | Analytics platform | `ANALYTICS_PROVIDER` / `ANALYTICS_ID` |
| DECISION-22 | CDN in front of Caddy | Additive; no application change |
| — | Response window shown after form success | Content record; omitted until approved |
| — | IndexNow enablement | `INDEXNOW_KEY` present or absent |
| — | Featured models per brand | Data, editable in the admin panel |
| — | Resource categories and article publication | Content collection |
| — | Redirect rows | `redirects` table, no deploy needed |
| — | Serif face: keep the platform-dependent local stack or self-host | Token layer, one change — but **decide before the visual-regression baseline is accepted** |

---

## 4. Decisions that may remain placeholders

Content decisions that block **publication**, not **implementation**. All are registered in
`06_CONTENT_AND_PLACEHOLDER_REGISTER.md` with owners, and all are enforced by the build gate.

- Public brand count and segment labels (DECISION-03, DECISION-05)
- Extreme Next scope (DECISION-04)
- Shipping window and its scope (DECISION-06)
- Exchange period and terms (DECISION-07)
- Warranty period and terms (DECISION-08)
- Resolution-logic terminology replacing "No-Return Logic" (DECISION-09)
- Legal company name, HQ address, sales email, phone, WhatsApp number, business hours, social profiles (DECISION-10)
- Whether origin, material and component-sourcing claims may be published, and at what level (DECISION-11)
- Location functions for Italy, Germany, New York and Montreal, and market coverage (DECISION-12)
- Private-label channels actively served (DECISION-13)
- Private-label minimums and lead times (DECISION-14)
- Expected response window after form submission (DECISION-16)
- Privacy policy, terms, consent wording, cookie requirement (DECISION-18)
- Meta Pixel retention (part of DECISION-20)
- Category-landing and private-label-enquiry metadata copy
- Brand positioning statements and stories
- Media rights and model-release status
- Resource article content

---

## 5. Recorded uncertainties in the specification itself

Not risks in the build — inconsistencies in the source document that need Veyora's ruling.

1. **Location list conflict.** Why Veyora names *Italy, New York and Montreal*; Global Presence
   names *Germany, New York and Montreal*. The brief permits all four. Resolve in DECISION-12.
2. **Brand count vs brand list.** The specification says "the wireframe says eight brands while
   grouping Essedue and Kyme", then lists ten candidate entities including Extreme Next. The
   current code lists eight with Essedue and Kyme already separate. Three different counts are
   in play.
3. **No native requirement numbering.** The specification is structured by section, not by
   numbered requirement. The `REQ-*` scheme in `03_REQUIREMENTS_TRACEABILITY.csv` is assigned by
   this audit and is the reference for the rest of the programme.
4. **Private-label enquiry route unnamed.** The specification requires an intent-specific path
   but does not give it a route. `/private-label-enquiry/` is proposed.
5. **Category-landing copy absent.** Three P0 indexable routes are specified with no title,
   description or H1. Registered as placeholders.
6. **Inherited P0 findings unverified.** The claims about hash routing consequences, legacy 404s
   and duplicate domains are the specification's own observations dated 2026-08-03. This audit
   confirms hash routing and the absent-metadata problem **from source**, but has contacted no
   production system, Search Console or Bing property. The legacy-404 and duplicate-domain
   findings remain inherited and require first-party verification in B0.

---

## 6. Programme ruling — traceability correction (2026-08-04)

Sections 1–5 are retained as written. This section takes precedence where they disagree.

### 6.1 Risk rescoring

Only one risk moves materially.

| Risk | Before | After | Reason |
|---|---:|---:|---|
| **R-04** Approved facts arrive late and block the release | L4 × I3 = 12 | **L4 × I2 = 8** | Ruling 13 makes omission the default for optional claims, and rulings 7–12 make brand count, brand separation, Extreme Next, CRM, analytics and the Meta Pixel configuration rather than content. Blocking placeholders fall from 43 to 21, and commercial and product now hold none. |
| **R-13** CRM undecided while forms are P0 | L3 × I2 = 6 | **L2 × I2 = 4** | Ruling 10 plus `CTL-013`: every submission persists to `form_submissions` and alerts operations before any delivery attempt, so the substance of "never lose a lead" is met with `CRM_ADAPTER=none`. |
| **R-03** Shape data does not exist | L5 × I3 = 15 | **unchanged** | `CTL-047` adds an explicit ship-without-the-facet fallback, which caps the impact but does not remove the 40–70 hour content task from the critical path. |

R-01 (portal URL change), R-02 (Caddy reordering), R-05 (legacy URL inventory), R-06 (public data
leak), R-07 (visual drift) and R-11 (accessibility gaps) are **unchanged**. R-01 and R-02 remain the
two highest-scoring risks in the programme.

**One risk is added:**

**R-16 · Over-classification of blockers recurs · L2 × I3 = 6.** A register with 376 blockers
prioritises nothing, and the pressure to re-mark rows as blocking will return at every gate review.
*Mitigation:* the eleven blocking criteria are now the written test, `03B_TRACEABILITY_CHANGELOG.md`
§5.4 records the reason for every reclassification, and any change to a `production_blocker` value
must cite one of the eleven criteria in the row's `notes`.

### 6.2 Corrected decision split

**Required before coding begins — now two, not four.**

| # | Decision | Why it still blocks |
|---|---|---|
| DECISION-01 | Canonical production domain | Determines every canonical, sitemap entry and OG URL, and the Caddy host layout. Build proceeds on configuration; **cutover cannot**. |
| DECISION-02 | Portal destination and login-handoff shape | Determines the Caddy layout, cookie scope, whether the two link builders change and whether the legacy-hash bridge is needed. |

**Moved off the pre-coding path:**

- **DECISION-03** (Essedue/Kyme separation) — ruling 8: data-configurable via publication flags.
  Required before cutover, not before coding.
- **DECISION-17** (CRM target) — ruling 10: `CTL-013` satisfies the durable-capture requirement
  with the adapter disabled. Required before cutover, not before coding.
- **DECISION-04** (Extreme Next) — ruling 9: unpublished by default; blocks nothing.

**Two engineering decisions are added to the pre-coding path**, both discovered during the
correction and both affecting work that would otherwise have to be redone:

- **The display serif** (`CTL-040`) — keep the platform-dependent local stack or self-host one
  licensed face. A platform-dependent display face cannot have a stable visual-regression baseline,
  so this must be settled before the B1 baseline is accepted.
- **Shape-facet coverage threshold** (`CTL-047`) — the point at which the catalogue ships without
  the shape filter rather than with unreliable classifications across ~1,300 indexed pages.

### 6.3 Decisions that may remain configurable — expanded

Added under the rulings: brand count derivation, Essedue/Kyme separation, Extreme Next publication,
CRM adapter selection, analytics provider (disabled by default) and Meta Pixel retention (removed by
default). The Phase 0 list in §3 otherwise stands.

### 6.4 Decisions that may remain placeholders — reduced

The §4 list stands, with the reclassification recorded in
`06_CONTENT_AND_PLACEHOLDER_REGISTER.md` §8.4: 22 of the 43 formerly blocking placeholders now
resolve through omission, neutral wording or configuration. Twenty-one remain blocking, and six of
those sit with Veyora legal — which is now the single most schedule-critical content owner.

---

## 7. Programme correction — legacy hash bridge location (2026-08-05, B1.3)

R-01's mitigation (§1, "Portal URL change breaks live customer access") originally read: "Ship an
allowlisted client-side legacy-hash bridge **on the public 404 page**." That placement does not
work, and the reason is structural rather than a tuning question: `{ORIGIN}/#/login` sends only `/`
to the server, because everything after `#` is a URL fragment and a fragment is never transmitted
in an HTTP request. `/` is a real, existing, 200-status route — it never reaches 404 — so a bridge
that only lives on the 404 page never runs for the single most common shape of legacy link: a
bookmark or an old inbound link to the bare origin carrying a root-level fragment.

**Corrected mitigation:** the bridge (`platform/server/web/src/lib/legacy-hash-bridge.ts` plus a
bundled script in `src/layouts/Base.astro`, B1.3) now loads from the shared page layout every one
of the 25 public routes renders through, not from the 404 template alone. It remains an explicit,
strict allowlist matched with case-sensitive, non-decoded equality — no leniency was traded for the
wider reach — and the "residual: a customer with JavaScript disabled lands on the public 404" risk
noted in R-01 is unchanged, since the bridge is client-side JavaScript by necessity (fragments are
invisible to any server, so nothing server-side could ever substitute for it). R-01's score (L4 ×
I5 = 20) and its other mitigations (separate `PORTAL_URL` configuration, RC rehearsal, twelve-month
retention) are unaffected by this correction. Full detail: `04_TARGET_ARCHITECTURE.md` §11,
`05_ROUTE_TEMPLATE_MATRIX.md` §10.
