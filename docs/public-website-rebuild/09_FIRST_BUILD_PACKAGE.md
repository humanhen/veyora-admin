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

---

## 11. B1.3 implementation result and B1 exit review — 2026-08-05

**Scope executed:** central route metadata, canonical generation, the indexing-policy authority,
real 404/500 pages, static legacy-path redirects, trailing-slash normalisation, and the corrected
legacy portal hash bridge (relocated from the 404-only page to the shared `Base.astro` layout).
Starting commit `5180718` (completed B1.2) on `mathew/public-website-rebuild`. Per the task brief,
the other developer's concurrent storefront branch was never inspected, referenced or merged.

### Files created

```
platform/server/web/src/
├── lib/
│   ├── metadata.ts             central registry — 21 static entries + 3 dynamic builders (25 routes)
│   ├── indexing.ts             THE indexing authority — resolveIndexing(), NOT_FOUND/SERVER_ERROR robots
│   ├── seo.ts                  buildSeoHead() — title/description/canonical/OG/Twitter
│   ├── redirects.ts            resolveRedirect() — known legacy paths + trailing-slash normalisation
│   └── legacy-hash-bridge.ts   resolveLegacyHashRedirect() — the allowlist decision function
├── middleware.ts                thin Astro wrapper around resolveRedirect()
└── pages/
    ├── 404.astro                 real 404, NOT_FOUND_METADATA, NOT_FOUND_ROBOTS
    └── 500.astro                 real 500, SERVER_ERROR_METADATA, SERVER_ERROR_ROBOTS

platform/server/web/test/
├── metadata.test.ts
├── indexing.test.ts
├── seo.test.ts
├── redirects.test.ts
├── legacy-hash-bridge.test.ts
├── error-pages.test.ts
└── route-contract.test.ts
```

### Files modified

- `astro.config.mjs` — two changes. Added a Dockerfile-note-worthy build-time comment fix (none
  needed here) and **removed `trailingSlash: 'always'`**, added in B1.2 with trailing-slash
  redirection itself deferred to "B1's WP-05, not yet built." Now that WP-05 exists
  (`middleware.ts` + `redirects.ts`), the config-level setting turned out to be actively harmful —
  see "Known limitations" below.
- `package.json` — added `--test-concurrency=1` to the `test` script.
- `src/layouts/Base.astro` — now renders the full SEO head (title, description, robots, canonical,
  OG, Twitter) from a `seo: SeoHead` prop instead of `title`/`description` strings, and loads the
  legacy hash-bridge script plus a `<meta name="portal-origin">` tag.
- `src/layouts/Page.astro` — now accepts `meta: RouteMetadata` (plus optional `fixedRobots` for the
  error pages), calls `buildSeoHead()` itself, and renders the page's one `<h1>` from `meta.h1`
  directly — no route file writes its own `<h1>` any more.
- All 24 route page files — updated to pass `meta={...}` (a `STATIC_ROUTE_METADATA` entry or a
  dynamic builder call) instead of a literal `title` string, and no longer contain their own
  `<h1>` literal.
- `test/routes.test.ts` (B1.2) — the "exactly one H1 per file" assertion was rewritten: since B1.3
  moved `<h1>` rendering into `Page.astro`, the stronger, correct check is now that `Page.astro`
  itself renders exactly one `<h1>` (structurally impossible to duplicate or omit per route) and
  that every route file supplies a `meta` prop. The category-landing label assertion was similarly
  updated to check the page file references the correct metadata key, with the actual text
  verified in the new `metadata.test.ts`. Neither change weakens the original requirement; both
  adapt the check to how B1.3 now satisfies it. No other B1.1/B1.2 test file needed changes.
- `test/http-routes.test.ts` (B1.2) — extended with metadata/canonical/robots assertions on the
  existing representative routes, plus new cases: the three `/collections/` query-state variants,
  `/healthz`, an unknown path, `/500/`, the four static redirects, trailing-slash normalisation,
  and the legacy bridge's presence on `/`.

### Metadata implementation

`src/lib/metadata.ts` is the single central registry. 21 fully static routes are plain records
keyed by path; the 3 dynamic routes (`/brands/{brand}/`, `/collections/{brand}/{model}/`,
`/resources/{slug}/`) are builder functions that safely interpolate a humanised slug into title, H1
and description — never a lookup, never an invented fact, and (after a bug caught by testing) never
a fixed generic string that would collide across two different real slugs. Every field the B1.3
brief required is present: route/pattern, title, description, H1, indexing category (a descriptive
label — `home`, `catalogue-index`, `policy`, etc. — informational; the actual robots/canonical
computation in `indexing.ts` is uniform across all categories, deliberately, since the query-state
rules apply the same way regardless of route type), breadcrumb label, `sitemapEligible` (structural
intent, true for all 25), and `pendingContent`. Titles/H1s are the specification's own documented
text (05_ROUTE_TEMPLATE_MATRIX.md §3) for the 9 routes it supplies them for; every other route
(three category landings, all six policy routes, the enquiry route, the HTML sitemap, and all
dynamic routes) uses a neutral structural label and is marked `pendingContent: true`.
`/global-presence/`'s title is the specification's own text but is *also* marked pending, since it
carries a country list the specification itself flags as unresolved (DECISION-12).

### Indexing states

`src/lib/indexing.ts`'s `resolveIndexing()` implements all five states from
`05_ROUTE_TEMPLATE_MATRIX.md` §2/§9 exactly, plus a documented precedence rule for combinations the
specification only names in isolation: **filter > sort > page > clean**. An explicit
`SUPPORTED_FILTER_PARAMS` allowlist (`brand`, `shape`, `material`, `gender`, `size`, `lens_type`)
means an unrecognised query parameter — including `utm_*`, `gclid`, `fbclid` — never triggers
filter behaviour, never enters a canonical URL, and never makes a clean page noindex, satisfying
the brief's explicit requirement. `/search/`, 404 and 500 are handled as fixed cases outside the
query-state logic. Verified live against the running server (see below) across all 6 combinations
tested plus every isolated state.

### 404 result

`src/pages/404.astro` sets `Astro.response.status = 404` explicitly, uses `Page.astro` (real
header/footer/navigation, links to Brands/Collections/Contact), carries `NOT_FOUND_METADATA` and
the fixed `NOT_FOUND_ROBOTS` (`noindex, follow`), and has no API or database dependency. Verified
live: an unknown path returns real `404` status with exactly one H1 and the three required links,
not a 200 skeleton or the homepage. The B1.2 dynamic-route limitation is unchanged and documented
again here: `/brands/{brand}/`, `/collections/{brand}/{model}/` and `/resources/{slug}/` still
accept **any** slug and return 200, because no data source exists yet to know a slug is unpublished
or nonexistent — this file only covers paths matching no route at all. Real unpublished/unknown-
entity 404 behaviour remains B2/B4/B5 work.

### 500 implementation and test limitation

`src/pages/500.astro` sets `Astro.response.status = 500` explicitly, carries
`SERVER_ERROR_METADATA` and the fixed `SERVER_ERROR_ROBOTS` (`noindex, nofollow`), has no API,
database or catalogue dependency, and offers a reload suggestion plus Home/Contact links — no stack
trace, error object, or secret-shaped content anywhere in the file (asserted in
`error-pages.test.ts`). **Validation approach and its limitation:** rather than fabricating a
public test-only route to force a real server error, this page is directly reachable at `/500/`
and — because it explicitly sets its own status — genuinely, deterministically returns HTTP 500
when requested there, with no mock or hack involved. `test/http-routes.test.ts` requests `/500/`
directly against the real running server and asserts on the real response. What this does **not**
prove is Astro's own automatic dispatch to this file when *another* route throws an unhandled
error during rendering — that specific trigger path was not exercised, since deliberately breaking
another route to observe the fallback would itself be the kind of fragile, non-reliable test the
brief asked to avoid. The page's correctness when reached (status, headers, content, no
dependencies) is fully verified; the framework's own error-dispatch wiring to it is not.

### Redirects

`src/lib/redirects.ts`'s `resolveRedirect()` implements exactly the four specification-named legacy
paths (`/about-us/` → `/why-veyora/`, `/contact-us/` → `/contact/`, `/shop/` → `/collections/`,
`/index.php` → `/`) plus trailing-slash normalisation for public HTML routes, both as pure,
unit-tested logic wrapped by a thin `src/middleware.ts`. `/healthz` and static assets (by extension
allowlist) are explicitly excluded and never redirected; every redirect destination is a fixed
internal path, so the function cannot become an open redirect by construction; every known-path
destination was verified (by test and live request) to resolve in exactly one hop. **Canonical-host
enforcement was explicitly optional in the brief ("may be prepared") and was deliberately not
implemented** — this application is validated exclusively against localhost/127.0.0.1 origins, and
a host-enforcing redirect risks breaking that validation the moment a request's Host header and the
configured origin's hostname differ for an entirely benign reason. Left for Caddy (B10) or a later,
carefully-tested batch. Database-backed redirects and product-slug mappings are explicitly B7/B2
and were not started.

### Legacy bridge correction

Recorded in full in `04_TARGET_ARCHITECTURE.md` §11, `05_ROUTE_TEMPLATE_MATRIX.md` §10 and
`08_RISKS_AND_OPEN_DECISIONS.md` §7 (all dated corrections, original text retained). Summary: the
original plan placed the bridge on the 404 page only, which cannot work because a fragment
(`#/login`) is never transmitted to the server, and `/` — where root-level legacy links land — is a
real 200 route, not 404. The bridge (`src/lib/legacy-hash-bridge.ts`, a pure allowlist-matching
function, plus a bundled script in `src/layouts/Base.astro`) now loads on every one of the 25
routes. Security properties, verified by `test/legacy-hash-bridge.test.ts` (17 tests): every one of
the 16 allowed prefixes redirects with the fragment preserved verbatim, including a deeper
token/slug (`#/set-password/<token>`) and a trailing empty segment (`#/list/`); an unknown prefix,
an empty prefix, and a hash not starting with `#/` all perform no redirect; protocol-relative
injection (`#//evil.example`) and absolute-URL injection (`#/http://evil.example`,
`#/https://evil.example/login`) perform no redirect; mixed-case (`#/LOGIN`) and percent-encoded
(`#/%6c%6fgin`) bypass attempts are rejected because matching is strict, case-sensitive and never
decodes anything; every non-null result begins with exactly the configured `PORTAL_ORIGIN`; no
redirect occurs when `PORTAL_ORIGIN` is absent. Verified live: the bridge's compiled logic and the
`<meta name="portal-origin">` tag are present in the served HTML of `/`.

### Test counts

`platform/server/web`: **221/221 tests passing** (`node --test`) — 107 carried over from B1.1/
B1.1A/B1.2 (all still green, confirming no regression), 114 new in B1.3. One real, general-purpose
bug was found and fixed while getting to green: `package.json`'s `test` script now runs with
`--test-concurrency=1`, because two test files (`command-paths.test.ts` from B1.1A and
`http-routes.test.ts`) each run a real `npm run build` against the same shared `dist/` output, and
Node's test runner executes separate test *files* concurrently by default — the two builds raced,
one corrupting the other's content-hashed Vite chunk output. Sequential file execution eliminates
this and any similar future cross-file resource collision, at the cost of a somewhat longer total
run.

### Build result

`astro build` (production mode, explicit `PUBLIC_SITE_ORIGIN=http://127.0.0.1:4321` /
`PORTAL_ORIGIN=http://127.0.0.1:4322`) completed successfully across all 25 routes plus 404/500.

### Representative HTTP results

Verified against the running standalone server (`npm run start`, direct `node
./dist/server/entry.mjs`, no shell wrapper):

| Check | Result |
|---|---|
| `/`, `/why-veyora/`, `/brands/`, `/brands/example-brand/`, `/collections/`, `/collections/example-brand/example-model/`, `/contact/`, `/privacy-policy/`, `/sitemap/` | all 200, one H1, correct title/description/canonical, `robots: index, follow` |
| `/collections/?page=2` | 200, `index, follow`, canonical `…/collections/?page=2` |
| `/collections/?brand=example` | 200, `noindex, follow`, canonical `…/collections/` |
| `/collections/?sort=name` | 200, `noindex, follow`, canonical `…/collections/` |
| `/healthz` | 200, `application/json`, `X-Robots-Tag: noindex, nofollow` — unaffected by the new middleware |
| unknown path | 404, one H1, `noindex, follow`, links to Brands/Collections/Contact |
| `/500/` | 500, one H1, `noindex, nofollow` |
| `/about-us/`, `/contact-us/`, `/shop/`, `/index.php` | 301 to their documented targets, resolved in one hop |
| `/collections` (no slash) | 301 → `/collections/`, resolved in one hop |
| `/logo-black.svg` | 200, never redirected |
| legacy hash bridge | `<meta name="portal-origin">` and the compiled bridge logic present in `/`'s served HTML |

Server stopped cleanly after every check; no orphaned process confirmed via `tasklist`/`netstat`
after each run.

### Known limitations

- **A real regression was found and fixed mid-batch:** B1.2's `astro.config.mjs` set
  `trailingSlash: 'always'`. Once B1.3's middleware existed, this caused Astro's own routing to
  *also* enforce a trailing slash on every route — including `/healthz`, which must never redirect.
  Caught by direct testing (`curl` returned `301 Location: /healthz/`), fixed by removing the
  config setting entirely now that `redirects.ts` is the single place trailing-slash normalisation
  happens.
- Canonical-host enforcement (redirecting a non-canonical host to `PUBLIC_SITE_ORIGIN`) was
  explicitly optional and is not implemented — see "Redirects" above.
- The 500 page's correctness is fully verified directly; Astro's automatic dispatch to it from a
  genuine unhandled error in another route is not exercised by an automated test — see "500
  implementation and test limitation" above.
- Dynamic placeholder routes still accept any slug and return 200 (unchanged B1.2 limitation,
  documented again here and in `404.astro`'s own comments).
- `indexingCategory` on each metadata record is descriptive/informational only; `indexing.ts`'s
  actual query-state rules are applied uniformly regardless of category, by design — see "Metadata
  implementation" above.
- JSON-LD is not implemented; `Base.astro`'s `structured-data` slot exists for B7 to fill.
- No sitemap XML, robots.txt generation, or IndexNow — B7, unchanged.

### Deferred to B2 and later

Database migrations, the `/public/*` API surface, catalogue data, forms, CRM, sitemaps (XML),
robots.txt generation, JSON-LD content (the slot and the breadcrumb data structure are ready for
it), analytics, image processing, real content templates, production Caddy/deployment changes,
canonical-host enforcement, database-backed redirects, product-slug mapping redirects, and real
unpublished/unknown-entity 404 behaviour for the three dynamic routes — all unchanged from
`07_IMPLEMENTATION_PLAN.md` and explicitly out of scope per the B1.3 task brief.

### Final storage

| Checkpoint | Free space |
|---|---|
| Before B1.3 (Task 1) | 7.889 GB |
| After full test suite (221/221) | 7.892 GB |
| Final | 7.89 GB |

Never approached the 4 GB floor. No new dependency was installed in this batch.

### Confirmation: B1 is complete

B1 now provides everything named in the B1.3 task brief's final review: the Astro server
application, the fail-closed environment contract, the health endpoint, the editorial token/base
layer, shared layouts, navigation, mobile menu, footer, breadcrumbs, 25 route skeletons, central
metadata, the indexing authority, a real 404, a safe 500 page, static legacy redirects, legacy
portal hash continuity (corrected to its right location), and route-contract tests. Everything
explicitly out of scope for B1 (database migrations, the public API, catalogue data, forms/CRM,
sitemaps, robots.txt, JSON-LD content, analytics, image processing, real content templates, and
production deployment) remains out of scope and is deferred to B2 onward, as planned.

### Confirmation: protected systems untouched

`platform/server/storefront/**`, `platform/server/api/**`, `platform/server/db/**`, the root admin
application, `docker-compose.yml`, `Caddyfile`, `deploy.sh`, every package outside
`platform/server/web`, and every existing API test are untouched — confirmed by `git status
--short` showing changes confined to `platform/server/web/**` and the four permitted documentation
files. The other developer's concurrent storefront branch was never inspected, referenced or
merged. No commit was made, nothing was pushed, and no deploy, VPS, production or DNS access
occurred at any point in this session.

---

## 12. B2.1 implementation result — 2026-08-05

**Scope executed:** the additive public-content database schema and publication-governance
foundation only — no `/public/*` API route, serializer, catalogue endpoint, live data backfill,
admin UI, or Astro catalogue integration. Starting commit `f55539d` (completed B1) on
`mathew/public-website-rebuild`. The other developer's concurrent storefront-fix branch was not
inspected, merged, copied or modified.

### Files created

```
platform/server/db/migrations/0007_public_site.sql   the additive migration (fresh-volume path)
docs/public-website-rebuild/14_B2_SCHEMA_REFERENCE.md  full field-by-field schema reference
platform/server/api/test/public-schema.test.js         65 new structural/semantic tests
```

### Files modified

- `platform/server/api/src/migrate.js` — `ensureSchema()` extended with the exact same statements
  as `0007_public_site.sql`, mirrored idempotently. This is the **only** source-code change in this
  batch, and it is directly justified by the repository's own existing migration lifecycle (see
  below) — not a new API surface, endpoint, or behaviour change of any kind.
- `docs/public-website-rebuild/04_TARGET_ARCHITECTURE.md` — §12 appended.
- `docs/public-website-rebuild/07_IMPLEMENTATION_PLAN.md` — §10 appended.
- `08_RISKS_AND_OPEN_DECISIONS.md` — **not modified.** Reviewed against this batch's actual
  changes; no documented risk score changed and no open decision was resolved by pure additive
  schema work (the risks and decisions that will eventually be affected — R-03 shape backfill,
  R-06 public data leak, DECISION-03 brand list — are all still exactly where B1 left them, since
  none of their actual triggering work — backfill, the serializer, brand-count derivation — was
  done in this batch).

No other path was created, modified or deleted.

### Existing migration lifecycle discovered (Task 2)

Read `0001`–`0006` and every line of `api/src/migrate.js` before writing anything. Confirmed: files
in `db/migrations/` run exactly once, via PostgreSQL's `docker-entrypoint-initdb.d` mechanism,
against a completely fresh data volume — `deploy.sh` ships the `db/` directory unchanged on every
deploy, but an already-initialised database's data volume is never re-triggered by it. The real
incremental mechanism, used for every schema change since go-live (`0005`, `0006`, the multi-
currency dimension, the inventory ledger), is `ensureSchema()` in `migrate.js`, called from
`startServer()` on every API boot before the server accepts traffic (fail-closed — if it throws,
the API does not start). There is no ORM and no migration-runner tool anywhere in this repository.
`0007_public_site.sql` and its `migrate.js` mirror follow this exact, pre-existing convention.

### Tables and fields implemented

Nine new tables (`brands`, `locations`, `policies`, `media`, `redirects`, `content_pages`, `forms`,
`form_submissions`, `content_approvals`), the governance lifecycle
(`publication_state`/`source_reference`/`fact_owner`/`verification_status`/`last_reviewed_at`/
`scheduled_review_at`/`content_updated_at`) applied to `brands`/`locations`/`policies`/
`content_pages` and to `products`, 11 additive `products` columns (`public_slug`, `brand_id`,
`line`, `shape`, `segment`, `public_description`, `is_published`, `is_featured`,
`is_discontinued`, `replacement_product_id`, plus governance), and 3 additive `variations` columns
(`color_code`, `swatch_media_id`, `is_published`). Full field-by-field reference:
`14_B2_SCHEMA_REFERENCE.md`.

### Tests and validation

**566/566** API tests passing (`node --test`): 501 pre-existing (zero regressions) + 65 new. No
PostgreSQL executable was available on this machine and none was installed, per the task brief
(checked: no `psql`/`postgres` on `PATH`, no `C:\Program Files\PostgreSQL`) — so validation is
static/semantic (both SQL files read as text and asserted on structurally), not executable-database
validation. Full limitation note: `14_B2_SCHEMA_REFERENCE.md` §9.

### Production migration mechanism / gap

Mechanism, if ever shipped: unchanged from the existing convention — `deploy.sh` ships `db/`
unchanged and restarts the `api` container, which runs the now-extended `ensureSchema()` before
serving traffic. Gap: no migration was applied to any database, no PostgreSQL instance was
contacted, and no production/VPS/DNS access occurred at any point in this session, per the task
brief. Actually shipping this schema to production is explicitly left to B10 or a separately
reviewed migration runbook.

### Known limitations

- No executable database validation (above) — the single largest limitation of this batch.
- The `is_published`/`publication_state` cross-row invariant for `variations` (a variation should
  not publish while its parent product is unpublished) is not a database constraint — deferred to
  the B2.2/B2.4 application-level publication gate (`14_B2_SCHEMA_REFERENCE.md` §6).
- The slug-change redirect triggers silently skip (rather than overwrite) when a redirect already
  exists at the target path; nothing yet alerts a human to that collision.
- `products.public_slug`/`brand_id` backfill for the 1,318 existing products was explicitly not
  attempted — remains separate B2.4 work.

### Deferred to B2.2–B2.4

The `/public/*` API surface and allowlist serializer (WP-07), slug generation and backfill scripts
plus the data-quality report (WP-08), admin editing surfaces for brand/location/policy/publication
(WP-09), the forbidden-key test suite, the application-level publication gate (approval-required-
before-publish, the variation/product visibility cross-check), and shape-facet backfill — all
unchanged from `07_IMPLEMENTATION_PLAN.md`.

### Final storage

| Checkpoint | Free space |
|---|---|
| Before B2.1 (Task 1) | 7.887 GB |
| After full API test suite (566/566) | 7.863 GB |
| Final | 7.863 GB |

Never approached the 4 GB floor. No new dependency was installed.

### Confirmation

No migration was applied to any database — no PostgreSQL executable was available or installed,
and none was contacted. `platform/server/storefront/**`, `platform/server/web/**`, the root admin
application, `docker-compose.yml`, `Caddyfile`, `deploy.sh`, all `.env` files, and every existing
API test file are unchanged — confirmed by `git status --short` showing changes confined to
`platform/server/db/migrations/**`, one file under `platform/server/api/src/**`,
`platform/server/api/test/**`, and the permitted documentation files. The other developer's
concurrent branch was never inspected, referenced or merged. No commit was made, nothing was
pushed, and no deploy, VPS, production or DNS access occurred at any point in this session.

---

## 13. B2.2 implementation result — 2026-08-05

**Scope executed:** the unauthenticated, read-only public API boundary — one `/public` router, one
pure allowlist serializer layer, one forbidden-key authority, a bounded ~60s read cache, strict
query validation, and comprehensive boundary tests. Starting commit `343421e` (completed B2.1).

**Session note:** this batch spanned two sessions. The first completed Tasks 1–10 and stopped at a
usage-limit checkpoint, recording state in `16_B2_2_SESSION_HANDOFF.md`; the second verified that
handoff against the working tree, formally closed validation, and wrote this documentation. No work
was reimplemented, and the working tree was confirmed to match the handoff exactly (same branch,
same HEAD `343421e`, same eleven files, clean `git diff --check`, all files syntactically complete
with no merge markers or TODO/FIXME).

### Files created

```
platform/server/api/src/public-forbidden-keys.js   forbidden-key authority + recursive scanner
platform/server/api/src/public-serialize.js         8 pure allowlist serializers
platform/server/api/src/public-cache.js             bounded ~60s in-process read cache
platform/server/api/src/routes/public.js            the /public router — 7 GET endpoints
platform/server/api/test/public-serialize.test.js      15 tests
platform/server/api/test/public-forbidden-keys.test.js   9 tests
platform/server/api/test/public-cache.test.js            9 tests
platform/server/api/test/public-router.test.js          35 tests
docs/public-website-rebuild/15_B2_PUBLIC_API_CONTRACT.md   full endpoint contract
docs/public-website-rebuild/16_B2_2_SESSION_HANDOFF.md     mid-batch handoff (retained as history)
```

### Files modified

`platform/server/api/src/index.js` — **the only pre-existing tracked file touched**: one import and
one `app.use('/public', publicRoutes)` mount (after `/admin`, before the terminal 404 handler).
Purely additive; no existing route, handler, response shape or authentication path changed. Plus
this document and `04`/`07`/`08` (documentation).

### Endpoints implemented

`GET /public/brands`, `/public/brands/:slug`, `/public/models`, `/public/models/:brand/:slug`,
`/public/facets`, `/public/locations`, `/public/sitemap-data` — all GET-only, all unauthenticated,
all read-only. Verified at runtime: the router registers **zero** non-GET methods and **zero**
non-route middleware layers (i.e. no auth middleware was added anywhere), and contains no
`insert`/`update`/`delete from`/`drop`/`truncate`/`alter` SQL of any kind.

### Serializer architecture

Eight pure functions in `public-serialize.js`, each returning a **fresh object literal** built from
named fields. It never spreads a database row (`{ ...row }` appears nowhere — enforced by test),
never returns a row unchanged, and never attaches a jsonb blob wholesale: `best_for` and
`component_origins` are validated into arrays of short strings (objects, nested arrays, non-strings
and over-long values are dropped), and only a validated `lensType` string is extracted from the
existing `products.attributes` bag. Internal `label:*` tags are stripped in the one place a
category array reaches public output. No internal database id is exposed anywhere — every response
identifies records by slug.

### Forbidden-key scanner

`public-forbidden-keys.js` — a normalised (lowercased, separators stripped) **exact-match** key set
plus `scanForForbiddenKeys()`, which walks objects and arrays recursively and reports the exact
dotted/bracketed path of every violation, plus an `isForbiddenLabelValue()` check for `label:*`
values. Exact-match rather than substring is deliberate: a naive `.includes()` rule would flag
harmless public fields such as `isDiscontinued`, `sortOrder` and `orderIndex`, which is the exact
false-positive trap the B2.2 brief called out. Used throughout the tests and importable for any
future dev-mode assertion; it is **not** a production response filter and never runs at request
time — the serializer's allowlist is the actual boundary.

### SQL and publication boundary

Every query lists its columns explicitly (no `select *`, no `p.*`), is fully parameterised, and
carries an explicit publication filter: `publication_state = 'published'` for brands/locations/
content pages, `products.is_published = true` and `variations.is_published = true` for catalogue
records, and `locations.is_public = true` in addition to publication state. `is_active` appears
**nowhere** in the public boundary — it is the portal's ordering flag, never the publication
authority. The router imports no pricing, ordering, cart, auth, account, agent, admin or inventory
module, and queries no `users`/`orders`/`order_items`/`invoices`/`payments`/`credit_notes` table.

The single SQL interpolation is `${MODEL_SORTS[sort]}`, reached only after `sort` passes an
allowlist check against a fixed two-key object. Verified at runtime that `__proto__`, `constructor`,
`toString`, `hasOwnProperty` and `newest; drop table products--` are each rejected with a 400
**before any query is issued**, and that no `drop table` text ever reaches the SQL.

### Cache design

`public-cache.js`: in-process `Map`, ~60s TTL, bounded at 500 entries with oldest-first eviction.
Keys are the endpoint name plus every query parameter, sorted and normalised, so `?brand=a&shape=b`
and `?shape=b&brand=a` share one entry — and **no user or session identity is ever part of a key**,
because this router has no identity to key on. Caches only successful reads of the collection,
facet, location and sitemap endpoints. Validation errors (400), 404s and server errors are never
cached — tested explicitly, including that a transient database failure is retried rather than
remembered, and that a `400` fails before any query runs. `invalidatePublicCache()` is exported and
tested but deliberately wired to nothing (see deferrals).

### Validation and test result

**634/634 API tests passing** (566 pre-existing + 68 new), zero regressions — the exact baseline the
handoff recorded, re-run and re-confirmed in the resuming session. `git diff --check` clean. A
targeted grep sweep across the B2.2 source found no `select *`, no table-star selection, no row
spreading, no forbidden table access, no write-verb route registration, no hard-coded production
hostname, no secret, no merge marker and no TODO/FIXME. (Two `.delete(` hits in `public-cache.js`
are `Map.prototype.delete` for TTL and bounded-size eviction, not HTTP handlers; write-verb strings
in the test files are negative assertions and comments.)

### Known limitations

- **No live database was contacted** — every test uses an injected fake `db` object or a
  monkey-patched `pool.query` restored after each test. The SQL has been carefully reviewed but not
  executed against a real PostgreSQL instance (no executable available, none installed per the
  low-storage rules).
- **No data exists to exercise these endpoints against.** B2.1 left every new table empty and every
  existing product `is_published = false`; B2.2 published nothing. Every example in
  `15_B2_PUBLIC_API_CONTRACT.md` is a fixture, not a live response.
- **`audience` and `material` query parameters are accepted and validated but are currently
  no-ops** — no backing column exists in the B2.1 schema. Accepted now for forward compatibility
  with the route matrix's documented facet set.
- **`locations.address`, `.contact` and `.coordinates` are never returned** — the schema has only a
  row-level publication signal, with no per-field marker confirming an address or contact block was
  individually reviewed for public disclosure.
- **Single-record endpoints are not cached** (`/brands/:slug`, `/models/:brand/:slug`) — a
  deliberate simplification, trivially addable later with the same cache mechanism.
- **The forbidden-key scan covers serializer output and endpoint fixtures, not rendered HTML or
  JSON-LD** — extending it across those surfaces is B9 crawl/QA work.

### Deferred to B2.3 / B2.4

**B2.3:** Astro-side consumption of these endpoints (typed client, page integration, the catalogue
and brand templates that call them). **B2.4:** product `public_slug`/`brand_id` backfill and slug
generation (WP-08), admin editing surfaces for brand/location/policy/publication (WP-09), the
application-level publication gate (approval-required-before-publish; the variation/product
visibility cross-check), and wiring `invalidatePublicCache()` to admin publish/unpublish actions and
the Zoho sync — none of which could be done in B2.2 without modifying admin/Zoho modules the brief
placed out of scope.

### Final storage

| Checkpoint | Free space |
|---|---|
| B2.1 end (best available prior reference) | 7.859 GB |
| Mid-batch handoff checkpoint | 7.831 GB |
| After full suite + validation (resuming session) | 8.374 GB |

Never approached the 4 GB floor. No new dependency was installed in this batch — zero, as the brief
required.

### Confirmation

No live database, production system, VPS or DNS was contacted at any point in either session.
`platform/server/storefront/**`, `platform/server/web/**`, `platform/server/db/**`, the root admin
application, `docker-compose.yml`, `Caddyfile`, `deploy.sh`, all `.env` files, every existing API
test, and every authenticated `/user` route shape are unchanged — confirmed by `git status --short`
showing changes confined to `platform/server/api/src/**`, `platform/server/api/test/**` and
`docs/public-website-rebuild/**`. The other developer's concurrent branch was never inspected,
referenced or merged. No commit was made and nothing was pushed.

---

## 14. B2.3 implementation result — 2026-08-06

**Scope executed:** the Astro public website now consumes the read-only `/public/*` API
server-side. Starting commit `4fa3f7c` (completed B2.2). No backfill, no publication of any
record, no admin editing, no forms/CRM, no pricing, no stock/availability, no JSON-LD, no XML
sitemap, no asset ingestion, no deployment.

### Files created

```
platform/server/web/src/lib/
├── public-types.ts        types + hand-written runtime validation for every consumed response
├── public-api.ts          server-only client: 7 allowlisted endpoint functions
├── catalogue-query.ts     local query allowlist, bounds and pagination-href building
└── catalogue-page.ts      shared catalogue loader (a function, not a component — see below)

platform/server/web/src/components/public/
├── BrandSummary.astro          PublicImage.astro         Pagination.astro
├── ModelCard.astro             ModelGrid.astro           NotFound.astro
├── CatalogueListing.astro      EmptyPublishedContent.astro
└── PublicDataUnavailable.astro

platform/server/web/test/
├── helpers/mock-public-api.ts   controlled local mock + adversarial fixtures
├── public-api.test.ts     (19)  public-types.test.ts    (22)
├── catalogue-query.test.ts (18) public-render.test.ts   (25)

docs/public-website-rebuild/17_B2_WEB_API_INTEGRATION.md
```

### Files modified

`src/env.ts` (+ `.env.example`, `README.md`) — added `PUBLIC_API_ORIGIN`; `src/lib/metadata.ts` —
added `brandDetailMetadataFromRecord()` and `modelDetailMetadataFromRecord()`; eight route files
(`/brands/`, `/brands/{brand}/`, `/collections/`, three category routes,
`/collections/{brand}/{model}/`, `/global-presence/`); four existing test files updated for the new
env contract and the skeleton→API-backed transition; four audit documents.

### Environment and client

`PUBLIC_API_ORIGIN` is server-side only, validated as an absolute http(s) origin, fail-closed in
production through the existing `validate-env.mjs` gate, with a documented localhost dev default.
It is never read through `import.meta.env` and never rendered into a page.

The client is native `fetch`, no dependency: seven allowlisted endpoint functions with **no generic
fetch-any-path escape hatch**, no function accepting an origin/host/absolute path, slugs
`encodeURIComponent`-ed into fixed templates, a 5s `AbortController` timeout, content-type checked,
body bounded at 4 MB, `credentials: 'omit'` explicit. Four outcomes — `bad-request`, `not-found`,
`unavailable`, `malformed` — map to 400/404/503/502 through one shared table.

### Validation

Hand-written validators (no schema library) build **fresh objects from named fields**, never
spreading the parsed payload, so an unknown field is dropped by construction. Wrong primitive types
are rejected rather than coerced; media paths are scheme-checked (`javascript:`, `data:`,
protocol-relative and bare relative paths are dropped); internal `label:*` tags are stripped.

### Routes integrated

`/brands/`, `/brands/{brand}/`, `/collections/`, `/collections/{optical,sun,kids}/`,
`/collections/{brand}/{model}/`, `/global-presence/`. The two dynamic routes build title,
description, H1 and breadcrumbs from the **validated API record** rather than a humanised slug —
closing the B1.2 limitation where any arbitrary slug returned 200.

### Status policy

200 success · 200 with an authoritative empty state · 400 malformed local query (**the API is never
called**) · 404 unknown/unpublished entity · 503 timeout/connection failure/5xx · 502 malformed
payload. Two properties verified end-to-end over real HTTP: **an outage never renders as an empty
catalogue**, and **an outage never becomes a false 404**. No failure page exposes the internal API
origin, an upstream status, a stack trace or SQL detail.

### Test and validation results

**310/310 web tests passing** — 221 pre-existing B1 tests all still green, plus 89 new or updated.
Production build succeeded with explicit safe localhost origins. Live HTTP verification against a
mock API confirmed for all ten representative routes: correct status, exactly one H1, correct
title/description/canonical/robots, breadcrumbs present, pagination preserving filters, category
isolation, 400 handling without an upstream call, zero hash routing, and **zero planted private
values in any rendered route**. Both servers stopped cleanly with no orphaned process.

### Two findings worth recording

1. **`Astro.response.status` set from inside a nested component has no effect.** An earlier draft
   had the shared listing component set its own status; `/brands/` (page frontmatter) returned 503
   during an outage while `/collections/` returned 200. Fixed by making the shared logic a plain
   function called from page frontmatter. Caught only because the render tests exercised the
   failure path over real HTTP.
2. **`label:*` tags survived web-side validation initially.** The API already strips them, so
   nothing would have leaked in practice — but this layer exists precisely so an upstream
   regression cannot leak, and the adversarial fixture caught it.

### Known limitations

- **No real data exists anywhere** — every table is empty and every product is unpublished, so all
  verification is against fixtures. This integration has never rendered a real Veyora record.
- `audience`/`material` are forwarded but are documented API no-ops until a backing column exists.
- `getFacets()`/`getSitemapData()` are implemented and tested but consumed by no route (B4/B7).
- No faceted filter UI — filters work by URL only.
- Single-record routes are uncached on both sides.
- **No JSON-LD**, so the forbidden-key scan still does not cover a structured-data surface, and
  **R-06 cannot close** (see `08_RISKS_AND_OPEN_DECISIONS.md`).

### Deferred to B2.4 and later

**B2.4:** slug generation and backfill (WP-08), admin editing surfaces (WP-09), the
application-level publication gate, and wiring `invalidatePublicCache()` to admin/Zoho actions.
**B4:** the `FilterPanel` island consuming `getFacets()`. **B7:** JSON-LD, XML sitemaps consuming
`getSitemapData()`, and the responsive image pipeline. **B9:** extending the forbidden-key scan
across rendered HTML and JSON-LD as a wired merge gate.

### Final storage

Started 8.731 GB free; ended 8.72 GB. Never approached the 4 GB floor. **Zero new dependencies.**

### Confirmation

No live database, real API, VPS, production system or DNS was contacted — every test runs against a
controlled mock on `127.0.0.1`. `platform/server/api/**`, `platform/server/db/**`,
`platform/server/storefront/**`, the root admin application, `docker-compose.yml`, `Caddyfile`,
`deploy.sh` and every `.env` file are unchanged. The other developer's branch was never inspected,
referenced or merged. No commit was made and nothing was pushed.

---

## 15. B2.4A implementation result — 2026-08-06

**Scope executed:** the authenticated administrative API and publication gate for public brand,
product and variation content. Starting commit `71e1ea0` (completed B2.3).

**Session note:** this batch spanned two sessions. The first reached a usage limit during read-only
inspection (Tasks 1–2) and wrote nothing; the resuming session verified the tree was clean at
`71e1ea0` with no B2.4A artifacts present, and implemented everything from Task 3 onward. No work
was duplicated.

### Files created

```
platform/server/api/src/
├── publication-gate.js            pure gate: brand/product/variation eligibility + deferred gates
├── admin-public-serialize.js      admin serializers, PATCH allowlists, concurrency tokens
└── routes/admin-public-content.js the authenticated router (17 routes) + DI-testable handlers

platform/server/api/test/
├── publication-gate.test.js          (28)
├── admin-public-serialize.test.js    (26)
├── admin-public-content.test.js      (39)
└── helpers/test-env.js               side-effect module: sets JWT_SECRET before src imports

docs/public-website-rebuild/18_B2_ADMIN_PUBLICATION_API.md
```

### Files modified

`platform/server/api/src/index.js` — **the only pre-existing file touched**: one import and one
`app.use('/admin/public-content', …)` mount, placed before the general `/admin` router so the
stricter gate runs first. Plus this document and `04`/`07`.

### Authentication convention used

The repository's existing `requireAuth('admin')` from `authmw.js`, wrapped in one named seam
(`requirePublicContentAdmin()`) applied once to the whole router. `'admin'` only — deliberately not
`ADMIN_ROLES`, which also admits `warehouse` for fulfilment work that has no business editing public
brand copy. No second authentication system; no existing check weakened.

### Endpoints

17 routes under `/admin/public-content`: 5 GET (brand list/detail, product list/detail, variation
detail), 3 PATCH, 3 evaluate, 3 publish, 3 unpublish. **No DELETE anywhere**, verified against the
live router stack.

### Publication gate

Pure functions with no database access. Shared governance rules (not retired, state published,
verified, source reference, last reviewed, content-updated date) plus per-entity rules: brand needs
a valid unique slug and an approved summary **or** headline; product needs a unique public slug,
display SKU, description, a **published** brand, coherent replacement, ≥1 publishable variation and
≥1 media item; variation needs an eligible parent and an approved colour name, with **no price,
stock or availability requirement**. Unknown inputs fail closed. Reasons are stable codes sorted
deterministically. Advisories are separate and never affect the verdict.

### Validation, concurrency, transactions

Explicit per-entity allowlists; unknown and immutable fields are `400` with field-level errors,
never silently dropped. **`is_published` is immutable via PATCH** — publication is a separate gated
operation, which is what makes the gate un-bypassable. Draft partial saves are permitted.

Optimistic concurrency uses an `entityType:id:version` token (no schema change): `GET` issues one,
mutations require one, a stale/missing/replayed token is `409` **and rolls back**. Publish and
unpublish run in `tx()` with a locked read, in-transaction gate re-evaluation, the content update
and a `content_approvals` row — any failure rolls back both, leaving no partial approval. Actor
identity comes only from `req.user`; nothing reads an actor from the request body.

`invalidatePublicCache()` is called only after a commit — never on validation failure, conflict,
gate failure or rollback (all five asserted).

### Test result

**727/727 API tests passing** — 634 pre-existing (zero regressions) plus 93 new. All exercise real
handlers against a controlled fake database and fake auth context; no live database was contacted.

### Account-specific permissions — the outstanding requirement

**Not supported, and not added by this batch.** Pre-existing capability was role-based only:
`users.role` (a single enum), `requireAuth(...roles)`, two role groupings, and one ad-hoc
role-derived check in the orders router. A verified search found no permissions table, per-account
column, scope list or ACL anywhere. B2.4A added a single named permission seam so a future
capability check has one place to attach, but per-account grants need an additive migration, which
this batch was explicitly forbidden from making. Two `admin` accounts remain indistinguishable in
authority. Full detail and remaining work: `18_B2_ADMIN_PUBLICATION_API.md` §1.1.

### Known limitations

- **Account-specific permissions absent** (above) — the most significant gap.
- **`variations` has no `updated_at`**, so its concurrency token is derived from `created_at` plus
  the fields this API can change; a change to a variation column outside that set would not
  invalidate it.
- **Cache invalidation is in-process only** — a multi-process deployment would need a shared signal.
- **Three declared `DEFERRED_GATES`**: no `is_non_variant` column; `media` has no per-asset approval
  state; nothing yet *requires* a `content_approvals` row before a state change.
- **Nothing is actually publishable yet** — no brand rows exist and no product has a `public_slug`
  (WP-08 backfill not started), so the publish path is proven against fixtures, not real records.

### Deferred to B2.4B–B2.4D

Per-account permissions (migration, resolution helper, assignment surface — plausibly its own
batch); the admin UI; catalogue backfill and brand seeding (WP-08); media upload and per-asset
approval; content-page/policy/form administration; cross-process and Zoho-sync cache invalidation.

### Final storage

Started 8.706 GB free; ended 8.711 GB. Never approached the 4 GB floor. **Zero new dependencies.**

### Confirmation

No live database, production system, VPS or DNS was contacted. **No record was published.** No
schema change was made. `platform/server/web/**`, `platform/server/storefront/**`,
`platform/server/db/**`, the root admin frontend, `docker-compose.yml`, `Caddyfile`, `deploy.sh`
and every `.env` file are unchanged, as are all existing `/public` response shapes and all pricing,
inventory, ordering and Zoho behaviour. The other developer's branch was never inspected,
referenced or merged. No commit was made and nothing was pushed.

---

## 16. B2.4P implementation result — account-specific capability permissions — 2026-08-06

### Files

**Added**
| Path | Purpose |
|---|---|
| `platform/server/db/migrations/0008_account_permissions.sql` | Additive `account_permissions` table. Contains no `INSERT`. |
| `platform/server/api/src/permission-registry.js` | Frozen registry of the four capability keys; no database access. |
| `platform/server/api/src/permissions.js` | Resolution service and capability middleware. |
| `platform/server/api/src/routes/account-permissions.js` | Management API, gated on `permissions.manage`. |
| `platform/server/api/test/permissions.test.js` | 29 tests — registry, resolution, middleware. |
| `platform/server/api/test/account-permissions.test.js` | 41 tests — schema alignment, mapping, management API, safety. |
| `docs/public-website-rebuild/19_ACCOUNT_PERMISSION_SYSTEM.md` | Full contract, including the bootstrap procedure. |

**Modified**
| Path | Change |
|---|---|
| `platform/server/api/src/migrate.js` | Idempotent `ensureSchema()` mirror of migration `0008`. |
| `platform/server/api/src/routes/admin-public-content.js` | Role check → per-route capability enforcement. |
| `platform/server/api/src/index.js` | Mounts `/admin/account-permissions` before the general `/admin` router. |
| `platform/server/api/test/admin-public-content.test.js` | Three role-model assertions updated to the capability model. |

### The four capabilities

`public_content.view` · `public_content.edit` · `public_content.publish` · `permissions.manage`

Closed set. No wildcards, no prefixes, no hierarchy, no client-defined names, no role names as keys.
Enforced independently by a database `CHECK`, the frozen registry, API validation, and a registry
filter on the resolver's own output.

### Route authorisation

| Route group | Capability |
|---|---|
| all `GET` public-content routes, `POST …/evaluate` | `public_content.view` |
| `PATCH /{brands,products,variations}/:id` | `public_content.edit` |
| `POST …/publish`, `POST …/unpublish` | `public_content.publish` |
| everything under `/admin/account-permissions` | `permissions.manage` |

The router-level gate is `requireAuth()` with **no role arguments** — identity only. An `admin`
holding no grant is refused; a non-admin holding a grant is allowed. Edit and publish are separate
and non-hierarchical.

### Verification

- Full API test suite: **797 passing, 0 failing** (70 new). Real handlers and middleware against
  injected database doubles.
- Proven behaviours include: a role-only administrator denied on a capability route; a non-admin
  with the grant allowed; permission forgery via headers, body and query rejected; revoked, disabled
  and unknown-key cases denied; stale-token `409`; cross-account token replay rejected;
  last-manager `422` with the count proven to run after the transaction's lock; revocation
  preserving history; no `DELETE` route; no customer data in the serializer.
- Source sweep of every changed file: no role bypass, no wildcard, no environment-variable or
  hard-coded-email bypass, no `SELECT *`, no row spreading, no SQL interpolation of user input, no
  client-supplied actor identity, no automatic grant, no secrets, no production hostnames, no
  `TODO`/`FIXME`, no merge markers. `git diff --check` clean.

### Required before this is usable

**The production bootstrap has not been performed, and no permission is assigned to any account.**
The table ships empty deliberately, so at present no account can use the public-content API at all.
The first `permissions.manage` grant is a one-time reviewed database operation — it cannot come from
the API, which requires that capability, and must not come from a migration, which would run
unreviewed on every deployment. Procedure, verification query, rollback query and warnings:
`19_ACCOUNT_PERMISSION_SYSTEM.md` §8. Grant it to **at least two** active accounts.

### Confirmation

No live database, production system, VPS or DNS was contacted. **No permission was assigned to any
real account** and the bootstrap was not performed. **No record was published.** No existing table,
column, constraint or role meaning was altered — the schema change is purely additive, and
`users.role` works exactly as before. `platform/server/web/**`, `platform/server/storefront/**`, the
root admin frontend, `docker-compose.yml`, `Caddyfile`, `deploy.sh` and every `.env` file are
unchanged, as are all existing `/public` response shapes and all pricing, inventory, ordering and
Zoho behaviour. The other developer's branch was never inspected, referenced or merged. No commit
was made and nothing was pushed.

---

## 17. B2.4B1 implementation result — account-permission management interface — 2026-08-06

### Admin frontend root

The repository root — `index.html`, `css/`, `js/`, `assets/`. A dependency-free vanilla-JS SPA:
no framework, no module system, no build step. `platform/server/deploy.sh` tars exactly those four
paths to `$DEST/admin`, which Caddy serves at `/admin/`.

### Files

**Added**
| Path | Purpose |
|---|---|
| `js/pages_permissions.js` | The Account Permissions screen. |
| `test/helpers/dom.js` | Dependency-free DOM double + loader for the real shipped scripts. |
| `test/permissions-client.test.js` | 14 tests — API client, access probe, navigation. |
| `test/permissions-page.test.js` | 30 tests — the rendered screen and its behaviour. |
| `test/admin-shell.test.js` | 9 tests — shell regression and the batch's protected-path boundary. |
| `docs/public-website-rebuild/20_ACCOUNT_PERMISSION_INTERFACE.md` | Full interface contract. |

**Modified**
| Path | Change |
|---|---|
| `js/data.js` | Three narrowly scoped permission client methods + an allowlist response shaper. |
| `js/app.js` | Capability probe (`loadCaps`/`can`), capability-filtered nav, gated NAV entry, caps cleared on logout. |
| `index.html` | Loads `js/pages_permissions.js`. |
| `css/styles.css` | Layout, focus states and notice styles for the new screen only. |

### Route and navigation

`#/account-permissions`, and `#/account-permissions/<userId>` with an account selected. Sidebar
entry **Account Permissions**, immediately above *Audit log*, shown only when the account holds
`permissions.manage`.

### Access model

The session carries `{id, name, role}` and **no capabilities**, so the panel asks the server:
`GET /admin/account-permissions/registry` is itself gated on `permissions.manage`, so `200` means
held and `403` means not. Anything else — including a network failure — is treated as not held.
Hiding the nav entry is convenience; **the API is the authority** and re-authorises every request.
No role bypass, no environment flag, no hard-coded account id or email.

### Behaviour summary

- Account selection reuses the existing `DB.d.users` list — no second user directory, no new search
  endpoint. Shows name, username, role and status; not email, address, balance or pricing.
- Four registry capabilities as labelled checkboxes, grouped *Public content* / *Permission
  administration*, each with its description and grant/revocation history. Revoked never renders as
  active. The screen states that edit and publish are independent.
- **A toggle mutates nothing.** Explicit Save sends the complete intended active set with the
  concurrency token; Save is disabled when unchanged and while saving; Reset restores the saved set;
  switching accounts with unsaved edits asks first.
- `409` reports that another administrator changed the permissions, never success, and offers an
  explicit reload. Returned tokens replace spent ones and are never reused across accounts.
- `422` explains the last-manager lockout protection and states that nothing was changed.
- Errors are translated; no API string, stack, SQL, hostname or port is ever rendered.

### Verification

- **Frontend test suite: 53 passing, 0 failing** (`node --test "test/*.test.js"`). Tests drive the
  real shipped scripts in a `vm` context against a hand-built DOM double — rendered output and
  behaviour, not source strings.
- **No frontend build exists.** The production equivalent was run instead: every shipped script
  parses (`node --check`), every `index.html` script reference resolves, and the exact `deploy.sh`
  tar payload assembles (1.3 MB, `index.html css js assets`).
- Diff sweep of the changed frontend: no hard-coded account id or email, no wildcard permission, no
  role bypass, no unrestricted response spreading, no raw error rendering, no secret, no production
  hostname, no bootstrap SQL, no `TODO`/`FIXME`, no merge markers. `git diff --check` clean.

### Required before this is usable

**Unchanged from B2.4P, and still blocking.** `account_permissions` is empty, so every capability
probe returns `403` and **this screen is currently unreachable by every account**, including every
existing administrator. The interface contains no bootstrap bypass and never executes SQL. Perform
the controlled bootstrap in `19_ACCOUNT_PERMISSION_SYSTEM.md` §8, then use this screen to grant
`permissions.manage` to a second active account.

### Confirmation

No live database, production system, VPS or DNS was contacted. **No permission was assigned to any
real account and no bootstrap SQL was executed.** No API endpoint was added or modified and no
schema was touched. `platform/server/api/**`, `platform/server/db/**`, `platform/server/web/**`,
`platform/server/storefront/**`, `docker-compose.yml`, `Caddyfile`, `deploy.sh` and every `.env`
file are unchanged. The other developer's branch was never inspected, referenced or merged. No
commit was made and nothing was pushed.

---

## 18. B2.4B2A implementation result — public-content review and draft editing — 2026-08-06

### Files

**Added**
| Path | Purpose |
|---|---|
| `js/pages_public_content.js` | Lists and the three editors. |
| `test/public-content.test.js` | 45 tests — capabilities, lists, editors, errors, accessibility. |
| `platform/server/api/test/public-content-capabilities.test.js` | 26 tests — capability endpoint and the publication boundary guard. |
| `docs/public-website-rebuild/21_PUBLIC_CONTENT_EDITOR.md` | Full contract. |

**Modified**
| Path | Change |
|---|---|
| `platform/server/api/src/routes/admin-public-content.js` | `GET /capabilities`; publication boundary guard on PATCH. |
| `js/data.js` | Capability + six public-content client methods, allowlist shapers, frozen editable-field mirror. |
| `js/app.js` | Public-content capabilities in `loadCaps()`; cache cleared before probing; `Public Content` nav entry. |
| `js/util.js` | One new icon. |
| `index.html`, `css/styles.css` | Script tag; editor styles. |
| `test/helpers/dom.js` | A `<textarea>`'s value reads its text content. |
| `test/admin-shell.test.js`, `test/permissions-client.test.js`, `platform/server/api/test/{account-permissions,admin-public-content}.test.js` | Updated for the new route and the `/capabilities` gate exemption. |

### Defect fixed

**An account holding only `public_content.edit` could publish a brand to the live public website.**
Brands have no `is_published` column — `publication_state = 'published'` is the flag, and it was
PATCH-editable without the publish capability, without the publication gate, and without an approval
record. A transactional boundary guard now refuses that transition in either direction, while
ordinary editorial transitions stay editable. 13 tests.

### Endpoint added

`GET /admin/public-content/capabilities` → `{ capabilities: { view, edit, publish } }`.
Authenticated, **ungated** (an account holding none must still get an honest answer), three booleans
about the caller only, no mutation, no caching, derived from `req.user.id` alone.

### Routes

`#/public-content[/brands|/products]`, `#/public-content/brands/<id>`,
`#/public-content/products/<id>`, `#/public-content/products/<pid>/variations/<vid>`.
Sidebar entry **Public Content**, shown only with `public_content.view`.

### Behaviour summary

- Lists come from the existing GET endpoints only; loading, empty, denied and **failed-load** states
  are distinct — a failure is never rendered as an empty catalogue.
- `view` renders everything read-only and visibly disabled; `edit` unlocks the controls. Neither
  implies the other; neither implies publish.
- **No publish or unpublish control exists at any capability level.** The publication-state select
  offers only `draft`, `verified`, `approved`, `retired`.
- Editing is local until Save; Save sends only changed fields through a frozen mirror of the API's
  allowlist, so `is_published`, `fact_owner`, `approver_id`, `sku` and `price` cannot be sent.
- Concurrency tokens are preserved, replaced from the response, and never shared between entities —
  a variation is saved with its own token, never its product's.
- `400` renders field-level errors against the relevant controls; `409` offers reload and never
  reports success; `401`/`403`/`404` and generic failures are translated; no raw API body, stack,
  SQL, hostname or port is ever shown.
- No price, cost, stock, availability, customer or order data appears anywhere.

### Verification

- **API suite: 823 passing, 0 failing** (797 baseline + 26).
- **Frontend suite: 99 passing, 0 failing** (53 baseline + 46), loading the real shipped scripts in
  the `vm` harness rather than a duplicate implementation.
- **No frontend build exists.** The production equivalent was run instead: every shipped script
  parses, every `index.html` reference resolves, and the `deploy.sh` tar payload assembles (1.4 MB).
- Diff sweep: no role bypass, no hard-coded account ids or emails, no unrestricted response
  spreading, no publish control, no `is_published` PATCH path, no raw error rendering, no
  price/stock/availability presentation, no secrets, no production hostnames, no bootstrap SQL, no
  `TODO`/`FIXME`, no merge markers. `git diff --check` clean.

### Required before this is usable

**Unchanged.** `account_permissions` is empty, so `/capabilities` returns all false for everyone and
the Public Content section is unreachable by every account, including every administrator. Perform
the bootstrap in `19_ACCOUNT_PERMISSION_SYSTEM.md` §8, then grant `public_content.view` and
`public_content.edit` through the B2.4B1 screen.

### Confirmation

No live database, production system, VPS or DNS was contacted. **No permission was granted to any
real account, no bootstrap SQL was executed, and nothing was published or unpublished.** No schema
change was made. `platform/server/db/**`, `platform/server/web/**`, `platform/server/storefront/**`,
`api/src/migrate.js`, `api/src/routes/public.js`, `docker-compose.yml`, `Caddyfile`, `deploy.sh` and
every `.env` file are unchanged, as are all public API response shapes and all pricing, inventory,
ordering and Zoho behaviour. The other developer's branch was never inspected, referenced or merged.
No commit was made and nothing was pushed.

---

## 19. B2.4B2B implementation result — publication evaluation, publish and unpublish — 2026-08-06

### Files

**Added**
| Path | Purpose |
|---|---|
| `test/publication-workflow.test.js` | 42 tests — evaluation, publish, unpublish, capabilities, concurrency, errors, accessibility. |
| `platform/server/api/test/publication-boundary.test.js` | 22 tests — the publication boundary and the publish/unpublish round trip. |
| `docs/public-website-rebuild/22_PUBLICATION_WORKFLOW_INTERFACE.md` | Full contract. |

**Modified**
| Path | Change |
|---|---|
| `platform/server/api/src/publication-gate.js` | Deadlock fix: `approved` and `published` both satisfy the state requirement. |
| `js/pages_public_content.js` | Publication panel: evaluation, publish, unpublish, confirmation, dirty policy. |
| `js/data.js` | Nine publication client functions, gate shaping, product advisories. |
| `css/styles.css` | Publication panel, gate result and reason styling. |
| `platform/server/api/test/publication-gate.test.js` | One case repinned from `approved` to `verified`. |
| `test/public-content.test.js`, `test/admin-shell.test.js` | Updated for capability-gated publication controls and action-neutral error wording. |

### Deadlock fixed

**The publication gate required a record to be already published in order to be publishable.** For
brands — whose `publication_state` *is* the live flag — the only route into that state was the
publish endpoint whose own gate demanded it first, so after B2.4B2A closed the PATCH bypass **no
brand could ever be published**. It also made unpublication one-way for every entity type, because
`unpublishEntity` returns records to `approved`. Now `approved` and `published` both pass; the reason
code was kept stable and only the message changed.

### Capability mapping

| Action | Capability |
|---|---|
| `POST …/{brands\|products\|variations}/:id/evaluate` | `public_content.view` (a read — writes nothing) |
| `POST …/:id/publish` · `POST …/:id/unpublish` | `public_content.publish` (does not require `edit`) |

No new route was added and no response shape changed.

### Behaviour summary

- **Evaluation is explicit.** Opening a record never evaluates and never mutates; the readiness check
  is a deliberate action with a visible checking state.
- **Gate reasons render in the server's own order**, with message, field path (including nested paths
  like `variations[0].color`) and stable code. Advisories are shown separately and never block.
  No raw JSON.
- **Publish** requires a fresh allowed verdict, an explicit confirmation naming the record, and the
  current token. The confirm button disables on first click. A blocked record offers **no bypass** —
  and the publication-state select never offers `published` at any capability level.
- **Unpublish** requires no readiness check, is confirmed explicitly, and is **never presented as
  deletion**: content, approvals and URLs are preserved and the record can be published again.
- **Unsaved edits block evaluation and both decisions**, explained in place, and are never silently
  discarded. Any verdict is discarded when the record changes.
- **The decision body carries only a token and an optional note.** Actor, approver, `is_published` and
  `publication_state` are structurally unsendable; the server records the approver from the session.
- `409` never reports success, never retries, and offers a reload that drops the stale verdict.
  `422` renders the gate's own reasons and leaves state unchanged.

### Verification

- **API suite: 845 passing, 0 failing** (823 baseline + 22).
- **Frontend suite: 141 passing, 0 failing** (99 baseline + 42), loading the real shipped scripts.
- **No frontend build exists.** Production equivalent run instead: every shipped script parses, every
  `index.html` reference resolves, and the `deploy.sh` tar payload assembles (1.4 MB).
- Diff sweep: no role bypass, no client-side publication-state or `is_published` mutation, no publish
  control without the capability, no client-supplied actor or approver, no automatic mutation retry,
  no raw error rendering, no delete language, no bootstrap SQL, no secrets, no production hostnames,
  no `TODO`/`FIXME`, no merge markers. `git diff --check` clean.

### Required before this is usable

**Unchanged, and now blocking more.** `account_permissions` is empty, so `/capabilities` returns all
false and review, editing and publication are all unreachable by every account. Perform the bootstrap
in `19_ACCOUNT_PERMISSION_SYSTEM.md` §8, then grant `public_content.view`/`.edit` to editorial staff
and `public_content.publish` to whoever is authorised to publish.

### Confirmation

No live database, production system, VPS or DNS was contacted. **No record was published or
unpublished, no permission was granted to any real account, and no bootstrap SQL was executed.** No
schema change, no new API route and no changed response shape. `platform/server/db/**`,
`platform/server/web/**`, `platform/server/storefront/**`, `api/src/index.js`, `api/src/migrate.js`,
`api/src/routes/public.js`, `docker-compose.yml`, `Caddyfile`, `deploy.sh` and every `.env` file are
unchanged, as are all public API response shapes and all pricing, inventory, ordering and Zoho
behaviour. The other developer's branch was never inspected, referenced or merged. No commit was made
and nothing was pushed.
