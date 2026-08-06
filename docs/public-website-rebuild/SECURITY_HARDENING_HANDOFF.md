# Security Hardening Workstream — Handoff

Implementation of the five approved security corrections from the production-standard audit, in six
independently recoverable phases, each ending in a **local** checkpoint commit.

Nothing is pushed, deployed, or run against production.

---

## Run metadata

| | |
|---|---|
| **Branch** | `mathew/public-website-rebuild` |
| **Starting commit** | `77c65d5` — *Resolve release lineage and record Stripe decision* |
| **Starting tree** | clean, `git diff --check` clean |
| **Repository** | full history (no longer shallow) |
| **Free space at start** | 8.2 GB |
| **Started** | 2026-08-06 |

### Baseline at the starting commit

| Suite | Result |
|---|---|
| API | 1,091 passing |
| Root admin frontend | 186 passing |
| Web (Astro) | 466 passing |
| Release gate | 16/16 |

---

## Safety boundary

Not done at any point: production or VPS access, live database connection, DNS changes, deployment,
permission bootstrap SQL, capability grants to real accounts, branch merges, fast-forward of `main`,
`git push`, Stripe functionality, Apple/Google Pay work, real catalogue or enquiry processing, Docker
images or browser binaries.

---

## Phase status

| Phase | Status | Checkpoint |
|---|---|---|
| 0 — Verify and map | complete | *(no commit — Phase 0 alone does not check point)* |
| 1 — Origin and cookie contract | complete | `fix: separate authentication and public origin security` |
| 2 — Authentication abuse controls | pending | |
| 3 — Warehouse sync writes | pending | |
| 4 — Audit-log integrity | pending | |
| 5 — Permission and release safety | pending | |
| 6 — Regression and handoff | pending | |

---

## Phase 0 — the boundaries as they actually stand

Recorded before any edit. Five findings shape the work, and two were not in the audit.

### 0.1 AUTH-002 — the cookie flag, confirmed

```js
// platform/server/api/src/authmw.js:10-12
const SECURE_COOKIES = /^https:/i.test(process.env.PUBLIC_URL || '');
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES, path: '/' };
```

`PUBLIC_URL` currently means *the portal*. After the catch-all cutover it is the natural name for
*the public site*. Repointing it, unsetting it, or setting it without a scheme **silently drops
`Secure` from both authentication cookies** — no error, no log line.

### 0.2 SEC-004 — every ambiguous link is a portal or admin destination

Six sites read `PUBLIC_URL`, and **not one of them is a public-website link**:

| Site | Link built | Correct destination |
|---|---|---|
| `authmw.js:100` | `/#/set-password/<token>` | **portal** |
| `emails.js:242,264` | `/#/order/<id>` | **portal** |
| `emails.js:284,299` | `/#/backorders` | **portal** |
| `emails.js:346,359` | `/admin/#/orders` | **admin** |
| `routes/catalog.js:373` | `/#/list/<slug>` | **portal** (`04_TARGET_ARCHITECTURE.md` §8.1 keeps shared lists on the portal host) |

All six fall back to `https://veyora.design`, which becomes the **public site** after cutover. That is
R-01's breakage stated precisely: password-reset links, order links and shared-list links already in
customers' inboxes would land on a site that has no such routes.

### 0.3 NEW — `trust proxy` is set to `true`, and that breaks rate limiting before it is written

```js
// platform/server/api/src/index.js:22
app.set('trust proxy', true);
```

`true` means *trust every hop*. Express then takes `req.ip` from the **left-most** `X-Forwarded-For`
entry — a value the client fully controls. Any IP-keyed limiter would be bypassable by sending a
different `X-Forwarded-For` on each request.

The approved topology has **exactly one** reverse proxy (Caddy), so the correct setting is a hop
count of `1`. **This is a prerequisite for Phase 2**, not an optional extra, and it was not in the
audit.

### 0.4 NEW — the two OTP verifiers are the sharpest unauthenticated risk

`POST /auth/verify-activation-otp` and `POST /auth/verify-forgot-otp` check a **six-digit code**
(`crypto.randomInt(100000, 999999)`) with a 15-minute expiry and **no attempt limit of any kind**.
`verifyOtp` does not count failures, and nothing throttles the endpoint.

A six-digit space is 900,000 values. Unthrottled, that is a few minutes of automated requests to take
over an account through password reset. It is a sharper risk than the login endpoint, which is at
least protected by bcrypt's cost, and the audit recorded it only as part of the general AUTH-004
finding.

**The full authentication surface (9 endpoints):** `/login`, `/logout`,
`/request-activation-otp`, `/verify-activation-otp`, `/set-password`, `/forgot-password`,
`/verify-forgot-otp`, `/reset-password` — plus session refresh inside `requireAuth`.

### 0.5 SEC-002 — the warehouse write scope, confirmed and quantified

`routes/admin.js:33` mounts the whole router as `requireAuth('admin', 'warehouse')`. The generic
`POST /admin/sync` (line 733) writes 18 collections. **Exactly one is gated**: `users`, at line 765,
whose comment names the self-escalation attack it prevents.

The other 17 are open to a warehouse login, including `promotions`, `invoices`, `payments`,
`creditNotes`, `shippingRules`, `freeShipping`, `settings` (which carries the FX rates) and `audit`.

### 0.6 SEC-015 — audit integrity, confirmed

`audit` is in `SIMPLE_COLLECTIONS` (`shape.js`), so it is reachable by the generic sync path like any
other collection: upsert **and** delete. The server-side writer is `db.js`'s `audit()`, a single
parameterised `INSERT`. There is no database-level protection.

An audit log that the audited party can rewrite is not an audit log.

---

## Log

### Phase 0 — complete

- Verified branch, commit `77c65d5`, clean tree, full history, 8.2 GB free.
- Read the risk register, permission system and interface, deployment architecture, quality gates, RC
  readiness, the production-standard audit and its matrix and backlog, and the git-history diagnosis.
- Inspected `authmw.js`, `routes/auth.js`, `index.js` (proxy trust), `routes/admin.js` (generic
  sync), `shape.js`, `db.js`, `emails.js`, `routes/catalog.js`, `web/src/env.ts`,
  `web/astro.config.mjs` and `scripts/verify-release.mjs`.
- Recorded two findings not in the audit: **0.3** (`trust proxy: true`) and **0.4** (unthrottled
  six-digit OTP verification).
- **Files changed:** this document (new).
- **Tests run:** none (no code changed).
- **Next:** Phase 1 — explicit origin and cookie security contract.

### Phase 1 — complete

**Files changed**

| Path | Change |
|---|---|
| `platform/server/api/src/origins.js` | new — the single validated origin and cookie-security contract |
| `platform/server/api/src/authmw.js` | cookie security from the contract; `setPasswordLink` is a portal link |
| `platform/server/api/src/emails.js` | 6 link sites split into `PORTAL()` and `ADMIN()` |
| `platform/server/api/src/routes/catalog.js` | `listUrl` is a portal link |
| `platform/server/api/src/index.js` | `trust proxy` from `true` to an explicit hop count |
| `platform/server/docker-compose.yml` | new API env vars; `PUBLIC_URL` marked deprecated |
| `platform/server/.env.example` | the origin contract documented |
| `platform/server/api/test/origins.test.js` | new — 31 tests |
| `scripts/verify-release.mjs` | 3 R-01 exceptions **deleted**; bare-IP host check added |
| `test/verify-release.test.js` | blocker test now asserts the mechanism + an SEC-004 regression test |

**Tests:** API **1,122** passing (1,091 + 31). Root admin frontend **187** (186 + 1). 0 failing.
`git diff --check` clean. Free space 8.2 GB.

**AUTH-002 — closed.** Cookie security no longer derives from `PUBLIC_URL`:

```js
- const SECURE_COOKIES = /^https:/i.test(process.env.PUBLIC_URL || '');
+ const COOKIE_OPTS = COOKIE_OPTIONS;   // from src/origins.js
```

`COOKIE_SECURE` is explicit, defaults to secure in production, and disabling it in production is
refused unless `ALLOW_INSECURE_COOKIES=i-accept-plaintext-sessions` is *also* set. A test drives six
values of `PUBLIC_URL` — including it repointed at the public site — and asserts every one still
yields a `Secure` cookie.

**SEC-004 — closed.** All six ambiguous link sites now resolve explicitly. Every one turned out to be
a **portal or admin** destination; not one was a public-website link. The release gate's three R-01
exceptions were **deleted rather than muted**, and the scan now reports *"0 of them open release
blockers"*.

**Decisions**

- **`PUBLIC_URL` is deprecated, not removed.** It is still accepted as a fallback for
  `PORTAL_ORIGIN` — its current value *is* the portal, so honouring it is correct today — and every
  use logs a deprecation. Removing it outright would have broken an existing deployment for no
  security gain, since it no longer influences anything security-relevant.
- **`PUBLIC_SITE_ORIGIN` is optional for the API.** No API link points at the public website, so
  requiring it would make a running deployment refuse to start over a value it never uses.
  `publicSiteLink()` fails closed at the point of use instead.
- **`ADMIN_ORIGIN` defaults to `<PORTAL_ORIGIN>/admin`**, the current topology, and may carry a path
  so the admin panel can move to its own host without an application change.

**Defect found and fixed, not in the audit**

`app.set('trust proxy', true)` trusted **every** hop, so Express took `req.ip` from the left-most
`X-Forwarded-For` entry — a value the client fully controls. Any IP-keyed rate limit would have been
bypassable by varying one header per request. Now an explicit `TRUST_PROXY_HOPS`, default 1, matching
the approved single-proxy topology. **This was a prerequisite for Phase 2, not an extra.**

**Second finding, also new:** `docker-compose.yml` carried `${PUBLIC_URL:-http://209.46.125.226}` — a
bare production IP the host scan could not see, because it only matched hostnames. A **bare-routable-IP
check** was added to the scan (loopback and RFC-1918 excluded), and this occurrence is declared with a
reason rather than changed unattended.

**Unresolved limitations**

- Cookie behaviour is asserted at the contract level, not by observing a `Set-Cookie` header through
  real Caddy over HTTPS. That remains an RC verification step.
- `PUBLIC_URL` remains in the compose file and an existing server's `.env`. The deprecation is
  logged, not enforced.

**Next:** Phase 2 — authentication abuse controls.
