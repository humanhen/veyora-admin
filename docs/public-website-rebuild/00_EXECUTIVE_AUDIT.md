# 00 — Executive Audit

**Phase 0 — read-only architecture, requirements and visual-system audit**

| Item | Value |
|---|---|
| Repository | `d:\Veyora\repositories\veyora-admin` |
| Branch audited | `mathew/public-website-rebuild` |
| Working tree at audit start | clean |
| Production release commit (protected) | `8637f49` (`mathew/monday-release` lineage) |
| Specification | `D:\Veyora\source-assets\website-specifications\Veyora_Website_Developer_Specification_SEO_GEO.docx` (v1.1, dated 2026-08-03) |
| Audit date | 2026-08-04 |
| Changes made to application code, tests, dependencies, deployment or production | **none** |

---

## 1. What this audit covers

The specification was extracted losslessly from the DOCX by unzipping the OOXML package and
walking `word/document.xml` with a read-only PowerShell/.NET XML pass into the session
scratchpad. The source document was not modified, no office suite was installed and no
dependency was added. The extraction produced **1,003 lines** covering 12 numbered content
sections, ~40 tables and Appendix A (eight wireframe figures, which this audit treats
strictly as structural references and **not** as visual designs).

The repository was inspected in full: root admin SPA, storefront SPA, Express API (all
routers), PostgreSQL migrations, Docker Compose, Caddyfile, deploy script, the 27-file test
suite, assets, and the six existing platform documents.

---

## 2. Headline finding

**The specification describes a public website that does not exist yet. What exists is a
production-grade authenticated B2B platform with a single marketing page bolted to the front
of it.**

The current public surface is one hash-routed SPA shell (`platform/server/storefront/index.html`)
that serves an empty `<div id="app">` plus nine `<script>` tags. Every route — the editorial
homepage, the guest catalogue, sign-in, shared lists — is produced by client-side JavaScript
under `#/`. There is exactly one `<title>`, one meta description and one canonical-equivalent
`og:url` for the entire site. There are no path-based routes, no per-route metadata, no
structured data, no sitemap, no robots.txt, no 404 status, and no brand, collection, service,
private-label, presence, resource, policy or form pages.

Against the specification's twelve required indexable routes plus the model-detail template
and seven policy/support routes, the current implementation satisfies **zero** at the routing
and metadata level.

That is the bad news, and it is confined to the public layer. The good news is substantial and
is the reason this rebuild is a well-bounded project rather than a platform rewrite.

---

## 3. What is already right, and load-bearing

**The visual design is real, deliberate and documented in code.** The editorial homepage
(`platform/server/storefront/js/pages_home.js` + the `hm-*` block of
`platform/server/storefront/css/store.css`, lines 405–647) is a complete, coherent design
system: a warm-ivory canvas, a local-serif display face against letter-spaced uppercase
Montserrat controls, seven composed sections, deliberate art-direction decisions recorded in
source comments (crop percentages chosen against the actual photographs, rejected alternatives
and why). This is the visual source of truth the brief protects, and it is expressible as
design tokens with no reverse-engineering. Full inventory in `02_VISUAL_SYSTEM_INVENTORY.md`.

**A public/private data boundary already exists and is enforced server-side.**
`platform/server/api/src/authmw.js` provides `optionalAuth()`, which gives anonymous visitors
a `guest` identity rather than a 401. `platform/server/api/src/routes/catalog.js` then applies
four separate guest suppressions: prices are nulled, exact stock depth is collapsed to a 0/1
availability flag, catalogue size (`total`) is withheld, internal `label:*` tags are stripped,
and the brand facet is filtered through an eight-name `PUBLIC_BRANDS` allowlist. This is
precisely the discipline the specification's model-detail and collections acceptance checks
demand, and it is reusable as the foundation of the public API surface.

**The catalogue data is real and migrated.** 1,318 products, 3,982 variations, ~31,000 units
on hand, 4,829 photographs, real Zoho creation dates, per-variation EANs and colours, and
1,117 historical orders. The public catalogue will not need placeholder products.

**The deployment model is simple and healthy.** One VPS, one Docker Compose stack, Caddy with
automatic HTTPS and a clean handler layout, `deploy.sh` as tar-over-ssh. Adding a public web
service is an additive change to a stack that already knows how to route by path.

**There is a real test culture.** 27 Node test files, including source-level assertions against
the actual storefront files on disk (`landing-map.test.js` asserts the retired distribution map
cannot silently return). The project already understands regression gates; it simply has no
browser-based or HTTP-level gates yet.

---

## 4. The five structural gaps

1. **Rendering architecture.** Hash routing and an empty HTML shell make every P0 SEO
   requirement in the specification unachievable. This is not tunable — it requires a
   server-rendered or statically generated public application. Recommendation in
   `04_TARGET_ARCHITECTURE.md`.

2. **Content model.** The database has `products`, `variations` and `stock`. It has no brand
   entity, no publication state, no canonical slug, no public description separate from the
   internal one, no metadata fields, no governance fields (source, owner, verification status,
   last reviewed), no location records, no policy records, no resource articles and no form
   definitions. The specification requires all of these, and requires publication to be blocked
   when approvals or sources are missing. Minimal safe additions are proposed in
   `04_TARGET_ARCHITECTURE.md` §7 — nine new tables and eleven product columns, no changes to
   any existing column used by the portal.

3. **Public/private boundary at the URL level.** The portal currently owns `/`. The public site
   must own `/`, and the portal must move to a stable, configurable destination. This is the
   single highest-risk item in the whole programme because it touches live customer sessions,
   password-reset emails (`setPasswordLink()` builds `${PUBLIC_URL}/#/set-password/<token>`) and
   every shared-list link already in circulation (`${PUBLIC_URL}/#/list/<slug>`).

4. **Lead capture.** The specification requires two public forms with server-side validation,
   rate limiting, consent capture, CRM handoff and a queue-on-failure guarantee ("do not lose
   the lead silently"). The platform has a `leads` table and branded transactional email, but no
   public form endpoint, no spam control, no consent record and no CRM integration.

5. **Approved facts.** A large share of the specification's content requirements depend on
   business decisions that are explicitly not yet made: the canonical domain, the public brand
   count, whether Essedue and Kyme are separate brands, whether Extreme Next is in scope, what
   each geographic location actually is, and every quantitative service claim (48–72h shipping,
   six-month exchange, two-year warranty). None of these may be invented. All are handled
   through the placeholder register in `06_CONTENT_AND_PLACEHOLDER_REGISTER.md` and a build gate
   that refuses to produce a production bundle while any unresolved token remains.

---

## 5. Recommended architecture (summary)

**Astro 5 in server mode with the standalone Node adapter, deployed as a new `web` container in
the existing Docker Compose stack behind the existing Caddy, reading public data from a new
`/public/*` read-only surface on the existing Express API.**

Rationale, rejected alternatives and full detail in `04_TARGET_ARCHITECTURE.md`. In brief:
`.astro` components are HTML-first, which preserves the existing hand-authored HTML/CSS design
language with no translation layer and no React runtime; islands keep the catalogue filters and
model gallery interactive while the rest of the page ships as plain HTML; per-route metadata,
true HTTP status codes, generated sitemaps and content collections for the policy/resource layer
are first-class; the whole thing is one additional container and one additional Caddy handler on
a stack that already does exactly this for three other services.

Next.js was rejected as disproportionate (React runtime, heavier build, larger local overhead,
furthest from the existing codebase idiom). Pure static generation was rejected because a
1,318-product catalogue synchronised from Zoho every 30 minutes would need rebuild orchestration
the project does not have. Hand-rolled Express templating was the closest runner-up and remains
the documented fallback, but it would mean hand-building responsive image handling, content
collections, hydration boundaries and sitemap tooling that Astro provides for free.

---

## 6. Effort and shape

| | |
|---|---|
| Estimated engineering effort | **660–820 hours**, central estimate **~720 hours** |
| Excluded from that estimate | Veyora-side content writing, fact approval, legal review, photography, CRM licensing |
| Critical path | Domain + portal-URL decision → foundation → content model → core templates → forms/CRM → SEO/GEO → QA gates → RC → cutover |
| Delivery model | One complete release. No partial public launch. Production stays on `mathew/monday-release` throughout. |
| Work packages | 11 staged batches, sized for Claude Code implementation with human review — see `07_IMPLEMENTATION_PLAN.md` |

---

## 7. Audit limitations, recorded rather than guessed

- **No rendered inspection was performed.** No headless browser is available: the repository has
  no `node_modules`, no Playwright or Puppeteer, and installing dependencies is prohibited by the
  brief. The visual-system inventory in `02_VISUAL_SYSTEM_INVENTORY.md` is therefore derived
  **entirely from source** — CSS custom properties, declared values, media queries, markup and
  the design rationale recorded in source comments. Every value in it is a literal from the
  repository, not an observation of a rendered page. Computed values, actual rendered type
  metrics, real-device behaviour, focus-ring appearance, contrast measurements and motion timing
  as experienced have **not** been verified and are flagged individually in that document.
- **No production system was contacted.** No request was made to `veyora.design`, `veyora.com`,
  the VPS or any Search Console/Bing property. The specification's own P0 findings about legacy
  404s, duplicate domains and crawler-visible HTML are recorded as inherited claims requiring
  first-party verification, not as findings of this audit.
- **The wireframe figures were not examined as designs.** Appendix A contains nine embedded JPEGs.
  They were deliberately not opened or interpreted visually. Their module ordering is taken only
  from the specification's written "Required module order" lists.
- **Legacy URL inventory is unavailable.** Building the redirect map requires exports from Search
  Console, Bing Webmaster Tools, analytics and backlink tooling, none of which are in the
  repository. The specification names five known redirects; those are recorded, the rest is a
  blocking pre-production task.

---

## 8. Decisions needed before coding begins

These four block implementation, not merely publication:

1. **Canonical production domain** — determines every canonical URL, sitemap entry, `PUBLIC_URL`
   and Organization schema value.
2. **Portal destination and login-handoff shape** — subdomain vs path prefix. This determines the
   Caddy layout, the cookie scope, whether `setPasswordLink()` and shared-list URLs change, and
   whether a legacy-hash bridge is needed.
3. **Public brand list** — whether Essedue and Kyme are separate entities and whether Extreme Next
   is in scope. This determines the brand route set, the brand-count claim on four pages and the
   `PUBLIC_BRANDS` allowlist.
4. **CRM target** — the specification requires source, campaign, form type, region and consent
   timestamp to be pushed on submission, with a durable queue on failure. The integration cannot
   be built against an undecided system; a database-backed queue with a pluggable adapter is the
   proposed configurable answer.

Everything else — policy values, legal details, contact details, location functions, social
profiles, brand copy — can proceed behind registered placeholders. Full split in
`08_RISKS_AND_OPEN_DECISIONS.md`.

---

## 9. Documents in this set

| File | Purpose |
|---|---|
| `00_EXECUTIVE_AUDIT.md` | This document |
| `01_CURRENT_STATE.md` | Factual current-state audit: reuse, extend, replace, protect, missing, risk |
| `02_VISUAL_SYSTEM_INVENTORY.md` | Design tokens and component language, source-derived |
| `03_REQUIREMENTS_TRACEABILITY.csv` | Every source requirement and acceptance criterion, with an exact source locator |
| `03A_ENGINEERING_CONTROLS.csv` | Derived engineering safeguards, kept out of the requirements register |
| `03B_TRACEABILITY_CHANGELOG.md` | What changed in the Phase 0.1 correction, and why |
| `04_TARGET_ARCHITECTURE.md` | Recommended architecture, boundary, data model additions |
| `05_ROUTE_TEMPLATE_MATRIX.md` | Route and template model, indexing, redirects, errors |
| `06_CONTENT_AND_PLACEHOLDER_REGISTER.md` | Placeholder policy, register and validation gate |
| `07_IMPLEMENTATION_PLAN.md` | Batches, dependencies, critical path, gates, hours |
| `08_RISKS_AND_OPEN_DECISIONS.md` | Risks and the decision split |
| `09_FIRST_BUILD_PACKAGE.md` | The first implementation batch, ready to execute |

---

## 10. Programme ruling — traceability correction (2026-08-04)

The Phase 0 sections above are retained as written. This section records the corrections applied
in Phase 0.1 and takes precedence where the two disagree.

**What was wrong.** The Phase 0 traceability package was structurally valid but was not fit to be
the programme control document. It carried 464 generated rows with no exact source locator, it
mixed source requirements with engineering safeguards the audit had invented, and it marked 376
rows as production blockers — which in practice means nothing was prioritised.

**What changed.** The specification was re-extracted from the DOCX with a structural pass that
records section, subsection, table and list positions, and the register was rebuilt from that
outline. Full detail in `03B_TRACEABILITY_CHANGELOG.md`.

| Measure | Phase 0 | Phase 0.1 |
|---|---:|---:|
| Rows in the requirements register | 464 | **501** (421 source requirements + 80 source acceptance criteria) |
| Derived engineering controls mixed into the register | unlabelled | **0** — moved to `03A_ENGINEERING_CONTROLS.csv` (57 controls) |
| Rows carrying an exact source locator | 0 | **501 (100%)** |
| Production blockers | 376 | **148** |
| Blocking placeholders | 43 | **21** |

The row count rose because the route table, the structured-data mapping, the faceted-indexing
matrix and the per-page search packages were split into atomic rows, and three sections had no
representation at all. Genuine duplication in the source — seven identical brand-route rows, the
two form field tables, the metadata matrix — was merged.

**Programme rulings now in force.** Development proceeds while business facts remain undecided.
Brand count derives from published records rather than being hard-coded. Essedue/Kyme separation
and Extreme Next publication are data configuration. Location functions use neutral presence
wording and block only where a page explicitly claims a function. CRM selection, analytics and the
Meta Pixel do not block production provided every submission is durably stored and operations is
notified. Optional social links, retailer counts, MOQ and lead-time figures and unsupported origin
claims are **omitted** rather than shown as visible placeholders.

**Effect on this document.** The architecture recommendation (§5), the 660–820 hour estimate (§6),
the audit limitations (§7) and the four pre-coding decisions (§8) are **unchanged** — reclassifying
a blocker changes when a requirement gates the release, not how much work it is. What changes is the
release-readiness picture: 148 blockers instead of 376, of which only 21 wait on Veyora content
approval.
