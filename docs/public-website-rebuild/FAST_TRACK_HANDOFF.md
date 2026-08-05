# Fast-Track Overnight Workstream 1 — Handoff

Unattended overnight run. Five independent phases, each ending in a **local** checkpoint commit.
Nothing is pushed, deployed, or run against production.

---

## Run metadata

| | |
|---|---|
| **Branch** | `mathew/public-website-rebuild` |
| **Starting commit** | `ffcb67e` — *Add deterministic catalogue backfill planner* (B2.4C1) |
| **Starting tree** | clean, `git diff --check` clean |
| **Free space at start** | 8.9 GB |
| **Started** | 2026-08-06 |

### Baseline test counts at the starting commit

| Suite | Command | Result |
|---|---|---|
| API | `cd platform/server/api && npm test` | 923 passing |
| Root admin frontend | `node --test "test/*.test.js"` | 141 passing |
| Web (Astro) | `cd platform/server/web && npm test` | to be confirmed in Phase 2 |

---

## Safety boundary for this run

Not done at any point: production access, VPS access, live database connection, permission bootstrap
SQL, capability grants to real accounts, publication or unpublication of real records, processing of
a real catalogue export, deployment, DNS changes, `git push`, merging another developer's branch, or
changes to current storefront behaviour.

No new dependency is installed. No frontend framework, browser binary, Docker image or ORM is
introduced.

Phases are independent. A phase blocked by its own stop conditions is recorded here, left
unimplemented in a syntactically clean state, and the run continues to later phases.

---

## Phase status

| Phase | Status | Checkpoint |
|---|---|---|
| 0 — Verify and plan | complete | *(no commit — Phase 0 alone does not check point)* |
| 1 — Catalogue export preparation | complete | `checkpoint: add safe catalogue export preparation` |
| 2 — Public catalogue filters | complete | `checkpoint: add public catalogue filter interface` |
| 3 — Durable enquiry forms | pending | |
| 4 — Production SEO controls | pending | |
| 5 — Integration validation | pending | |

---

## Phase 0 — findings that shape the later phases

Recorded before any code was written, because three of them change what the later phases can
honestly deliver.

### The facet endpoint does not cover every supported filter

`GET /public/facets` returns `shapes`, `sizes`, `categories` and `brands[{slug,name}]`. It returns
**no `audience` or `material` lists** — the API accepts those two filters as documented no-ops until a
backing column exists (`catalogue-query.ts`, `15_B2_PUBLIC_API_CONTRACT.md`).

Phase 2's brief asks for controls including `audience` and `material`, and *also* requires that only
server-returned facet choices are offered and that no facet name is invented. Those cannot both hold.

**Decision:** render controls only for filters the server supplies choices for — brand, category,
shape, size — plus sort. `audience` and `material` remain accepted and forwarded by the query layer,
so the day the API starts returning them the controls can appear without further work. Rendering a
guessed list of audiences would be inventing catalogue vocabulary, which the brief forbids twice.

### `form_submissions` already supports durable storage

B2.1's table carries `form_type`, `payload` (jsonb), `source_url`, `utm`, `region`, `business_type`,
`consent_version`, `consent_at`, `delivery_state` (`pending`|`sent`|`failed` CHECK), `attempts` and
`last_error`. **No schema change is required for Phase 3**, so that phase's stop condition does not
fire.

### There is no existing rate-limiting convention

A search of `platform/server/api/src/**` found none, and `express.json({ limit: '64mb' })` is applied
globally. Phase 3's brief asks for "safe 429 **where existing rate-limiting convention supports
it**" — it does not. Unauthenticated public POST endpoints with no throttle at all are nonetheless a
real abuse surface, so Phase 3 applies a tighter body limit on the forms router and a minimal
in-process throttle, documented explicitly as a per-process mitigation rather than a distributed
control.

---

## Log

### Phase 0 — complete

- Verified branch, commit `ffcb67e`, clean tree, 8.9 GB free.
- Read the architecture, route matrix, content register, plan, risks, build package, public API
  contract, web integration, admin publication API, permission system, editor, publication workflow
  and backfill plan documents.
- Inspected: Astro route tree and `src/lib/*`, the public API client and facet contract, the
  catalogue query/page loaders, `forms`/`form_submissions` schema, `db.js` conventions, the
  sitemap-data endpoint, and the B2.4C1 audit input contract.
- Created this document.
- **Files changed:** `docs/public-website-rebuild/FAST_TRACK_HANDOFF.md` (new).
- **Tests run:** none (no code changed).
- **Next:** Phase 1 — safe catalogue export preparation.

### Phase 1 — complete

**Files changed**

| Path | Change |
|---|---|
| `platform/server/api/src/catalogue-audit/export.js` | new — read-only exporter, injected db client |
| `platform/server/api/src/catalogue-audit/review.js` | new — review-decision contract + reviewed-plan generator |
| `platform/server/api/scripts/export-public-catalogue.js` | new — export CLI |
| `platform/server/api/scripts/build-reviewed-plan.js` | new — reviewed-plan CLI |
| `platform/server/api/test/catalogue-export-review.test.js` | new — 40 tests |
| `docs/public-website-rebuild/23_CATALOGUE_BACKFILL_PLAN.md` | §17 added |

**Tests:** focused 40/40 passing. Full API suite **963 passing, 0 failing** (923 baseline + 40).

**Decisions**

- The exporter is a library function taking an **injected** db client; the CLI imports `src/db.js`
  **lazily**, so the module loads (and its argument handling is testable) with no database configured.
- `public_description`, `source_reference` and `swatch_media_id` are exported as **presence booleans**.
  Editorial copy never leaves the database, so it can never reach a review CSV.
- The review format's overridable set (`public_slug`, `brand_id`, `line`, `shape`, `segment`,
  `color_code`) is **narrower than the planner's own**, because a human typing into a review file is
  the likeliest path for a governance field to be smuggled in. Publication fields are refused with a
  distinct `FORBIDDEN_FIELD` error rather than ignored.
- **Nothing is inferred**: a proposal with no decision stays `unresolved`. Silence is never approval,
  and a mechanical proposal is not promoted for being mechanical.

**Limitations**

- No exporter has been run against a real database. `DATABASE_URL` was never set during this phase.
- The exporter reads the whole catalogue in four statements with no paging; fine at ~1,300 models,
  but it is not a streaming exporter.
- Review decisions are matched to brand groups by `comparisonKey`, which a reviewer must copy from
  `brand-mapping-review.csv`. There is no interactive tool for producing the decisions file.

**Next:** Phase 2 — public catalogue filter and facet interface.

### Phase 2 — complete

**Files changed**

| Path | Change |
|---|---|
| `platform/server/web/src/lib/catalogue-filters.ts` | new — pure filter-state builder |
| `platform/server/web/src/components/public/CatalogueFilters.astro` | new — server-rendered GET form |
| `platform/server/web/src/lib/catalogue-page.ts` | facets fetched in parallel; filter state added to page state |
| `platform/server/web/src/components/public/CatalogueListing.astro` | renders the form; splits empty-catalogue from empty-filtered |
| `platform/server/web/test/catalogue-filters.test.ts` | new — 32 tests |
| `platform/server/web/test/http-routes.test.ts` | +4 HTTP-level tests against the real server |
| `docs/public-website-rebuild/17_B2_WEB_API_INTEGRATION.md` | filter section added |

**Tests:** focused 32/32. Full web suite **346 passing, 0 failing** (310 baseline + 36). Production
Astro build succeeds.

**Decisions**

- **`audience` and `material` render no control**, because `/public/facets` returns no lists for them
  and inventing a vocabulary is forbidden. Both stay accepted and forwarded, so the controls appear
  automatically when the API starts returning them. Recorded in Phase 0 findings.
- **Facets are fetched in parallel with the listing**, and a facet failure never changes the page
  status. A visitor is not told the catalogue is down because a secondary request failed.
- **The form carries no `page` input**, so "changing a filter resets the page" is structural rather
  than a rule someone has to remember.
- **A control-less filter is not carried as a hidden input.** Invisible state a visitor cannot see or
  clear is worse than dropping it from the form; it remains honoured on the link that carried it.
- Empty-with-filters and empty-catalogue are separate states, because conflating them makes a
  filtered search read as "we publish nothing".

**Limitations**

- No result count is shown. The `listModels` contract exposes `hasMore` but no total, and inventing
  one is not possible.
- Filters are single-value per key (the API contract's shape); no multi-select.
- Sort offers only `newest` and `name` — the two the API supports.

**Next:** Phase 3 — durable public enquiry forms.
