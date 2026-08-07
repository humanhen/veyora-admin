# 31 — Release Candidate Readiness

The state of the public website rebuild at the end of Fast-Track Workstream 2, what is verified, and
everything that stands between here and a release.

**Nothing was deployed.** No production system, VPS, live database or DNS was contacted at any point
in this workstream. No capability was granted to any real account, no real content was published, no
real catalogue data was processed, nothing was pushed, and nothing was merged.

---

## 1. Verdict

**The software is ready for a supervised release candidate. It is not ready to be released.**

Everything that can be built and verified without production access is built and verified. Everything
that remains needs one of five things this run is barred from having: real data, an account decision,
release infrastructure, a business or legal fact, or a supervised merge. Those are §4's five
categories, and they are the whole of the gap.

The single most important thing to understand before reading further: **the public website has never
run anywhere.** Until Phase 1 it was not even a service in Compose. Every statement below about it
being correct is a statement about tests, not about a deployment.

---

## 2. Full regression

`node scripts/verify-release.mjs` — **16 / 16 gates pass in 164 seconds.**

| Gate | Result |
|---|---|
| `diff-check` | PASS |
| `merge-markers` | PASS — 329 tracked files |
| `secret-and-host-scan` | PASS — 136 shipped artefacts, 11 declared exceptions, **3 open R-01 blockers reported** |
| `api-suite` | PASS — **1,091** passing |
| `admin-frontend-suite` | PASS — **186** passing |
| `web-suite` | PASS — **466** passing |
| `deployment-config` | PASS |
| `forbidden-data` | PASS |
| `forbidden-data-rendered` | PASS |
| `json-ld` | PASS |
| `accessibility-responsive` | PASS — 30 page/viewport audits |
| `env-validation` | PASS — 5 environment cases |
| `astro-build` | PASS |
| `build-output-scan` | PASS — 61 built files |
| `catalogue-chain` | PASS — no SQL, no database |
| `deploy-payload` | PASS — 17 entries, cutover still opt-in |

**1,743 automated tests passing, 0 failing**, across three suites.

Growth this workstream: API 998 → 1,091 (+93), root admin frontend 141 → 186 (+45), Astro web
435 → 466 (+31).

---

## 3. Security sweep

Performed by reading the code, not by running a scanner. Each item states what was checked and what
was found.

### 3.1 Authorisation — clean

Every router's gate was enumerated:

| Router | Gate |
|---|---|
| `/admin/account-permissions` | `requireAuth()` + `requirePermission('permissions.manage')` |
| `/admin/public-content` | `requireAuth()` + per-route capability (`view` / `edit` / `publish`) |
| `/admin/enquiries` | `requireAuth()` + per-route capability (`enquiries.view` / `enquiries.manage`) |
| `/admin` (general) | `requireAuth('admin', 'warehouse')` |
| `/user/*` | `requireAuth()` |
| `/public/*` | none — unauthenticated **read-only** boundary |
| `/forms/*` | none — unauthenticated by design, POST only, 32 kb limit |

The three capability-gated routers are mounted **before** the general `/admin` router, so the broader
role check cannot admit someone the capability gate would refuse. No role satisfies a capability
anywhere; there is no wildcard, no prefix matching and no `permission_key LIKE`.

### 3.2 The public read boundary — clean

`routes/public.js` contains **no `POST`, `PUT`, `PATCH` or `DELETE`** — asserted by test. It cannot
reach `form_submissions`, `account_permissions` or any handling column. The enquiry API added this
workstream is authenticated and capability-gated, and its list serializer deliberately omits the
message body and the email address.

### 3.3 SQL injection — clean

Every template-literal interpolation into a query string was traced to its origin:

| Site | Interpolated value | Source |
|---|---|---|
| `admin-public-content.js:343` | `meta.table`, `extraSets` | entity map + editable-field allowlist, both code constants |
| `admin.js:340,350,803` | `cfg.table`, `name` | `SIMPLE_COLLECTIONS`, a static literal map in `shape.js` |
| `admin.js:468` | `sets.join()` | `orderUpdateSql()` — hard-coded column names, values parameterised |
| `admin.js:645` | `prefix`, `seqName` | string literals or the same static map |

**No user-controlled identifier reaches SQL anywhere.** Every value is parameterised.

### 3.4 Dynamic execution — clean

No `eval`, no `new Function`, no `child_process` in the shipped API source. (`child_process` appears
only in tests and in `scripts/verify-release.mjs`, neither of which is deployed.)

### 3.5 Cross-site scripting — clean

Every `innerHTML` assignment in the admin panel was inspected. Each is either a constant (an icon, a
fixed denied-state string) or a template in which every interpolated value passes through `esc()`.
The new Enquiries screen renders enquirer-submitted free text, and a test submits
`<img src=x onerror=…>` and asserts it survives as text and produces no element.

### 3.6 CSRF — verified end to end

Astro's `checkOrigin` middleware guards the form POSTs, and `security.allowedDomains` is derived from
`PUBLIC_SITE_ORIGIN`. This was verified **through a reverse proxy reproducing Caddy's real header
contract**, not by reading configuration
([24_PUBLIC_ENQUIRY_FORMS.md](24_PUBLIC_ENQUIRY_FORMS.md) §10). A test asserts no `header_up Host`
appears in either Caddyfile, because rewriting `Host` to the container name would make Astro compute
`http://web:4321` as its origin and 403 every submission.

### 3.7 Session handling — one finding

`httpOnly: true`, `sameSite: 'lax'`, 30-minute access token, 30-day refresh, bcrypt cost 10, and
`JWT_SECRET` required at startup (the process refuses to boot without it). All sound.

**Finding — the `Secure` cookie flag is derived from `PUBLIC_URL`:**

```js
const SECURE_COOKIES = /^https:/i.test(process.env.PUBLIC_URL || '');
```

`PUBLIC_URL` currently means the portal. **The R-01 cutover changes what that variable refers to**, and
if it is repointed at the public site, unset, or set without a scheme, **the authentication cookies
silently lose the `Secure` flag** — no error, no log line, just cookies that will travel over plain
HTTP. This is the same variable family as the three pinned R-01 link fallbacks, and it should be
handled in the same change. Recorded as **C-06**.

### 3.8 Dependency surface — small, and unaudited

| Package | Dependencies |
|---|---|
| API | `bcryptjs`, `cookie-parser`, `csv-parse`, `express`, `jsonwebtoken`, `multer`, `nodemailer`, `pg` |
| Astro site | `astro`, `@astrojs/node` |
| Admin panel | **none** — no `package.json`, no build step |

Ten runtime dependencies in total and no dev dependencies anywhere. **Zero dependencies were added by
this workstream** — including the headless-browser QA in Phase 4, which uses Chrome's DevTools
Protocol over Node's global `WebSocket`.

**No vulnerability audit was run.** `npm audit` contacts the registry, and this run stays offline.
Recorded as **C-11**.

### 3.9 Abuse controls — known-weak, by design and by record

The enquiry-form throttle is in-process and in-memory: N containers allow N times the rate, a restart
clears it, and it keys on a client address an attacker varies. It is documented as a mitigation
against casual abuse, **not a security control**. A real rate limit belongs at the edge. Recorded as
**C-13**.

The honeypot returns the same response a real submission gets, so a bot cannot learn it was detected.
Nothing logs a field value anywhere in the enquiry path.

---

## 4. Release blocker register

Nothing here is a defect in the software. Each is a decision or an action that cannot be taken from a
development machine with no production access.

### Category A — needs real data

| # | Blocker | Consequence if ignored |
|---|---|---|
| A-01 | **No content is published.** Every governance table is empty and every product is unpublished. | The public site serves empty listings. It is correct and it has nothing to show. |
| A-02 | **No forbidden-data scan has run against a real row.** All four surfaces are proven against adversarial fixtures. | R-06 cannot close. A field that exists in production but in no fixture is invisible to every scan. |
| A-03 | **The catalogue backfill has not been run.** The audit → review → plan chain exists and is tested; no real export has been processed. | Nothing can be published until the catalogue is ready. |
| A-04 | **Migration `0009` has never executed.** No disposable-PostgreSQL rehearsal. | A migration failure would surface first on the RC host. |
| A-05 | **The storefront branch's brand-filter change is unvalidated.** It inverts category-vs-column precedence on an authenticated revenue route. | Wrong products under a brand chip for every customer. |
| A-06 | **All rendering and accessibility QA used mock fixtures.** Long brand names, missing images and unusual characters are absent. | Layout defects that only real content produces. |

### Category B — needs an account decision

| # | Blocker | Consequence if ignored |
|---|---|---|
| B-01 | **No account holds any capability.** The `permissions.manage` bootstrap ([19](19_ACCOUNT_PERMISSION_SYSTEM.md) §8) has never been performed. | **Every governed admin screen is unreachable by every account, including every existing administrator.** Nothing can be reviewed, edited, published or read. |
| B-02 | **Who may hold `enquiries.view` / `enquiries.manage`.** These disclose members of the public's names, email addresses and messages. | Either nobody can read enquiries, or the wrong people can. |
| B-03 | **Who may hold `public_content.publish`.** | Either nothing reaches the public site, or unreviewed copy does. |

### Category C — needs release infrastructure

| # | Blocker | Consequence if ignored |
|---|---|---|
| C-01 | **There is no CI.** `verify-release.mjs` is the command a gate would run; nothing runs it. | R-06 stays open. A failing change can be merged. |
| C-02 | **`docker compose config` and `caddy validate` have never run** — neither tool is installed here. All deployment checks are static. | A syntax error the tools would reject reaches the RC host. |
| C-03 | **RC deployment to a staging host**, with the current storefront preserved. | The web service has never started anywhere. |
| C-04 | **HTTPS form smoke test through real Caddy.** The local proxy reproduces the header contract; it is not Caddy. | Forms 403 in production, having passed every test. |
| C-05 | **Rollback test** — perform the cutover, then roll back, and confirm the storefront returns. | Rollback is documented and unproven. |
| C-06 | **R-01 consequences.** `authmw.js`, `emails.js` and `routes/catalog.js` all fall back to `https://veyora.design`, which **becomes the public site** after the cutover; and `SECURE_COOKIES` derives from the same `PUBLIC_URL` (§3.7). | Password-reset and shared-list links already in customers' inboxes 404; auth cookies can silently lose `Secure`. |
| C-07 | **DNS for `PORTAL_DOMAIN` must resolve to the host before cutover.** | The portal becomes unreachable the moment it moves. |
| C-08 | **Enquiry retention deletion is not implemented.** Metadata says when a record is due; nothing removes it. | Personal data is retained past its stated period. |
| C-09 | **Enquiry onward delivery is not built.** Every submission stays `delivery_state = 'pending'`. | Nobody is notified; enquiries are found only by opening the new screen. |
| C-10 | **Two unrelated git histories.** This branch shares no ancestor with `main`. | Landing it is not an ordinary pull request and needs a deliberate plan. |
| C-11 | **No dependency vulnerability audit.** | A known CVE in one of ten packages ships unnoticed. |
| C-12 | **The form throttle is per-process and in-memory** (§3.9). | No effective rate limit on the only unauthenticated write endpoint. |

### Category D — needs a business or legal fact

| # | Blocker | Consequence if ignored |
|---|---|---|
| D-01 | **Font licensing.** The storefront branch self-hosts two commercial "Chromatic Pro" TTFs (98 KB) served from the admin panel. | Shipping a typeface without a web-embedding licence. |
| D-02 | **Three accessibility findings are design decisions** ([29](29_ACCESSIBILITY_AND_RESPONSIVE_QA.md) §5): footer tap targets under 24×24, 183 occurrences of 4.06:1 / 2.65:1 contrast from one 42%-alpha token, and 363 micro labels between 10 and 12px. | Known WCAG 2.2 AA failures ship, on a site whose own accessibility statement is a published page. |
| D-03 | **Three social-media links** to `veyora.vision` profiles need confirming as the right, live accounts. | The storefront links to a wrong or dormant profile. |
| D-04 | **21 blocking content placeholders** remain (R-04, [08](08_RISKS_AND_OPEN_DECISIONS.md)). | Placeholder copy on a public, indexed site. |
| D-05 | **The development placeholder notice must not ship.** It is also the worst contrast finding at 2.65:1. | "Development placeholder — B1.2" visible to the public. |
| D-06 | **Enquiry retention period and consent wording.** 365 days is a code default; `forms` is unseeded; consent version `2026-08-enquiry-v1` has not been reviewed by whoever owns privacy. | A privacy commitment nobody approved. |
| D-07 | **`SMTP_FROM` sender identity** is a hard-coded fallback in `docker-compose.yml` and `mail.js`. | Deliberately untouched; changing it unattended could alter live transactional email. |

### Category E — needs a supervised integration

| # | Action | Notes |
|---|---|---|
| E-01 | **Merge `feat/storefront-catalog-ux-and-homepage`.** Verified clean; only `index.html` and `css/styles.css` overlap. | Gated on D-01, A-05, D-03. See [30](30_STOREFRONT_FIX_INTEGRATION.md). |
| E-02 | **Do not merge `fix/storefront-catalog-thumb-selection`** — superseded, and it shares no ancestor with this branch. | |
| E-03 | **Fix the cache-buster inconsistency after the merge**: the stylesheet moves to `?v=8` while every script stays at `?v=7`. | Otherwise the new Enquiries screen ships behind a cache. |
| E-04 | **Re-run `api-suite` and `admin-frontend-suite` after the merge.** `admin-shell.test.js` asserts the exact script list in `index.html`. | |
| E-05 | **Manual accessibility pass**: screen reader, keyboard walkthrough, focus visibility, alt-text quality, real devices, zoom and reflow. | Automated checking finds about a third of WCAG issues ([29](29_ACCESSIBILITY_AND_RESPONSIVE_QA.md) §7). |
| E-06 | **Fix `maximum-scale=1.0` in the admin panel's viewport meta** — it disables pinch-zoom (WCAG 1.4.4). Pre-existing, outside Phase 4's public-site scope. | One attribute. |
| E-07 | **The cutover itself**: set `CADDYFILE=./Caddyfile.rc`, verify, and be ready to roll back. | Gated on C-03 → C-07. |

### The two that matter most

**B-01** and **C-03**. Until the first `permissions.manage` grant exists, no governed screen works for
anyone; until the stack has run somewhere, everything else is a claim about tests. Nothing else in
this register can be usefully sequenced before those two.

---

## 5. What this workstream delivered

| Phase | Delivered |
|---|---|
| 1 | The public site became **deployable at all** — a `web` service in Compose, health-gated startup, an API healthcheck that proves database reachability, a deploy script that preflights both local artefacts and the remote environment, and an **opt-in** RC routing topology that leaves the live `Caddyfile` untouched. |
| 2 | **Governed enquiry operations** — two new least-privilege capabilities, an additive migration mirrored in `ensureSchema()`, a four-route admin API that cannot delete or edit a submission, and an Enquiries screen. Submissions had been stored and unreadable since the forms shipped. |
| 3 | **One release-verification command**, 16 gates, non-zero on failure, no production contact, portable. It found a real defect on its first run. |
| 4 | **Accessibility and responsive QA in a real browser** at 375/768/1280 — 30 audits, 17 rules — with **no dependency added**. |
| 5 | **A storefront integration report** identifying the branch by content, verifying the merge, and surfacing that the repository has two unrelated histories. |
| 6 | This document. |

### Defects found and fixed

1. **`src/env.ts` accepted a wildcard hostname.** `new URL('https://*.example.com')` parses happily.
   `astro.config.mjs` refused one — but at **build** time, so a container starting from an
   already-built image with a wildcard origin passed validation and would have emitted canonical URLs
   containing a literal `*`. Found by the `env-validation` gate on its first run.
2. **The web service was absent from Compose and from the deploy payload.** The public site had never
   been deployable.
3. **`api` had no healthcheck**, so `depends_on: api` meant only that the process had launched.
4. **My own contrast check silently skipped 62% of the site's text** and reported the remaining 38%
   as a passing audit. Alpha-compositing took it to 100% and immediately surfaced real WCAG 1.4.3
   failures.
5. **My own headless-browser driver leaked processes.** `child.kill()` signals the launcher; Chrome's
   crashpad handler, network service and renderers survive it. Repeated runs left **199 orphaned
   processes holding about 3.6 GB** — on a laptop this run had to keep above 4 GB free. Fixed with a
   graceful `Browser.close`, a process-tree kill as fallback, and a stale-profile sweep at launch so a
   leak self-heals ([29](29_ACCESSIBILITY_AND_RESPONSIVE_QA.md) §8.1). Verified: zero orphans, free
   space stable.

### Findings that were reported rather than fixed

Each is pinned by a test that fails on anything new *and* on any pin that stops matching, so the lists
can only shrink deliberately:

- **11 production-hostname occurrences**, 3 of them R-01 blockers (C-06).
- **Three accessibility findings** (D-02).
- **The `SECURE_COOKIES` derivation** (§3.7, C-06).

---

## 6. Risk register movement

| Risk | Before | After | Why |
|---|---|---|---|
| **R-06** Public data leak | L3 × I4 = 12 | **L2 × I4 = 8** | One command now runs every scan with a per-control verdict. Still open: no CI, and no scan has run against a real row. |
| R-01 Portal URL change | 20 | unchanged | Its three consequences are now *surfaced on every verification run* rather than described in a paragraph — but none is fixed. |
| R-02 Caddy reordering | 15 | unchanged | The RC topology exists and is opt-in, so the risk is now armed deliberately rather than by a deploy. Not reduced: the switch itself is untested. |
| R-07 Visual drift | 12 | unchanged | Deliberately: three accessibility findings were left as design decisions rather than being fixed unattended. |
| R-11 Accessibility gaps | unchanged | | Now measured rather than assumed, with the gaps named. |

---

## 7. Honest limitations of this entire workstream

1. **Nothing ran against a database.** Every handler test uses a controlled double.
2. **Nothing ran against production, a VPS or real DNS.**
3. **`docker` and `caddy` are not installed here**, so all deployment verification is static.
4. **Every rendered surface was produced from mock fixtures.**
5. **The browser QA is Chrome-only and headless.** Safari and Firefox are unexercised.
6. **No real enquiry, no real catalogue row and no real account was touched.**
7. **Nothing was pushed or merged.** Six local checkpoint commits sit on
   `mathew/public-website-rebuild`, ahead of `origin`.

Where a claim in this document rests on a test rather than an observation, it says so. That
distinction is the most useful thing here: **1,743 passing tests are evidence that the software does
what it was built to do, and no evidence at all that it works in production** — because it has never
been there.

---

## 11. Security Hardening update — 2026-08-06

Five of the open security findings in §6 are **closed**, plus one reporting defect. Detail:
[34_SECURITY_HARDENING.md](34_SECURITY_HARDENING.md).

| ID | §6 said | Now |
|---|---|---|
| **SEC-011 / AUTH-004** | P0 — no rate limiting on authentication | **Closed.** Bounded per-client and per-account limits on all seven sensitive endpoints |
| **AUTH-002** | P0 — `Secure` flag derived from `PUBLIC_URL` | **Closed.** Explicit `COOKIE_SECURE`, secure by default in production |
| **SEC-004** | P0 — three R-01 link fallbacks | **Closed.** Six sites use the explicit origin contract; the gate reports zero open blockers |
| **SEC-002** | P0 — warehouse writes 17 of 18 collections | **Closed.** Sync is admin-only; narrow inventory routes replace it |
| **SEC-015** | P1 — audit log editable by the audited party | **Closed.** Append-only triggers plus removal from the syncable set |
| **REP-007** | P1 — Undo control misstates the log | **Closed.** Removed |

**Still open from §6, unchanged:** `SEC-007` (CSRF defence in depth), `SEC-010` (CSP), `SEC-013`
(dependency audit), `SEC-016` (open-redirect confirmation), `SEC-017`/`MED-002` (upload content
verification).

### Three findings not in the audit, found and fixed

`trust proxy` was `true`, so `req.ip` came from a client-controlled header — which would have made
every rate limit decorative. Unthrottled six-digit OTP verification, a sharper account-takeover path
than the login endpoint. And a bare production IP in the compose default that the host scan could not
see; the scan now detects bare routable IPv4 addresses.

### The verdict is unchanged

**Still ready for a supervised release candidate; still not ready to be released.** §1's five groups
stand. This workstream emptied group 4 (*"a small number of real security gaps"*) and touched nothing
in the other four.

**The two that gate everything else are also unchanged:** `B-01` (no account holds any capability)
and `C-03` (the stack has never run anywhere).

### New RC verification steps

- Observe a real `Set-Cookie` through Caddy over HTTPS and confirm `Secure`, `HttpOnly` and
  `SameSite`.
- Prove the `audit_log` triggers actually fire against a disposable PostgreSQL — they are asserted as
  *defined*, not as *firing*.
- Exercise the rate limits against the deployed API and confirm `Retry-After` behaviour behind Caddy.

### New follow-up

A warehouse login now receives a 403 from `POST /admin/sync`. **The admin panel needs a matching UI
change** so those users see the inventory screens rather than a failed save — a usability regression
for that role, not a security one.

### Warehouse interface follow-up — closed 2026-08-07

§11's new follow-up is done. The admin panel now derives permitted actions from `GET /admin/access`
rather than inferring them from the session role, the two legitimate warehouse stock workflows use
the narrow `/admin/inventory` routes, and the infinite 403 retry loop is gone.

**The backend restriction is unchanged** — `POST /admin/sync` still refuses every non-admin, asserted
by test.

Suites: API **1,229** · admin frontend **213** · web **466**. All **17** gates pass.

**One new RC verification step:** exercise a real warehouse login end to end against the deployed
stack — receive stock, transfer between warehouses, fulfil an order — and confirm no screen produces
a failed save. The workflows are proven against controlled doubles, not against a running system.


---

## Update — Final Handover

This document described the state at the end of Fast-Track Workstream 2. Seven further
implementation phases have since completed. The readiness position has changed as follows.

### Closed since this was written

| Item | Now |
|---|---|
| Enquiries went nowhere | A durable outbox delivers them, with visible per-attempt state |
| No customer-contact model | `customer_contacts`, governed, with a non-mutating migration planner |
| No payment capability | Stripe test-mode architecture, settlement only by verified webhook |
| Money moved through the row-diff sync | Blocked; narrow capability-gated finance routes with an append-only ledger |
| "Download PDF" produced a toast | Real server-generated invoice PDFs, byte-identical on regeneration |
| "Send to Customer" sent nothing | Statements generate, attach and deliver through the outbox |
| Public enquiries could be duplicated | Server-side dedupe fingerprint |

### Still standing between here and a release

Everything in `40A_CLIENT_ACTIVATION_CHECKLIST.md`, none of which is engineering work:

Stripe account and verification; email provider and DNS authentication; nineteen invoice identity
fields; the historical invoice reference for visual sign-off; tax rules; the capability bootstrap
(at least two `permissions.manage` holders); the store-contact migration review against real
records; the catalogue backfill; legal content approval; a migration rehearsal on production-shaped
data; and RC deployment and testing.

**Engineering blockers: none.** See `40_FINAL_ENGINEERING_HANDOVER.md` §7.
