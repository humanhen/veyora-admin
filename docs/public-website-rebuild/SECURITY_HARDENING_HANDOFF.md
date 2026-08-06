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
| 2 — Authentication abuse controls | complete | `fix: add bounded authentication rate limiting` |
| 3 — Warehouse sync writes | complete | `fix: replace broad warehouse sync writes` |
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

### Phase 2 — complete

**Files changed**

| Path | Change |
|---|---|
| `platform/server/api/src/rate-limit.js` | new — bounded limiter behind a store adapter |
| `platform/server/api/src/routes/auth.js` | 7 of 8 endpoints limited |
| `platform/server/api/test/rate-limit.test.js` | new — 28 tests |

**Tests:** API **1,150** passing (1,122 + 28), 0 failing. `git diff --check` clean. Free space 8.2 GB.

**Policies**

| Policy | Per client | Per account | Window | Applies to |
|---|---:|---:|---|---|
| `login` | 10 | 5 | 15 min | `/login` |
| `otp-verify` | 10 | **5** | 15 min | `/verify-activation-otp`, `/verify-forgot-otp` |
| `otp-request` | 5 | **3** | 15 min | `/request-activation-otp`, `/forgot-password` |
| `password-set` | 10 | — | 15 min | `/set-password`, `/reset-password` |

Each request is counted against **both** its client address and, where the body names one, a hashed
account identifier — so one source cannot spray many accounts, and one account cannot be attacked
from many sources.

**`/logout` is deliberately unlimited.** It destroys a session rather than granting one; limiting it
would let an attacker keep a victim signed in.

**Why `otp-verify` is the strictest.** A six-digit code is 900,000 values with a 15-minute lifetime.
At 5 attempts per account per 15 minutes, an exhaustive search is impossible by several orders of
magnitude. Before this phase there was **no attempt limit at all** on either verifier — the sharpest
unauthenticated risk in the platform, and only implicit in the audit's AUTH-004.

**No enumeration signal, no PII**

- Account keys are a truncated SHA-256 of the normalised identifier. Enough to count against, useless
  to read. A test asserts no `@` and no fragment of the address survives.
- The 429 body is exactly `{ error, retryAfter }` — identical for every policy and every account
  state, asserted by driving two limiters with a real and a non-existent address and comparing the
  responses byte for byte.
- The limiter logs nothing, and never reads a password, a token or a secret. Asserted against
  credential *access* patterns rather than the word, since `passwordSet` is a policy name.

**Bounded storage**

Fixed-window counters in a `Map`, expired entries swept on every write, and a hard cap of 20,000 keys
with oldest-first eviction. A test floods 5,000 distinct clients into a 50-key store and asserts it
never exceeds the cap. *An unbounded limiter is a memory-exhaustion bug wearing a security hat.*

**Documented limitations**

- **In-process, single-container only.** N API containers would allow N times the rate, and a restart
  clears the state. Stated in the module header, in `RATE_LIMIT_CONTRACT.storage`, and asserted by a
  test so it cannot be quietly forgotten.
- Storage sits behind a three-method adapter (`hit`, `reset`, `size`) and `rateLimit()` takes the
  store as a parameter, so a shared store is a one-class replacement.

**Caddy-level limiting reviewed and rejected as the primary control**

Caddy v2 has **no built-in rate limiting**; it needs the third-party `caddy-ratelimit` plugin, which
means replacing `caddy:2-alpine` with a custom build. That is a new Docker image, which this run is
barred from introducing, and it could not be tested here. Recorded as an optional future
defence-in-depth layer — **not** relied upon, which is why the application-level control exists.

**Depends on Phase 1.** These limits are only meaningful because `trust proxy` is now an explicit hop
count. Under the previous `true`, `req.ip` came from a client-controlled header and every limit here
would have been decorative. A test asserts the setting the limiter depends on.

**Unresolved limitations**

- The public enquiry forms keep their own separate in-process throttle. Unifying them is follow-up
  work, not a regression.
- No limit is applied to session refresh inside `requireAuth`; it requires an existing valid refresh
  token, so it is not an unauthenticated guessing surface.

**Next:** Phase 3 — remove warehouse access to generic admin writes.

### Phase 3 — complete

**Files changed**

| Path | Change |
|---|---|
| `platform/server/api/src/routes/admin-inventory.js` | new — narrow warehouse operations |
| `platform/server/api/src/routes/admin.js` | generic sync now refuses every non-admin |
| `platform/server/api/src/index.js` | new router mounted before the general `/admin` |
| `platform/server/api/test/warehouse-boundary.test.js` | new — 27 tests |

**Tests:** API **1,177** passing (1,150 + 27), 0 failing. Free space 8.2 GB.

**Warehouse workflow classification**

| Action | Path | Classification |
|---|---|---|
| Order fulfilment, item collection, dispatch, tracking | `PATCH /admin/orders/:id` | **already supported by a dedicated route** |
| Backorder conversion | `POST /admin/backorders/:id/convert` | already supported |
| Reservation / release | automatic in the ordering path | already supported, not a manual action |
| Reads — orders, backorders, movements, reconciliation | existing `GET` routes | kept, separately controlled |
| **Inventory receiving** | *was* generic sync → `products` | **new narrow route** `POST /admin/inventory/adjust` |
| **Stock adjustment, count, damage, return** | *was* generic sync → `products` | **same new route**, closed reason set |
| **Transfer between warehouses** | *was* generic sync → `products` | **new narrow route** `POST /admin/inventory/transfer` |
| Production status, returns, spare parts, prices, promotions, invoices, payments, settings | generic sync | **admin-only** |

**The sharpest case, and it was not in the audit's wording**

Receiving stock went through the `products` collection, and `upsertProduct` writes `price` and
`sale_price` on the product *and every variation*. **The same request that received a delivery could
re-price the entire catalogue**, with nothing in the payload distinguishing the two intents.

**What changed**

`POST /admin/sync` now refuses any caller whose role is not `admin`, **before the transaction opens**,
with a message naming where warehouse work should go instead. The whole payload is refused rather
than filtered — a partial write would tell the caller its stock change was rejected while its other
changes had already landed. The pre-existing per-collection `users` check is kept as defence in
depth.

**The new routes**

`POST /admin/inventory/adjust` — SKU, warehouse, integer delta, reason from a closed set
(`receipt`, `count`, `damage`, `return`, `correction`), optional note. Locks the stock row, refuses
to take a balance negative, records a ledger movement, audits.

`POST /admin/inventory/transfer` — atomic two-legged move; locks both warehouses **in a stable
order** so opposing transfers cannot deadlock; refuses on insufficient stock and rolls back.

Both take the actor from `req.user`, reject unknown request fields rather than ignoring them, and
write exactly one table directly (`stock`), delegating the ledger to the existing `recordMovement()`
rather than a second hand-rolled `INSERT` that could drift.

**A real gap found while testing:** the schemas accepted a numeric *string* — `Number('5')` is 5 — so
`{"delta": "5"}` passed. Now strictly typed, because an explicit request schema means explicit types
and a client sending a string has a misunderstanding worth surfacing.

**Verified rather than changed**

Order discounts were **already** admin-only via `patchTouchesMoney` + `isFinancialActor`. A test now
pins that so it is not mistaken for a gap, and not silently lost.

**Unresolved limitations**

- The admin panel's frontend still assumes it can sync every collection. A warehouse login will now
  receive a 403 from `POST /admin/sync`; **the panel needs a matching UI change** so warehouse users
  see the inventory screens rather than a failed save. Recorded as follow-up — it is a usability
  regression for that role, not a security one.
- Production status still moves through the generic sync, so it is admin-only for now. If warehouse
  staff need it, it wants its own narrow route rather than a widened gate.

**Next:** Phase 4 — append-only audit history.
