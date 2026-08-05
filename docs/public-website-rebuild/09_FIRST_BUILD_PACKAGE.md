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

---

## 9. B1.1 implementation result — 2026-08-05

**Scope executed:** a deliberately narrow slice of B1 — Astro foundation, environment handling,
the health endpoint, and the ported design tokens/base styles, with foundation-level tests. This
is **not** all of WP-01–WP-05: no layouts, header, footer, navigation, breadcrumbs, metadata
framework, indexing policy, 404/500 pages, redirect middleware or legacy-hash bridge were built.
Those remain open work inside batch B1, to follow in a subsequent increment (informally "B1.2").
Executed on a fresh low-storage clone on `C:`, starting from commit `2c749ec` on
`mathew/public-website-rebuild`, per the constraints in the executing session's task brief.

### 9.1 Correction — B1.1A, 2026-08-05: wire the fail-closed environment contract

The original B1.1 pass implemented and fully tested `resolveEnv()` (`src/env.ts`) as a pure
function but did not wire it into anything that actually runs during a build or a boot — the
known limitation recorded at the time. This correction closes that gap without adding a
dependency and without touching anything outside `platform/server/web`.

**Mechanism — one script, two gates, no divergent reimplementation.**
`scripts/validate-env.mjs` is a small new file whose only job is to dynamically import
`resolveEnv` from `src/env.ts` and call it against `process.env`, printing a one-line
`[env] FATAL: …` message and exiting `1` on rejection. It is run as a **separate process ahead
of** the real command in both places that matter:

- **Build** — `package.json` `"build"` is now `node ./scripts/validate-env.mjs && astro build`.
  In development (or with `NODE_ENV` unset) the gate passes on the documented localhost defaults,
  exactly as before, so nothing about local/dev builds changed. In production mode, a missing or
  malformed origin exits non-zero **before `astro build` ever runs** — no partial `dist/` is
  produced. `astro.config.mjs` also now imports the same `resolveEnv()` (not a second, separately
  maintained default) for its own `site` value, as defence in depth for anyone invoking `astro
  build` directly rather than through the npm script.
- **Startup** — `package.json` `"start"` is now `node ./scripts/validate-env.mjs && node
  ./dist/server/entry.mjs`. Because these are two separate process invocations chained with `&&`,
  a gate failure means the server process is **never spawned at all** — not merely that it exits
  quickly after binding a port. The Dockerfile's runtime `CMD` was changed from a bare
  `node ./dist/server/entry.mjs` to `sh -c "node ./scripts/validate-env.mjs && exec node
  ./dist/server/entry.mjs"`, copying `scripts/` and `src/env.ts` into the runtime image; `exec`
  hands PID 1 to the server once validation passes, so container signal handling is unchanged
  from before. The build stage still does not set `NODE_ENV=production` (unchanged reasoning: real
  origins are supplied at container run time, not image build time), so the Docker image build
  itself is unaffected — an operator who wants origins baked in at image-build time can pass
  `NODE_ENV=production` plus both origins as build-time environment and the same gate enforces
  them, with no separate code path.

**Verified production build behaviour** (`npm run build`, from `platform/server/web`):

| Scenario | Result |
|---|---|
| `NODE_ENV=production`, `PUBLIC_SITE_ORIGIN` missing | exits `1`, `[env] FATAL: PUBLIC_SITE_ORIGIN is required in production and was not set. Refusing to start.` — no `astro build` output at all |
| `NODE_ENV=production`, `PORTAL_ORIGIN` missing | exits `1`, equivalent message for `PORTAL_ORIGIN` |
| `NODE_ENV=production`, `PUBLIC_SITE_ORIGIN=not-a-url` | exits `1`, `[env] FATAL: PUBLIC_SITE_ORIGIN must be an absolute http(s) URL, got: "not-a-url"` |
| `NODE_ENV=production`, both origins valid (`http://127.0.0.1:4321` / `:4322`) | `astro build` runs and completes, `dist/server/entry.mjs` produced |

**Verified production startup behaviour** (`npm run start`, from `platform/server/web`):

| Scenario | Result |
|---|---|
| `PUBLIC_SITE_ORIGIN` missing | exits `1` before printing anything about listening; `netstat` confirms the target port never opens |
| `PORTAL_ORIGIN` missing | exits `1`, same confirmation — port never opens |
| Both origins valid, explicit `127.0.0.1` values | server starts, `GET /healthz` → `200`, `application/json`, `X-Robots-Tag: noindex, nofollow`, `{"ok":true}`; process stopped cleanly afterward |

**Tests.** `test/command-paths.test.ts` (new) spawns the real `npm run build` / `npm run start`
commands as child processes with injected environments and asserts on actual exit codes,
stdout/stderr content, and — for startup — whether the port ever opened, plus two static checks
that `package.json` and the `Dockerfile` both reference `validate-env.mjs`. 9 tests added; full
suite is 53/53. One issue surfaced and was fixed during this correction: the first suite run hung
indefinitely with zero output. Diagnosis (via `Get-CimInstance Win32_Process`) traced it to the
"startup succeeds" test's cleanup — on Windows, `spawn('npm', ['run','start'], {shell:true})`
returns a handle to the outer `cmd.exe`/`npm.cmd` wrapper, and killing that handle does not kill
the actual `node dist/server/entry.mjs` grandchild process, which was left running, holding the
port and its stdio pipes, keeping that test file's worker process alive forever. The fix: that one
test now runs the env gate via `spawnSync` and then spawns `node ./dist/server/entry.mjs`
**directly** (no shell, no npm wrapper) — the same two commands the `start` script chains, invoked
without an intermediate process that swallows the kill signal — so `child.kill()` terminates the
real server process. Verified clean after the fix: full suite reruns in ~11s with no leftover
`node.exe` processes and the test port released each time.

**New files added by this correction:** `scripts/validate-env.mjs`, `test/command-paths.test.ts`.
**Existing files modified:** `astro.config.mjs`, `package.json`, `Dockerfile`. No file outside
`platform/server/web` and this document changed.

**The known limitation recorded in the original B1.1 pass — "not yet wired into the server's
actual boot sequence" — is now closed.** Both the build and the standalone server startup fail
closed, before doing any real work, on a missing or malformed `PUBLIC_SITE_ORIGIN`/`PORTAL_ORIGIN`
in production, using the one existing `resolveEnv()` implementation with no divergent copy.

### Files created

```
platform/server/web/
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── astro.config.mjs
├── package.json
├── package-lock.json
├── tsconfig.json
├── scripts/
│   └── validate-env.mjs        the one build/startup env gate — added in the B1.1A correction below
├── src/
│   ├── env.ts                 environment contract — resolveEnv(), DEV_DEFAULT_*, env
│   ├── pages/
│   │   ├── healthz.ts          GET /healthz
│   │   └── index.astro         temporary placeholder homepage
│   └── styles/
│       ├── tokens.css          ported editorial design tokens
│       └── base.css            reset, focus-visible, reduced-motion, base typography
└── test/
    ├── env.test.ts
    ├── astro-config.test.ts
    ├── healthz.test.ts
    ├── tokens.test.ts
    ├── base-styles.test.ts
    └── command-paths.test.ts   added in the B1.1A correction below
```

Also created: `docs/public-website-rebuild/baseline/README.md` (visual baseline manifest — no
screenshots captured, per scope). No other path was created, modified or deleted.

`astro.config.mjs`, `package.json` and `Dockerfile` listed above were **modified** by the B1.1A
correction (§9.1 below), not created fresh; everything else in this tree was created in the
original B1.1 pass.

### Dependencies and exact versions

| Package | Version | Why this version |
|---|---|---|
| `astro` | `5.18.2` | Latest Astro 5.x at time of build — spec requires Astro 5 |
| `@astrojs/node` | `9.5.5` | Latest `@astrojs/node` whose peer range (`^5.17.3`) is satisfied by Astro 5.18.2; later majors (10.x, 11.x) require Astro 6/7 |

No other dependency was installed. Playwright, `sharp`, `@astrojs/sitemap`, React and every other
package named in `04_TARGET_ARCHITECTURE.md`/`09_FIRST_BUILD_PACKAGE.md` §4 for later work
packages was deliberately **not** installed in this batch.

### Commands run

Original B1.1 pass:

```
npm install --no-audit --no-fund      (platform/server/web)
npm test                              (platform/server/web)
npm run build                         (platform/server/web)
node ./dist/server/entry.mjs          (manual local run, then stopped)
npm ci --no-audit --no-fund           (platform/server/api — to run the existing suite)
npm test                              (platform/server/api)
```

B1.1A correction (§9.1 below) additionally ran, from `platform/server/web`:

```
npm test                                                                          (53/53, includes real build/start command-path tests)
PUBLIC_SITE_ORIGIN=http://127.0.0.1:4321 PORTAL_ORIGIN=http://127.0.0.1:4322 NODE_ENV=production npm run build
NODE_ENV=production PORTAL_ORIGIN=http://127.0.0.1:4322 npm run build             (rejects — PUBLIC_SITE_ORIGIN missing)
NODE_ENV=production PUBLIC_SITE_ORIGIN=http://127.0.0.1:4321 npm run build        (rejects — PORTAL_ORIGIN missing)
NODE_ENV=production PUBLIC_SITE_ORIGIN=not-a-url PORTAL_ORIGIN=... npm run build  (rejects — malformed)
PUBLIC_SITE_ORIGIN=http://127.0.0.1:4321 PORTAL_ORIGIN=http://127.0.0.1:4322 NODE_ENV=production HOST=127.0.0.1 PORT=4321 npm run start   (manual run, then stopped)
NODE_ENV=production PORTAL_ORIGIN=http://127.0.0.1:4322 PORT=4321 npm run start   (rejects — PUBLIC_SITE_ORIGIN missing, port never opened)
NODE_ENV=production PUBLIC_SITE_ORIGIN=http://127.0.0.1:4321 PORT=4321 npm run start  (rejects — PORTAL_ORIGIN missing, port never opened)
```

The API test suite was **not** re-run for this correction, per instruction — no API source changed.

### Test result

`platform/server/web`: **53/53 tests passing** (`node --test`; 44 from the original B1.1 pass plus
9 added in the B1.1A correction). Original coverage: development origin defaults and acceptance,
production fail-closed rejection of missing `PUBLIC_SITE_ORIGIN` and `PORTAL_ORIGIN`, malformed-
origin rejection (bad scheme, path, query, fragment, non-URL), trailing-slash normalisation
stability, Astro config asserting `output: 'server'` and the `@astrojs/node` adapter, a full-source
scan proving no hard-coded `veyora.design`/`veyora.com`, the `/healthz` contract (200, JSON,
`X-Robots-Tag`, no extra body fields), and the tokens/base-CSS assertions (approved source colour
values, serif/sans stacks, type scale, layout tokens, motion durations, control/link heights, the
one soft-lift shadow, focus-ring tokens, the zero-radius square-corner policy with no rounded-card
token, `:focus-visible` with a dark-surface variant, `prefers-reduced-motion`, and 16px form-
control font size). B1.1A addition, `test/command-paths.test.ts`: spawns the actual `npm run
build`/`npm run start` commands as child processes with injected environments and asserts on their
real exit codes, stdout/stderr and (for startup) whether the port ever opened — see §9.1.

### Build result

`astro build` completed successfully in server mode with the `@astrojs/node` standalone adapter,
producing `dist/server/entry.mjs` and `dist/client/`. As of the B1.1A correction, `npm run build`
now runs `scripts/validate-env.mjs` first and only invokes `astro build` if it passes — see §9.1
for the production-mode fail-closed behaviour this adds.

### Health result

Started the built server locally via the validated `npm run start` (`PUBLIC_SITE_ORIGIN`/
`PORTAL_ORIGIN` set to explicit `127.0.0.1` values, `NODE_ENV=production`) and requested `/healthz`:

- `HTTP/1.1 200 OK`
- `content-type: application/json`
- `x-robots-tag: noindex, nofollow`
- body: `{"ok":true}`

The temporary `/` route was also spot-checked and renders with the ported tokens/base styles
inlined correctly. The local process was stopped after verification, both in the original B1.1
pass and again after the B1.1A correction (re-verified against the now-validated start path).

### Existing API test result

`platform/server/api`: **501/501 tests passing**, unchanged, run from a fresh `npm ci` against the
committed lockfile (no lockfile or package.json edits). This is a fresh clone, so `node_modules`
did not exist yet in either application; installing it is not a change to any tracked file.

### Free space on C:

| Checkpoint | Free space |
|---|---|
| Before any work (Task 1, original B1.1 pass) | 8.25 GB |
| Before `web` npm install | 8.26 GB |
| After `web` npm install | 8.08 GB |
| After `web` build | 8.08 GB |
| After `api` npm ci + test | 8.07 GB |
| Before B1.1A correction | 8.05 GB |
| After B1.1A correction (final) | 8.05 GB |

Never approached the 4 GB floor across either pass; the B1.1A correction added no dependency and
consumed no measurable additional space (build output is repeatedly overwritten, not accumulated).

### Known limitations

- No header, footer, navigation, breadcrumbs, 404/500 pages, or metadata framework exist. The one
  real page (`/`) is an explicitly temporary placeholder.
- The display-serif self-hosting decision (`CTL-040`) remains open; `tokens.css` still declares
  the platform-dependent local stack, exactly as ported from source, with the pending decision
  noted in a comment.
- No visual-regression baseline exists yet; `docs/public-website-rebuild/baseline/README.md` is a
  manifest only, with no screenshots captured, per the low-storage/no-live-capture scope of this
  session.
- `platform/server/docker-compose.override.web.yml` (the local development compose profile
  mentioned in WP-01) was not created — it did not appear in this session's permitted file list
  and is deferred along with the rest of the local-orchestration work.
- ~~The environment contract is not wired into the server's actual boot sequence.~~ **Closed by
  the B1.1A correction — see §9.1.** Both `npm run build` and `npm run start` (and the Dockerfile's
  runtime `CMD`) now run `scripts/validate-env.mjs` first and refuse to proceed on a production
  misconfiguration, before `astro build` runs or any port opens.

### Deferred to later work

- **Rest of B1** (WP-03, WP-04, WP-05): layouts, header, mobile menu, footer, breadcrumbs,
  navigation config, metadata framework, `indexing.ts`, 404/500 pages, redirect middleware, and the
  legacy-hash bridge. (Wiring the environment contract into a fail-closed boot sequence — originally
  listed here — was pulled forward and closed by the B1.1A correction, §9.1.)
- **B2 onward**: content model migrations, the `/public/*` API surface, marketing templates,
  catalogue/brand/model templates, policy and resource routes, forms/CRM, SEO/GEO, the placeholder
  gate, QA automation, RC deployment, and cutover — unchanged from `07_IMPLEMENTATION_PLAN.md`.

### Confirmation

No protected path was created, modified or deleted, across either the original B1.1 pass or the
B1.1A correction: `platform/server/storefront/**`, `platform/server/api/src/**` (only
`node_modules` was installed, which is untracked and unmodified in git), `platform/server/db/**`,
the root admin application, `docker-compose.yml`, `Caddyfile`, `deploy.sh`, and all `.env` files
outside `platform/server/web` are all untouched — confirmed by `git status --short` showing only
the two new untracked directories (`platform/server/web/` and
`docs/public-website-rebuild/baseline/`) plus this one modified document. No commit was made,
nothing was pushed, no Docker image was built, and no production, staging or live Veyora system
was contacted at any point in either pass.

---

## 10. B1.2 implementation result — 2026-08-05

**Scope executed:** shared public layouts (`Base.astro`, `Page.astro`), the central navigation
config, a desktop header, an accessible mobile menu (Astro + vanilla browser JavaScript only), a
footer, breadcrumbs, and skeleton routes for all 25 public routes in
`05_ROUTE_TEMPLATE_MATRIX.md`, with source-level and HTTP-level tests. Executed from
`mathew/public-website-rebuild` at starting commit `6cc73e0` (B1.1 committed). Per the task brief,
this run did not inspect, duplicate, alter or merge the other developer's concurrent storefront
bug-fix branch — that branch was never referenced, read, or touched.

Explicitly **not** built, per scope: the full metadata framework, `indexing.ts`, custom 404/500
pages, the legacy hash bridge, database migrations, the `/public/*` API surface, catalogue
functionality, forms, CRM, sitemaps (XML), structured data, and production deployment. These
remain open — B1's WP-04/WP-05 and B2 onward.

### Files created

```
platform/server/web/
├── public/
│   ├── logo-black.svg          copied (not moved/modified) from storefront/assets — header
│   └── logo-white.svg          copied (not moved/modified) from storefront/assets — footer
├── src/
│   ├── lib/
│   │   ├── nav.ts               primary/utility nav + 4 footer groups — single source of truth
│   │   └── routes.ts             breadcrumb tree, humanizeSlug(), BreadcrumbItem type
│   ├── layouts/
│   │   ├── Base.astro            html/head shell, skip link, head + structured-data slots
│   │   └── Page.astro            Header + optional Breadcrumbs + main#main-content + Footer
│   ├── components/
│   │   ├── nav/
│   │   │   ├── Header.astro      sticky translucent header, desktop nav, menu trigger
│   │   │   ├── MobileMenu.astro  ivory overlay panel + vanilla-JS open/close/focus-trap script
│   │   │   ├── Footer.astro      dark footer, 4 groups from nav.ts, dynamic copyright year
│   │   │   └── Breadcrumbs.astro <ol>, aria-label="Breadcrumb", current page as non-link <span>
│   │   └── dev/
│   │       └── SkeletonNotice.astro  shared placeholder body used by all 25 route skeletons
│   └── pages/                    24 files implementing all 25 routes (see below)
└── test/
    ├── nav.test.ts
    ├── components.test.ts
    ├── routes.test.ts
    └── http-routes.test.ts
```

**Existing files modified:**

- `src/pages/index.astro` — rewritten from B1.1's temporary foundation notice to the real home
  route skeleton (`Page` layout, documented H1, `SkeletonNotice`).
- `astro.config.mjs` — added `trailingSlash: 'always'`; also reworked its `site` default (see
  "Known limitations" — a real regression was found and fixed here, not merely a style change).
- `src/styles/base.css` — added `body.mobile-menu-open { overflow: hidden; }`, the scroll lock the
  mobile menu script toggles (targets `<body>`, which no component renders, so it cannot live in a
  scoped component style).

No other path was created, modified or deleted.

### Route files (24 files → all 25 routes)

Every route in `05_ROUTE_TEMPLATE_MATRIX.md` §1 has a skeleton. One pair shares a file:
`/resources/{category}/` and `/resources/{slug}/` are both single-dynamic-segment siblings at
`/resources/*/`, which Astro's file router cannot host as two separate dynamic files (`[category]`
and `[slug]` would collide on the same pattern) — `src/pages/resources/[slug]/index.astro` stands
in for both until Content Collections (B5) make the category/article distinction possible. See
"Known limitations" below.

| # | Route | File |
|---|---|---|
| 1 | `/` | `pages/index.astro` |
| 2 | `/why-veyora/` | `pages/why-veyora/index.astro` |
| 3 | `/brands/` | `pages/brands/index.astro` |
| 4 | `/brands/{brand}/` | `pages/brands/[brand]/index.astro` |
| 5 | `/collections/` | `pages/collections/index.astro` |
| 6–8 | `/collections/{optical,sun,kids}/` | `pages/collections/{optical,sun,kids}/index.astro` |
| 9 | `/collections/{brand}/{model}/` | `pages/collections/[brand]/[model]/index.astro` |
| 10 | `/service-model/` | `pages/service-model/index.astro` |
| 11 | `/private-label/` | `pages/private-label/index.astro` |
| 12 | `/global-presence/` | `pages/global-presence/index.astro` |
| 13 | `/resources/` | `pages/resources/index.astro` |
| 14, 15 | `/resources/{category}/`, `/resources/{slug}/` | `pages/resources/[slug]/index.astro` (shared) |
| 16 | `/contact/` | `pages/contact/index.astro` |
| 17 | `/request-b2b-account/` | `pages/request-b2b-account/index.astro` |
| 18 | `/private-label-enquiry/` | `pages/private-label-enquiry/index.astro` |
| 19–24 | six policy routes | `pages/{shipping,warranty-and-exchanges,ordering-guide,privacy-policy,terms,accessibility}/index.astro` |
| 25 | `/sitemap/` | `pages/sitemap/index.astro` |

**H1/title policy applied uniformly:** where `05_ROUTE_TEMPLATE_MATRIX.md` §3 documents an
approved title/H1 (routes 1, 2, 3, 5, 10, 11, 12, 13, 16, 17; route 12's title carries the
specification's own not-yet-approved country list, used verbatim and unchanged, not invented),
that exact text is used. Everywhere else — the three category landings, both dynamic routes, the
enquiry route, all six policy routes, and the HTML sitemap — a neutral structural label is used
(`"{X} page"` / `"{X} collection page"`), per the task brief's own example wording. No lorem ipsum,
no invented Veyora fact, anywhere.

### Tests run and passed

`platform/server/web`: **107/107 tests passing** (`node --test`), all with the existing
lightweight Node approach — no browser tooling installed. Breakdown: 53 carried over unchanged
from B1.1/B1.1A, 54 new. New coverage: central nav contains every required path and no `#/` route;
B2B Login sourced from `env.portalOrigin` (never a literal); Request B2B Account is the primary
utility action while B2B Login is not; footer groups derive from `nav.ts` and include
Privacy/Terms/Accessibility with no fake social URL; Base/Page provide the skip link and the
`#main-content` landmark; Header exposes semantic, labelled navigation and the menu trigger;
MobileMenu's script defines Escape handling, aria-expanded toggling, focus restore, `inert`
application (not manual tabindex bookkeeping), Tab-cycling focus constraint, and a body-scroll-lock
class, and does not wait on a `transitionend` listener; Breadcrumbs use `<ol>` and
`aria-label="Breadcrumb"` with the current page as a non-link; all 24 route files exist and use
`Page`; every route defines exactly one `<h1>`; no route contains lorem ipsum, a hard-coded
`veyora.design`/`veyora.com`, or a storefront import; no component or route introduces a non-zero
`border-radius` or an `--accent` token; and an HTTP-level suite that builds once, starts the
standalone server directly, and requests nine representative routes (see below).

One false-positive round was caught and fixed during this batch: three initial test assertions
(`Header`/`Footer` "no storefront reference", MobileMenu "no transitionend") matched the word
appearing in explanatory source *comments* that describe what was deliberately *not* done, not
actual code. Narrowed each to check for a real `import ... from '...storefront...'` or a real
`addEventListener('transitionend', ...)` — both now correctly assert on code, not prose.

### Build result

`astro build` (production mode, explicit `PUBLIC_SITE_ORIGIN=http://127.0.0.1:4321` /
`PORTAL_ORIGIN=http://127.0.0.1:4322`) completed successfully across all 25 routes.

### Representative HTTP route result

Started the built server via the validated `npm run start` and requested the nine routes named in
the task brief:

| Route | Status | `<h1>` count | Header | Footer |
|---|---|---|---|---|
| `/` | 200 | 1 | present | present |
| `/why-veyora/` | 200 | 1 | present | present |
| `/brands/` | 200 | 1 | present | present |
| `/brands/example-brand/` | 200 | 1 | present | present |
| `/collections/` | 200 | 1 | present | present |
| `/collections/example-brand/example-model/` | 200 | 1 | present | present |
| `/contact/` | 200 | 1 | present | present |
| `/privacy-policy/` | 200 | 1 | present | present |
| `/sitemap/` | 200 | 1 | present | present |

All nine (and, separately, all 24 route files during earlier validation) returned real HTML via
direct path request — no hash routing, no client-side router. Breadcrumbs render the correct trail
(verified on `/collections/optical/`: Home › Collections › Optical) and are correctly omitted on
`/`. `/brands/example-brand/` correctly humanises the slug to "Example Brand" with no data lookup.
Server stopped cleanly after each check (direct `node ./dist/server/entry.mjs`, not through the
`npm`/shell wrapper — see "Known limitations").

### Accessibility behaviours implemented but NOT browser-verified

Playwright is out of scope for B1.2. The following are implemented and asserted at the *source*
level (the script defines the behaviour) but not exercised in a real browser:

- Escape closing the mobile menu
- Focus moving into the panel on open and returning to the trigger (or the true previously-focused
  element) on close
- Tab/Shift+Tab cycling staying inside the panel while open
- `inert` actually removing the rest of the page from the tab order and accessibility tree across
  target browsers
- Visual presentation of the ivory overlay, serif heading, and uppercase link treatment
- Real touch and on-device keyboard behaviour

A manual/Playwright pass against these is deferred to whenever browser tooling is introduced,
consistent with the low-storage constraint on this batch.

### Dynamic-route temporary behaviour

`/brands/{brand}/`, `/collections/{brand}/{model}/`, and `/resources/{slug}/` (standing in for both
`/resources/{category}/` and `/resources/{slug}/`) render the same neutral skeleton for **any**
slug value, including ones that would not exist as a published record — there is no data source to
check against until B2 (schema) and B4 (public API surface, model/brand pages). Real publication
lookups and unknown-slug 404 behaviour are explicitly deferred to B2/B4, as instructed. The
resources category/article file-sharing is a routing-topology consequence of the specification
itself (two dynamic siblings at one path depth), not a data limitation — see "Route files" above.

### Known limitations

- **A real Vite/Astro build-time regression was found and fixed in this batch.** B1.1A's
  `astro.config.mjs` imported `resolveEnv` from `src/env.ts` as "defense in depth." Testing this
  batch's first real page revealed that `astro build` runs its config through Vite, which forces
  `process.env.NODE_ENV = 'production'` while evaluating that config — regardless of the invoking
  shell's real value — and merely *importing* `src/env.ts` (for any export) runs its top-level
  `export const env = resolveEnv(process.env)`, which then threw on every plain local build with no
  origins set. Fixed by removing the `src/env.ts` import from `astro.config.mjs` entirely and
  inlining the same documented localhost default as a literal. `scripts/validate-env.mjs` (a plain,
  separate `node` process, unaffected by Vite) remains the real, correctly-behaving fail-closed
  gate — confirmed unaffected by rerunning the full B1.1A build/startup command-path tests, all
  still green. `nav.ts`'s own import of `{ env }` is unaffected by this issue: page-level modules
  are bundled, not executed, during `astro build` for `output: 'server'` — confirmed empirically by
  the full 25-route build succeeding with no origins set.
- No full metadata framework exists yet: every route currently carries one blanket
  `<meta name="robots" content="noindex, follow">` in `Base.astro` as a safety default while pages
  are placeholders, not the real per-route `indexing.ts` policy (canonical, OG/Twitter, query-state
  handling) — that is B1's WP-04.
- No custom 404/500 pages, redirect middleware, or legacy hash bridge exist yet (WP-04/WP-05).
- Every route is server-rendered (no `prerender = true` anywhere), including ones the route matrix
  ultimately marks as prerendered — deliberate simplification since no content source exists yet
  to justify the split; revisit when B2's data model lands.
- The resources category/article routing simplification above.
- Mobile-menu accessibility behaviours not browser-verified (above).
- `docker-compose.override.web.yml` (local dev compose profile) still not created — unchanged from
  B1.1.

### Deferred to B1.3

Full metadata framework and canonical builder, `indexing.ts`, real 404/500 pages, redirect
middleware, the legacy hash bridge, and — per the stop conditions — anything requiring database
migrations, the `/public/*` API surface, catalogue functionality, forms, CRM, sitemaps (XML),
structured data (JSON-LD; the breadcrumb data structure is ready for it), or production deployment.

### Free space on C:

| Checkpoint | Free space |
|---|---|
| Before B1.2 (Task 1) | 8.04 GB |
| After full test suite (107/107) | 8.00 GB |
| Final | 8.003 GB |

Never approached the 4 GB floor. No new dependency was installed in this batch — zero new
packages, matching the "prefer zero new dependencies" instruction.

### Confirmation

`platform/server/storefront/**`, `platform/server/api/**`, `platform/server/db/**`, the root admin
application, `docker-compose.yml`, `Caddyfile`, `deploy.sh`, every package outside
`platform/server/web`, and every existing API test are untouched — confirmed by `git status
--short` showing changes confined to `platform/server/web/**` and this one document. The other
developer's concurrent storefront branch was never inspected, referenced, or merged — this session
worked exclusively from `mathew/public-website-rebuild` at commit `6cc73e0` forward, and the only
storefront interaction of any kind was copying (not moving or modifying) two static SVG logo files
already present on disk. No commit was made, nothing was pushed, no deploy or production/VPS/DNS
access occurred.
