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
| 3 — Release quality gates | pending | |
| 4 — Accessibility and responsive QA | pending | |
| 5 — Storefront fix integration prep | pending | |
| 6 — Release-candidate handoff | pending | |

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
