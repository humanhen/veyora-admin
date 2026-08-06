# Fast-Track Workstream 2 — Release-Candidate Handoff

Unattended run. Six independently recoverable phases, each ending in a **local** checkpoint commit.
Nothing is pushed, deployed, or run against production.

---

## Run metadata

| | |
|---|---|
| **Branch** | `mathew/public-website-rebuild` |
| **Starting commit** | `4c474fc` — *fix: verify enquiry form CSRF behind proxy* |
| **Starting tree** | clean, `git diff --check` clean |
| **Free space at start** | 8.6 GB |
| **Started** | 2026-08-06 |

### Baseline at the starting commit

| Suite | Result |
|---|---|
| API | 998 passing |
| Root admin frontend | 141 passing |
| Web (Astro) | 435 passing |
| Astro production build | succeeds |

---

## Safety boundary

Not done at any point: production or VPS access, live database connection, DNS changes, deployment,
permission bootstrap SQL, capability grants to real accounts, publication of real content, real
catalogue processing, `git push`, merges into `main` or `mathew/monday-release`, or exposure of
price, stock, customer or internal commercial data.

No new frontend framework, browser binary, Docker image or ORM. Zero new dependencies.

---

## Phase status

| Phase | Status | Checkpoint |
|---|---|---|
| 0 — Verify starting state | complete | *(no commit — Phase 0 alone does not check point)* |
| 1 — Release deployment architecture | complete | `checkpoint: prepare release deployment architecture` |
| 2 — Governed enquiry operations | complete | `checkpoint: add governed enquiry operations` |
| 3 — Release quality gates | complete | `checkpoint: add release quality gates` |
| 4 — Accessibility and responsive QA | complete | `checkpoint: complete accessibility and responsive audit` |
| 5 — Storefront fix integration prep | complete | `checkpoint: prepare storefront integration review` |
| 6 — Release-candidate handoff | complete | `checkpoint: complete release candidate handoff` |

---

## Phase 0 — findings that shape the run

Recorded before any edit, because three of them constrain what the later phases can honestly do.

### Docker and Caddy are not available locally

`docker` and `caddy` are both absent from this machine. Neither Compose parsing nor Caddyfile
validation can be executed here. Phase 1 therefore relies on **strong static tests** over the
configuration files, and records executable validation as a supervised RC prerequisite. No image is
downloaded and no container is built.

### The current topology, as it actually stands

| Service | Present | Notes |
|---|---|---|
| `db` (postgres:16-alpine) | yes | healthcheck present; migrations mounted read-only for first-run init |
| `api` | yes | **no healthcheck**; `depends_on: db (service_healthy)` |
| `caddy` | yes | serves storefront at the catch-all, `/admin/`, `/api/*`, `/s3/*` |
| **`web` (Astro)** | **no** | the Dockerfile exists and is production-shaped, but the service is not in Compose and `deploy.sh` does not ship `web/` |

So the public website has never been deployable. Phase 1's core job is to make it so — additively.

### The catch-all switch is the highest-risk change in the programme

`04_TARGET_ARCHITECTURE.md` §5.2 specifies the public site taking the catch-all with the portal
moving to a named host, and `08_RISKS_AND_OPEN_DECISIONS.md` R-01/R-02 score that switch 20 and 15 —
the two highest risks recorded. `deploy.sh` ships the `Caddyfile` and immediately runs
`docker compose up -d --build`, so **editing `Caddyfile` in place would arm an unsupervised cutover
on the next deploy by anyone, for any reason**.

**Decision:** the new topology ships as a **separate `Caddyfile.rc`**, leaving the live `Caddyfile`
untouched. Cutover becomes one deliberate, reversible line on the server after the RC is verified.
This satisfies "reversible changes" and "preservation of the current production site until the new
web service is healthy" without arming a change nobody asked for tonight.

---

## Log

### Phase 0 — complete

- Verified branch, commit `4c474fc`, clean tree, 8.6 GB free.
- Read the overnight handoff, target architecture, implementation plan, risk register, build package,
  permission system, publication workflow, backfill plan, enquiry forms and SEO documents.
- Inspected `docker-compose.yml`, `Caddyfile`, `deploy.sh`, both Dockerfiles, `.env.example`, the web
  health endpoint and the existing admin/storefront routing.
- Confirmed `docker` and `caddy` are unavailable locally.
- Created this document.
- **Files changed:** `docs/public-website-rebuild/FAST_TRACK_RELEASE_HANDOFF.md` (new).
- **Tests run:** none (no code changed).
- **Next:** Phase 1 — release deployment architecture.

### Phase 1 — complete

**Files changed**

| Path | Change |
|---|---|
| `platform/server/docker-compose.yml` | `web` service added; `api` gained a healthcheck; ordering now waits on health; Caddyfile selectable via `${CADDYFILE:-./Caddyfile}` |
| `platform/server/Caddyfile.rc` | new — RC two-host topology, **not live by default** |
| `platform/server/Caddyfile` | **unchanged** (deliberately) |
| `platform/server/deploy.sh` | preflight (local + remote env), ships `web/`, waits for web health, release verification, cutover/rollback notes |
| `platform/server/.env.example` | new variables documented with `example.test` placeholders |
| `platform/server/api/test/deployment-config.test.js` | new — 30 static validation tests |
| `docs/public-website-rebuild/26_RELEASE_DEPLOYMENT_ARCHITECTURE.md` | new |

**Tests:** focused 30/30. Full API suite **1028 passing, 0 failing** (998 baseline + 30). Deploy
payload still assembles (1.4 MB).

**Decisions**

- **The cutover is opt-in, not shipped live.** `deploy.sh` ships the `Caddyfile` and immediately runs
  `docker compose up -d --build`, so editing it in place would arm the R-01/R-02 catch-all switch —
  the two highest-scoring risks in the programme — on the next deploy by anyone. The RC topology
  ships as `Caddyfile.rc` and is selected by one `.env` line. Rollback is deleting that line.
- **`PUBLIC_SITE_ORIGIN`/`PORTAL_ORIGIN` use `${VAR:?}`**, so Compose refuses to start rather than
  substituting empty. A default would break canonical URLs and form CSRF while looking healthy.
- **`api` gained a healthcheck** that runs `select 1`; `web` and `caddy` now wait on health rather
  than on "the container started".
- **No `header_up Host`** anywhere, with the reason recorded beside the directive: rewriting Host
  would make Astro compute `http://web:4321` and 403 every form POST.
- **No CORS header**, **no canonical-host redirect** (environment-derived hosts make a loop trivial
  to create at cutover for no benefit).

**Defects found**

- The web service had never been deployable at all — absent from Compose and from the deploy payload.
- `api` had no healthcheck, so `depends_on: api` meant only that the process had launched.

**Limitations**

- `docker` and `caddy` are absent locally; all 30 tests are static. `docker compose config` and
  `caddy validate` remain supervised RC prerequisites.
- A pre-existing hard-coded `SMTP_FROM` default remains in the `api` service — left alone because
  changing it unattended could alter live transactional email sender identity.
- The R-01 consequences (`setPasswordLink`, `listUrl`, legacy hash bridge) are **not** part of this
  phase and must be handled before any cutover.

**Next:** Phase 2 — governed enquiry operations.

### Phase 2 — complete

**Files changed**

| Path | Change |
|---|---|
| `platform/server/db/migrations/0009_enquiry_operations.sql` | new — widens the capability CHECK, adds four handling columns |
| `platform/server/api/src/migrate.js` | `ensureSchema()` mirror for 0009 |
| `platform/server/api/src/permission-registry.js` | `enquiries.view`, `enquiries.manage` appended |
| `platform/server/api/src/enquiry-operations.js` | new — transition model, serializers, retention, paging |
| `platform/server/api/src/routes/admin-enquiries.js` | new — four routes |
| `platform/server/api/src/index.js` | mounted at `/admin/enquiries`, before the general `/admin` router |
| `platform/server/api/test/admin-enquiries.test.js` | new — 61 tests |
| `platform/server/api/test/permissions.test.js` | registry assertion updated; distinctness test added |
| `platform/server/api/test/account-permissions.test.js` | CHECK assertions read both migrations; superset test added |
| `js/data.js` | four client calls + three shapers |
| `js/pages_enquiries.js` | new — the Enquiries screen |
| `js/app.js` | nav entry + a third capability probe |
| `index.html` | script tag |
| `test/enquiries-page.test.js` | new — 24 tests |
| `test/admin-shell.test.js` | script list, nav gating, boundary tests reworked (below) |
| `test/permissions-client.test.js` | the probe list is now three calls |
| `test/helpers/dom.js` | three more exported globals |
| `docs/…/27_ENQUIRY_OPERATIONS.md` | new |
| `docs/…/19`, `20`, `24` | updated |

**Tests:** API **1091 passing** (1030 + 61), root admin frontend **166 passing** (141 + 24 + 1),
Astro web **435 passing** (unchanged). 0 failing. `git diff --check` clean. Free space 8.5 GB.

**Decisions**

- **Two new capability keys, not a reuse of `public_content.view`.** Reusing it would have been one
  line and no migration, and would have handed every existing content reviewer a personal-data inbox
  nobody granted them. A capability is cheap to add and impossible to un-grant retroactively.
- **`handling_status` is a new column, not an overload of `delivery_state`.** One records what a
  machine managed to do, the other what a person decided; merging them makes "we could not email it"
  and "we have replied" indistinguishable.
- **No state is terminal.** `closed` and `spam` both return to `in_review`, so a mis-filed enquiry
  from a real customer is recoverable without production SQL. Nothing returns to `new`.
- **No DELETE anywhere** — no route, no statement, no `'deleted'` status. Retention is metadata only,
  and the screen says so.
- **The list omits the message and the email address**; only the detail view shows them.
- **`0008` is not edited.** `0009` drops its anonymous CHECK and adds an explicitly named superset.
- **Capability discovery is ungated** (authenticated only), so an account holding neither gets an
  honest all-false answer instead of a failure.

**Defects found**

None in existing code. The gap this phase closed was an absence, not a defect: enquiries had been
stored and unreadable since the forms shipped.

**Two boundary tests were reworked, deliberately**

`test/admin-shell.test.js` carried a protected-path list written for the B2.4B batches, naming
migrations, `migrate.js`, `docker-compose.yml` and `deploy.sh`. This workstream's brief explicitly
permits all four, and Phase 1 already changed two of them, so the guard as written asserted a
boundary the repository no longer has and would have been widened reflexively. It was narrowed to
what remains genuinely protected in every workstream — the **live** `Caddyfile`, the storefront, and
any real `.env` (with `.env.example` exempt by name) — and a second test was added asserting that any
migration a change adds is additive: no `DROP TABLE`/`COLUMN`, no `ALTER COLUMN`, no `DELETE`, no
`TRUNCATE`, and no unguarded constraint drop. It also no longer fails on a clean tree, which is what
a checkpoint commit leaves behind.

**Unresolved limitations**

- **Nothing was run against a database.** `0009` has not executed anywhere; the migration rehearsal
  remains a supervised RC prerequisite.
- **Nobody holds either capability** — a real business decision about who may read customer
  correspondence, not something to automate. Blocker B.
- **Retention deletion is not implemented.** Metadata says when a record is due; nothing removes it.
- **Onward delivery is still not built**; every submission stays `delivery_state = 'pending'`.
- **No export, no free-text search, no assignment model.** Each was deliberately not built.

**Next:** Phase 3 — release quality gates.

### Phase 3 — complete

**Files changed**

| Path | Change |
|---|---|
| `scripts/verify-release.mjs` | new — the release verification command, 15 gates |
| `test/verify-release.test.js` | new — 20 tests over the command itself |
| `test/admin-shell.test.js` | `scripts/` added to the working areas |
| `platform/server/web/src/env.ts` | **defect fix** — a wildcard hostname was accepted |
| `platform/server/web/test/env.test.ts` | 3 tests for the fix |
| `docs/…/28_RELEASE_QUALITY_GATES.md` | new |
| `docs/…/08_RISKS_AND_OPEN_DECISIONS.md` | R-06 rescored and updated |

**Tests:** all 15 gates pass in ~112 s. API **1091**, root admin frontend **186** (166 + 20), Astro
web **438** (435 + 3). 0 failing. `git diff --check` clean. Free space 8.5 GB.

**Decisions**

- **One command, `node scripts/verify-release.mjs`.** No root `package.json` was created — adding one
  purely to hold a script would put an npm surface on the repository root that nothing else needs.
- **Four gates re-run tests the suites already ran.** A release conversation asks "did the
  forbidden-data scan pass"; a number inside a total of 1,091 cannot answer that. Ten seconds buys a
  summary of controls rather than suites.
- **Failures do not stop the run** unless `--fail-fast` is given. A check that halts at the first
  problem makes you run it five times to find five problems.
- **The host/secret exception list is a pin, not a mute.** Every entry carries a written reason and is
  printed on every run; anything not on it fails; an entry that no longer matches *also* fails, so a
  fixed exception cannot linger. Three are marked `R-01` and reported as open release blockers.
- **`deploy-payload` parses the file list out of `deploy.sh`** rather than keeping a copy that drifts.
- **R-06 rescored L3×I4=12 → L2×I4=8, and left open.** Likelihood drops because one command now runs
  every scan with a per-control verdict. It does not close: "wired as a merge gate" was in the
  original mitigation and there is still no CI in this repository, and no scan has run against a real
  row.

**Defect found and fixed**

`src/env.ts` accepted a wildcard hostname. `new URL('https://*.example.com')` parses fine — `*` is a
legal hostname character — and every existing check was about protocol, path, query and fragment.
`astro.config.mjs` refused a wildcard when deriving `security.allowedDomains`, but that runs at
**build** time, so a container starting from an already-built image with a wildcard origin passed
validation, started, and would have emitted canonical URLs and sitemap entries containing a literal
`*`. Found by the `env-validation` gate on its first run. Fixed in `normalizeOrigin`, with a test
asserting the build-time config and the runtime resolver still agree.

**Unresolved limitations**

- **Nothing runs the command automatically.** No CI exists in this repository. Blocker C.
- **No real data anywhere**; every scan is against fixtures, mocks and a synthetic catalogue fixture.
- **`docker compose config` and `caddy validate` still cannot run here.**
- The rendered scan covers only routes the mock can serve.
- Running the command leaves a production build in `dist/` (untracked).

**Next:** Phase 4 — accessibility and responsive QA.

### Phase 4 — complete

**Files changed**

| Path | Change |
|---|---|
| `platform/server/web/test/helpers/headless-chrome.ts` | new — a CDP driver built from `spawn` + `fetch` + Node 22's global `WebSocket` |
| `platform/server/web/test/helpers/a11y-audit.ts` | new — the in-page audit, 17 rules |
| `platform/server/web/test/accessibility-responsive.test.ts` | new — 28 tests, 30 page/viewport audits |
| `scripts/verify-release.mjs` | `accessibility-responsive` gate added |
| `docs/…/29_ACCESSIBILITY_AND_RESPONSIVE_QA.md` | new |

**Tests:** 28 passing. Astro web **466** (438 + 28). API 1091, root admin frontend 186. All **16**
release-verification gates pass in ~162 s. `git diff --check` clean. Free space 8.2 GB.

**Decisions**

- **Chrome was already installed, so it was used — nothing was installed.** Chrome and Edge ship the
  DevTools Protocol over a plain WebSocket and Node 22 has a global `WebSocket`, so the driver needs
  no package at all. A test asserts Playwright, Puppeteer, Selenium, Cypress and the CDP wrapper
  packages are all absent from the dependencies.
- **The browser has no DNS.** `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` — it can
  reach loopback and nothing else. A throwaway profile under the temp directory, so the operator's
  real Chrome profile is never opened.
- **No browser present ⇒ skip, not fail.** A QA control that goes red because of the machine it runs
  on is one people learn to ignore. The consequence is recorded: a green gate is not proof browser QA
  ran, and the diagnostics say how many combinations were audited.
- **Three findings pinned rather than fixed.** All three are one design-system decision applied
  everywhere; changing them is visual drift on every route (R-07, score 12) and a person's call. The
  pin fails on anything new *and* on any pin that stops matching.
- **Emulation asserted against `innerWidth`, overflow against `clientWidth`.** A classic scrollbar
  makes them differ by 15px; conflating them reports a scrollbar as a layout defect.

**Defect found in my own first version, and fixed**

The contrast check initially treated a translucent text colour as unmeasurable. That skipped **687 of
1,113 text elements — 62% of the text on the site** — and reported the remaining 38% as a contrast
audit that passed. Alpha-compositing the foreground over its resolved background took coverage to
**100%** and immediately surfaced findings the 38% version had missed entirely.

**Open findings (pinned, and release blockers)**

1. **Footer tap targets under 24×24** — WCAG 2.2 AA 2.5.8. `a.site-footer__logo` at 142×19 and three
   footer nav links at ~20px tall. 20 occurrences at 375px, all in the footer.
2. **Contrast 4.06:1 and 2.65:1** — WCAG 1.4.3, 183 occurrences, one root cause: a text colour at 42%
   alpha. The footer group is a near miss (0.42 → ~0.52 clears it with no layout change); the
   skeleton-notice placeholder at 2.65:1 should not ship at all.
3. **363 micro labels between 10px and 12px** — no WCAG minimum exists, so a readability finding
   rather than a conformance failure; overlaps with (2) and should be decided with it.

**Everything else came back clean at all three widths:** no horizontal overflow, viewport meta
everywhere with zoom enabled, one `main` and one `h1` per page, no skipped heading levels, a working
skip link first in tab order, every image with an `alt`, every control named, **every field on all
three enquiry forms labelled**, no duplicate ids, no dangling ARIA references, no positive `tabindex`,
no text under 10px.

**Unresolved limitations**

- **Automated checking finds about a third of WCAG issues.** No screen-reader pass, no keyboard
  walkthrough, no focus-visibility judgement, no alt-text quality review, no real devices, no zoom or
  reflow testing (1.4.10, 1.4.12), no reduced-motion check. A supervised manual pass is a release
  requirement.
- **Chrome only.** Safari and Firefox unexercised.
- **Mock fixtures only** — long names, missing images and unusual characters are all absent.
- The admin panel and the storefront are out of scope.

**Next:** Phase 5 — storefront fix integration preparation.

### Phase 5 — complete

**Files changed**

| Path | Change |
|---|---|
| `docs/…/30_STOREFRONT_FIX_INTEGRATION.md` | new — the integration-preparation report |

No code changed. **Nothing was merged, rebased, cherry-picked, checked out or pushed**, and the other
developer was not contacted.

**Tests:** none run (no code changed). `git diff --check` clean. Free space 8.2 GB.

**How the branch was identified**

Not by name. Nine remote branches were fetched read-only and ranked by recency, author and content.
`feat/storefront-catalog-ux-and-homepage` (0x1p0, 2026-08-06) is the storefront work: it is the most
recent non-mine commit, it branches from `2c749ec` — this branch's own root — and its own committed
changelog states `Base: mathew/public-website-rebuild`.

**Decisions**

- **Report, not merge.** Three things in the change need a person: a commercial font licence, a
  brand-filter behaviour change that needs real catalogue data, and three live social-media links.
- **`fix/storefront-catalog-thumb-selection` is superseded — do not merge it.** Its fix is already
  present in the newer branch (the distinctive `setMainPhoto` / `thumb-swapping` construction), and it
  has no common ancestor with this branch, so merging it would mean an unrelated-histories merge to
  obtain something already there. That resolves the "two candidates" ambiguity on evidence.
- **`git fetch` was used** — read-only, no push, no remote ref altered. It is the only way to identify
  a branch by content rather than by guessing a name.
- **The merge was computed, not performed**: `git merge-tree --write-tree` produces a tree object
  without touching the working tree or any ref.

**Findings**

- **The repository has two unrelated histories.** `git merge-base origin/main
  origin/mathew/public-website-rebuild` returns nothing: this branch was started as an orphan root
  (`2c749ec`) containing a snapshot of the whole repository. Landing it is therefore not an ordinary
  pull request, and anything on the `main` lineage needs `--allow-unrelated-histories` or a
  cherry-pick. **This is a release blocker in its own right and was not previously recorded anywhere.**
- **The merge is clean** — no conflicts, verified.
- **Only two files overlap**: `index.html` and `css/styles.css`. Neither conflicts.
- **A latent defect the clean merge hides**: they bump `css/styles.css?v=7` → `?v=8` while every
  script tag stays at `?v=7`, including the new `pages_enquiries.js`. A returning operator gets new
  CSS and cached old JavaScript — the Enquiries screen would ship behind a cache.
- **Nothing under `platform/server/web/` changes**, so the entire public site, the enquiry forms, the
  SEO controls and Phase 4's accessibility work are untouched.
- **The one API change is on the authenticated portal catalogue route**, not the public boundary, so
  R-06 is unaffected. It has no direct test coverage.
- **Zero tests accompany the change** — consistent with the repository, which has no storefront suite.
- **A pre-existing admin-panel accessibility issue surfaced**: `index.html` carries
  `maximum-scale=1.0`, disabling pinch-zoom (WCAG 1.4.4). It predates both branches and is outside
  Phase 4's public-site scope.

**Unresolved limitations**

- **The merged tree was not tested.** Verifying it needs a checkout with `node_modules`, which is a
  supervised step. `api-suite` and `admin-frontend-suite` must be re-run after the merge —
  `admin-shell.test.js` asserts the exact script list in `index.html`.
- **Font licensing is unassessed** and cannot be assessed from here.
- **The brand-filter change was not validated against real catalogue data.**

**Next:** Phase 6 — release-candidate handoff.

### Phase 6 — complete

**Files changed**

| Path | Change |
|---|---|
| `docs/…/31_RELEASE_CANDIDATE_READINESS.md` | new — full regression, security sweep, blocker register |
| `platform/server/web/test/helpers/headless-chrome.ts` | **defect fix** — the browser was leaking process groups |
| `docs/…/29_ACCESSIBILITY_AND_RESPONSIVE_QA.md` | §8.1 records the leak and the fix |

**Full regression:** `node scripts/verify-release.mjs` — **16/16 gates pass in 132 s**.
API **1091**, root admin frontend **186**, Astro web **466** — **1,743 tests passing, 0 failing.**
`git diff --check` clean. Free space **8.5 GB**.

**Security sweep — findings**

Clean: authorisation (every router's gate enumerated; the three capability-gated routers mount before
the general `/admin` router; no role satisfies a capability anywhere), the public read boundary (no
write method in `routes/public.js`), SQL injection (every template interpolation traced to a code
constant; no user-controlled identifier reaches SQL), dynamic execution (no `eval`, no `new
Function`, no `child_process` in shipped source), XSS (every `innerHTML` site is a constant or an
`esc()`-guarded template), and CSRF (verified through a proxy reproducing Caddy's header contract).

**One new finding.** `SECURE_COOKIES` is derived from `PUBLIC_URL`:
`/^https:/i.test(process.env.PUBLIC_URL || '')`. `PUBLIC_URL` currently means the portal, and the
R-01 cutover changes what it refers to — if it is repointed at the public site, unset, or set without
a scheme, **the authentication cookies silently lose the `Secure` flag**. Same variable family as the
three pinned R-01 link fallbacks, and it should be handled in the same change. Recorded as C-06.

Ten runtime dependencies in total, **zero added by this workstream**. No vulnerability audit was run
(it needs the network) — recorded as C-11.

**Defect found and fixed: my own browser driver leaked**

`child.kill()` signals the launcher; Chrome's crashpad handler, network service and renderers are
separate processes that survive it. Repeated runs of the Phase 4 suite left **199 orphaned Chrome
processes holding about 3.6 GB** — free space had fallen to 4.8 GB against this run's 4 GB floor.
Diagnosed by matching process command lines against my own temp-profile path, so only my processes
were terminated and the operator's own 14 Chrome processes were left untouched. Fixed with a graceful
`Browser.close` over CDP, a process-tree kill as fallback, and a stale-profile sweep at launch so a
leak self-heals. Verified: zero orphans, free space stable at 8.5 GB across runs.

**Blocker register — 34 items in five categories**

| Category | Count | The two that matter most |
|---|---|---|
| A — real data | 6 | |
| B — account decisions | 3 | **B-01: no account holds any capability.** Until the `permissions.manage` bootstrap is performed, every governed admin screen is unreachable by every account, including every existing administrator. |
| C — release infrastructure | 12 | **C-03: the stack has never run anywhere.** Until it does, everything else is a claim about tests. |
| D — business/legal facts | 7 | |
| E — supervised integration | 7 | |

**Verdict:** ready for a supervised release candidate; **not** ready to be released.

**Unresolved limitations**

Nothing ran against a database, production, a VPS or real DNS. `docker` and `caddy` are not installed
here, so all deployment verification is static. Every rendered surface came from mock fixtures. The
browser QA is Chrome-only and headless. No real enquiry, catalogue row or account was touched.
Nothing was pushed or merged.

**Next:** none — this is the final phase. Six local checkpoint commits sit on
`mathew/public-website-rebuild`, ahead of `origin`, unpushed.
