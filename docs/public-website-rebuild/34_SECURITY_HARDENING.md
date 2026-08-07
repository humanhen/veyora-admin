# 34 — Security Hardening

Implementation of the five approved security corrections from the production-standard audit, plus
three findings discovered during the work.

**Nothing was deployed.** No production system, VPS, live database or DNS was contacted. No
permission bootstrap was executed, no capability was granted to any real account, no branch was
merged or fast-forwarded, and nothing was pushed.

| | |
|---|---|
| Branch | `mathew/public-website-rebuild` |
| Starting commit | `77c65d5` |
| Findings closed | **AUTH-002 · AUTH-004 / SEC-011 · SEC-004 · SEC-002 · SEC-015** (+ REP-007) |
| New findings, fixed | proxy trust, OTP brute force, bare-IP default |
| Suites | API **1,229** · admin frontend **213** · web **466** |

---

## 1. What was wrong, in one line each

| Finding | The problem |
|---|---|
| **AUTH-002** | The `Secure` cookie flag was derived from `PUBLIC_URL`, a variable whose meaning changes at the public-site cutover. |
| **SEC-004** | Six links fell back to a hard-coded host that *becomes the public site* after that cutover. |
| **AUTH-004 / SEC-011** | Seven authentication endpoints had no attempt limit of any kind. |
| **SEC-002** | A `warehouse` login could write 17 of 18 administrative collections through one endpoint. |
| **SEC-015** | The audit log was one of those collections. |

---

## 2. AUTH-002 — cookie security is no longer a side effect

```js
- const SECURE_COOKIES = /^https:/i.test(process.env.PUBLIC_URL || '');
+ const COOKIE_OPTS = COOKIE_OPTIONS;   // from src/origins.js
```

`PUBLIC_URL` means *the portal* today. After the catch-all cutover it is the natural name for *the
public site*. Repointing it, unsetting it, or setting it without a scheme silently dropped `Secure`
from both session cookies — no error, no log line, no failing test.

**The rule now enforced: no security behaviour is derived from a variable that also names a
general-purpose link.**

`src/origins.js` is the single validated contract:

| Variable | Purpose | Required |
|---|---|---|
| `PORTAL_ORIGIN` | Where portal links point | **yes in production** (falls back to `PUBLIC_URL`, deprecated) |
| `PUBLIC_SITE_ORIGIN` | Where public-website links point | optional for the API — no API link goes there |
| `ADMIN_ORIGIN` | Where admin links point | defaults to `<PORTAL_ORIGIN>/admin` |
| `INTERNAL_API_ORIGIN` | Server-to-server only | optional; never rendered |
| `COOKIE_SECURE` | Session cookie `Secure` flag | defaults to **on in production** |
| `TRUST_PROXY_HOPS` | Reverse proxies in front of the API | defaults to **1** |

Validation rejects: non-http(s) schemes, embedded credentials, fragments, query strings, wildcard
hosts, unexpected paths where an origin must be origin-only, and contradictory combinations —
`COOKIE_SECURE` on with a plain-http portal is refused, because the cookie would never come back.

Disabling `Secure` in production requires a second variable spelled
`ALLOW_INSECURE_COOKIES=i-accept-plaintext-sessions`, so it is a decision rather than an accident.

The cookie keeps `httpOnly`, `sameSite: 'lax'` and **no `domain`**, so it stays host-only and is never
shared with a sibling subdomain. `lax` is the narrowest setting that works: the portal is reached by
following an emailed `/#/set-password/...` link, and `strict` would withhold the cookie on that
navigation.

---

## 3. New finding — `trust proxy` was `true`, and it broke rate limiting before it was written

```js
- app.set('trust proxy', true);
+ app.set('trust proxy', origins.trustProxyHops);   // default 1
```

`true` means *trust every hop*. Express then takes `req.ip` from the **left-most** `X-Forwarded-For`
entry — a value the client fully controls. Every IP-keyed limit in §4 would have been bypassable by
varying one header per request.

The approved topology has exactly one reverse proxy, so the hop count is 1. **This was a
prerequisite for the next phase, not an extra**, and it was not in the audit.

---

## 4. AUTH-004 / SEC-011 — bounded authentication abuse controls

| Policy | Per client | Per account | Window | Endpoints |
|---|---:|---:|---|---|
| `login` | 10 | 5 | 15 min | `/login` |
| `otp-verify` | 10 | **5** | 15 min | `/verify-activation-otp`, `/verify-forgot-otp` |
| `otp-request` | 5 | **3** | 15 min | `/request-activation-otp`, `/forgot-password` |
| `password-set` | 10 | — | 15 min | `/set-password`, `/reset-password` |

Every request counts against **both** the client address and a hashed account identifier, so one
source cannot spray many accounts and one account cannot be attacked from many sources.

### The sharpest risk was not the login endpoint

`/verify-activation-otp` and `/verify-forgot-otp` check a **six-digit code** with a 15-minute
lifetime, and `verifyOtp` counted nothing. 900,000 values, unthrottled: minutes of automated requests
to take over an account through password reset. It gets the strictest policy in the file — at 5
attempts per account per window, exhaustion is several orders of magnitude out of reach.

`/logout` is deliberately unlimited. It destroys a session rather than granting one; limiting it
would let an attacker keep a victim signed in.

### No enumeration signal, no PII

- Account keys are a **truncated SHA-256** of the normalised identifier. Enough to count against,
  useless to read.
- The 429 body is exactly `{ error, retryAfter }` with a `Retry-After` header — identical for every
  policy and every account state. A test drives two limiters with a real and a non-existent address
  and compares the responses byte for byte.
- The limiter logs nothing and never reads a password, token or secret.

### Bounded, and honest about its limits

Fixed-window counters, swept on every write, hard-capped at 20,000 keys with oldest-first eviction. A
test floods 5,000 distinct clients into a 50-key store and asserts the cap holds. *An unbounded
limiter is a memory-exhaustion bug wearing a security hat.*

**It is in-process, so it is correct for exactly one API container** — N containers allow N times the
rate and a restart clears the state. That is stated in the module header, in
`RATE_LIMIT_CONTRACT.storage`, and asserted by a test. Storage sits behind a three-method adapter
(`hit`, `reset`, `size`) and `rateLimit()` takes the store as a parameter, so a shared store is a
one-class replacement.

**Caddy-level limiting was reviewed and rejected as the primary control.** Caddy v2 has no built-in
rate limiting; it needs a third-party plugin and therefore a custom image, which this run cannot
introduce or test. Recorded as optional defence in depth.

---

## 5. SEC-004 — every ambiguous link, and where it actually belonged

Six sites read `PUBLIC_URL`. **Not one was a public-website link:**

| Site | Link | Destination |
|---|---|---|
| `authmw.js` | `/#/set-password/<token>` | portal |
| `emails.js` ×2 | `/#/order/<id>` | portal |
| `emails.js` ×2 | `/#/backorders` | portal |
| `emails.js` ×2 | `/admin/#/orders` | admin |
| `routes/catalog.js` | `/#/list/<slug>` | portal |

All fell back to `https://veyora.design`, which becomes the **public site** after cutover — so
password-reset, order and shared-list links already sitting in customers' inboxes would have landed
on a site with no such routes. That is R-01's breakage, stated precisely.

The release gate's three R-01 exceptions were **deleted, not muted**, and the scan now reports
*"0 of them open release blockers"*. The stale-exception rule is what surfaced it: when the fix
landed, the gate failed until the obsolete pins were removed.

---

## 6. SEC-002 — warehouse work has routes instead of a database editor

`POST /admin/sync` is a whole-database row editor over 18 collections. It admitted `warehouse` and
gated exactly one collection (`users`), leaving promotions, invoices, payments, credit notes,
shipping rules, `settings` — which carries the FX rates — and the audit log writable by a fulfilment
login.

**The sharpest case was not on that list.** Receiving stock went through the `products` collection,
and `upsertProduct` writes `price` and `sale_price` on the product *and every variation*. The same
request that received a delivery could re-price the entire catalogue.

### What warehouse staff actually need, and where it now lives

| Action | Path | Status |
|---|---|---|
| Fulfilment, collection, dispatch, tracking | `PATCH /admin/orders/:id` | already had a dedicated route |
| Backorder conversion | `POST /admin/backorders/:id/convert` | already existed |
| Reservation / release | automatic in ordering | not a manual action |
| **Receiving, count, damage, return, correction** | **`POST /admin/inventory/adjust`** | **new** |
| **Transfer between warehouses** | **`POST /admin/inventory/transfer`** | **new** |
| Prices, promotions, invoices, payments, settings, production status | generic sync | **admin-only** |

Both new routes name the fields they accept and reject the rest, take the actor from `req.user`, run
in a transaction, lock the stock rows, refuse to take a balance negative, and record a ledger
movement through the existing `recordMovement()`. Neither can touch a price, create or delete a
product, or alter anything a customer is billed for.

`POST /admin/sync` now refuses every non-admin **before the transaction opens**, refusing the whole
payload rather than filtering it, and names where warehouse work should go instead.

**Verified rather than changed:** order discounts were *already* admin-only via `patchTouchesMoney` +
`isFinancialActor`. A test now pins that so it is neither mistaken for a gap nor silently lost.

---

## 7. SEC-015 — the audit log is append-only

Three independent layers, any one sufficient:

1. **Database.** `audit_log_immutable()` raises on UPDATE and DELETE
   (`t_audit_log_no_update` / `t_audit_log_no_delete`). This **reuses the exact pattern
   `inventory_movements` has used since it was built** — one idea used twice, not a second mechanism.
2. **Collection map.** `audit` is *removed* from `SIMPLE_COLLECTIONS`, so the sync loop now answers
   "unknown collection".
3. **Endpoint.** `POST /admin/sync` is admin-only (§6).

`INSERT` is untouched, so `audit()` in `db.js` works exactly as before. The migration is entirely
non-destructive: no row modified, no column dropped, no type changed, nothing written. The `undone`
column stays — dropping a column is destructive — it simply can no longer be flipped.

**Corrections are compensating records, not mutations**, the same discipline the inventory ledger
already follows.

### The Undo control is gone (REP-007)

It never reverted anything. It set `undone = true` and inserted a row reading *"Reversed event
&lt;id&gt;"* while the action remained in force — **the log actively misstated what had happened**,
which is worse than a missing feature. It is now impossible as well as misleading.

A real undo belongs on the entity being undone, each writing its own new audit entry.

### Scope, stated honestly

A trigger cannot fire without PostgreSQL and this suite has none. The tests assert **definition** —
triggers in both the migration and the `ensureSchema` mirror, a function that raises rather than
swallowing, a non-destructive migration, no application path to an UPDATE or DELETE, and exactly two
reviewed writers that only ever append. **Proving the trigger fires is an RC verification step.**

---

## 8. Permission bootstrap — safeguards, and a planner that cannot execute

**No bootstrap was performed.** No capability is held by any account.

`19_ACCOUNT_PERMISSION_SYSTEM.md` §8 already described the procedure well. What was missing was a way
to check a *proposed* bootstrap before running it, so `src/bootstrap-plan.js` plus
`scripts/plan-permission-bootstrap.js` now do that.

It is **pure and structurally unable to reach a database**: no `pg`, no `db.js`, no `DATABASE_URL`,
no network client, and it refuses a URL as input. A test asserts every one of those.

Blocking findings: fewer than two resulting managers · a disabled or pending account · an unknown id
· a duplicated selection · an **ambiguous username**. Warnings: an account that looks shared
(`office`, `admin`, `info`, …), because every audit entry a shared login writes is unattributable.

The rendered SQL confirms the accounts first, grants inside a transaction, verifies in the same
session before committing, and carries the rollback statement — revoke, never delete, so the mistake
and its correction both stay on record. Only `permissions.manage` is ever granted.

---

## 9. Release-line safety

Recorded from [33](33_GIT_HISTORY_AND_RELEASE_LINE_DIAGNOSIS.md):

- the repository is **full-history**; the earlier "unrelated histories" finding was a shallow-clone
  artefact;
- `mathew/public-website-rebuild` is the engineering handover / release-candidate line;
- promotion of `main` remains an authorised, supervised action;
- promotion **must use `--ff-only`**, and **`--allow-unrelated-histories` must never be used**;
- **`deploy.sh` packages the checked-out working tree and is not branch-bound.**

A new `release-branch` gate makes that last point visible. It refuses a detached HEAD outright,
refuses a non-approved branch unless `VEYORA_RELEASE_BRANCH_OVERRIDE` names it explicitly, reports
uncommitted changes because the deploy would ship them, and **claims no environment binding that
does not exist**. It never pushes, merges or deploys.

---

## 10. What is still outstanding

1. ~~**The admin panel needs a matching UI change.**~~ **CLOSED 2026-08-07 — see §11.** Access is now
   server-derived, the two legitimate stock workflows use the narrow routes, and the infinite 403
   retry loop is gone.
2. **Cookie behaviour is asserted at the contract level**, not by observing a `Set-Cookie` header
   through real Caddy over HTTPS. RC verification.
3. **The audit triggers are asserted as defined, not as firing.** RC verification against a
   disposable database.
4. **The rate limiter is single-container.** A second API instance needs a shared store.
5. **The public enquiry forms keep their own separate throttle.** Unifying them is follow-up.
6. **`PUBLIC_URL` still exists** in compose and on the server. Deprecated and logged, not enforced.
7. **Production status still moves through the generic sync**, so it is admin-only. If warehouse
   staff need it, it wants its own narrow route rather than a widened gate.
8. **The bootstrap itself has not been run**, and remains the blocker gating every governed screen.

---

## 11. Warehouse interface correction — 2026-08-07

§10.1 recorded that the admin panel needed a matching UI change. This closes it.

### The regression, precisely

The panel is a **whole-database editor**: every screen mutates a local snapshot and calls `DB.save()`,
which debounces into one `POST /admin/sync`. That endpoint became admin-only in §6, so a warehouse
login got a 403 on save — and `pushSync`'s catch re-armed `save()` **every five seconds, forever**,
with a toast each time. An endless failure loop, not a one-off error.

### Server-derived action discovery, not scattered role checks

`GET /admin/access` returns what this session may do, derived from the **same constants the routes
enforce with** (`src/admin-access.js`). The alternative — `role === 'warehouse'` in nine page files —
drifts from the server and teaches the next contributor that the browser decides authority.

| Action | admin | warehouse |
|---|---|---|
| `sync.write` | ✅ | ❌ |
| `inventory.adjust`, `inventory.transfer` | ✅ | ✅ |
| `orders.fulfil`, `backorders.convert` | ✅ | ✅ |
| `orders.money`, `users.manage`, `catalogue.edit`, `settings.edit`, `finance.manage`, `imports.run` | ✅ | ❌ |

It **grants nothing** — it is a read of what the caller could already do. An unknown role, a
non-active account or a failed request all yield an empty action set: hiding a control rather than
showing one that is broken.

### Workflows preserved

| Workflow | Path | State |
|---|---|---|
| Fulfilment, collection, dispatch, tracking | `PATCH /admin/orders/:id` | already dedicated, untouched |
| Backorder conversion | `POST /admin/backorders/:id/convert` | already dedicated, untouched |
| **Stock count / correction** | `POST /admin/inventory/adjust` | **rewired** from the generic sync |
| **Warehouse transfer** | `POST /admin/inventory/transfer` | **rewired**, one atomic call per SKU |
| Reading orders, backorders, stock, products, reports, audit | `GET` routes | kept — reading is legitimate |

The stock editor now sends a **signed delta** rather than an absolute quantity, and adopts the
server's returned figure rather than the one the operator typed — if another movement landed in
between, the screen shows the truth. The `shelf` field is read-only, because shelf is not part of the
narrow contract and silently discarding it would be worse than not offering it.

Transfers report **per SKU**: one may move before another runs short, and *"3 moved, 2 did not and
why"* is the useful answer where *"transfer failed"* would hide work that actually happened.

### Removed from the warehouse view

Product edit (prices and identity), warehouse management, Users, Leads, Chains, Suitcases, Email
templates, Tasks, Promotions, Returns, Spare parts, Production, Purchasing, all three CSV/import
screens, all four Finance screens, Shipping settings, Free shipping, Agent revenue.

### Two defects fixed on the way

1. **The infinite 403 retry.** A 403 is a decision, not a transient failure. The client now records
   that this session cannot sync, shows one honest message, and stops. A new **"View only"** badge
   state replaces "Save failed", which would have sent someone looking for a fault.
2. **Double submission.** The stock save relied on `disabled`, which stops a mouse click but not a
   second Enter racing the first. It now uses an in-flight flag.

### Scope discipline

`inventory-csv` (bulk set/adjust) stayed **admin-only** rather than being rewired: its `set` mode has
no equivalent in the narrow contract, which is delta-only. Inventing a bulk endpoint to populate a
screen was not warranted.

**The backend restriction is unchanged.** A test asserts `POST /admin/sync` still refuses every
non-admin, and another asserts the client never fabricates an action.


---

## Update — Final Handover

### A defect introduced by this batch, found and fixed in Phase 7

The narrow inventory routes added here call `recordMovement()` with **snake_case** keys
(`variation_id`, `warehouse_id`, `ref_type`, `ref_id`) while `inventory.js` reads
**camelCase**. Every adjustment and transfer since therefore wrote `variation_id = NULL` and
`warehouse_id = NULL`.

The row existed; it could not be attributed to a variation or a warehouse — which is precisely what
you would need in order to *detect* a duplicated adjustment after the fact. Fixed in Phase 7, with a
test asserting the ledger records the variation, warehouse, SKU, reference type and balance.

Recorded here rather than only in the Phase 7 document because this is where it came from.

### Security work added since

| Area | Where |
|---|---|
| Payment settlement authority — only a verified webhook may mark an invoice paid | `38_STRIPE_PAYMENT_ARCHITECTURE.md` §3 |
| Financial mutation governance — the row-diff sync can no longer write money | `41_FINANCE_OPERATIONS.md` §2 |
| Duplicate-submission guards across eighteen mutation paths | `42_DUPLICATE_SUBMISSION_SWEEP.md` |
| Document access control — ownership as a SQL predicate, 404 rather than 403 | `39_INVOICE_AND_STATEMENT_SYSTEM.md` §4 |

The trust-proxy, rate-limiting, origin and cookie work described above is unchanged and still holds;
the Phase 9 security sweep re-verified each.
