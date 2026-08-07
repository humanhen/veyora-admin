# 40B — Weekend Reviewer: Start Here

You have a weekend and a repository. This tells you what it is, how to run it safely, what to look
at, and what not to touch.

**Read time: 10 minutes. Setup: about 5.**

---

## 1. What Veyora is

A **B2B wholesale eyewear distribution platform**. Not a shop. Customers are opticians and retailers
who order on **account terms** (Net 30 by default) and are invoiced; they do not pay at checkout.

Four surfaces:

| Surface | What it is | Where |
|---|---|---|
| **Public website** | Marketing site + enquiry forms. Astro, server-rendered | `platform/server/web/` |
| **Storefront** | The B2B portal customers log into and order from | `platform/server/storefront/` |
| **Admin panel** | Where Veyora staff run the business | `index.html` + `js/` at the repo root |
| **API** | Express + PostgreSQL, no ORM | `platform/server/api/` |

The admin panel is a **dependency-free vanilla-JS SPA** loaded as plain `<script>` tags. That is
deliberate and long-standing; please do not propose a framework migration as a review finding.

---

## 2. Branch to review

```
mathew/public-website-rebuild
```

Never `main`. Do not merge, rebase, fast-forward or push anything.

---

## 3. Current architecture, briefly

- **Express + `pg`**, raw SQL, no ORM. Explicit column lists everywhere; `SELECT *` is treated as a
  defect.
- **Capability-based authorisation.** 17 capability keys, no wildcards, **no role fallback**. An
  `admin` role satisfies nothing on a capability-gated route.
- **Serialisers are allowlists.** Fresh object literals with fixed keys; a database row is never
  spread into a response.
- **Money is in minor units** on every column added in this run, and the one decimal→integer
  conversion refuses rather than rounds.
- **Append-only ledgers** enforced by triggers: `audit_log`, `finance_events`,
  `inventory_movements`.
- **A transactional outbox** for every outbound message.
- **Tests are `node:test`** with hand-built database doubles. No mocking framework, no headless
  browser. The admin panel is tested through a small DOM shim (`test/helpers/dom.js`) that throws on
  selectors it does not implement, so an unsupported query fails loudly rather than matching nothing.

---

## 4. Install

Requires **Node 22** (developed on v22.22.2). No database is needed to run the tests.

```bash
git clone <repo> && cd Veyora
git checkout mathew/public-website-rebuild

npm --prefix platform/server/api  install
npm --prefix platform/server/web  install
```

The repo root has no `package.json`; the admin-panel tests run directly with `node --test`.

---

## 5. Safe local environment

**You do not need a database, a Stripe key, or an email account to review this.**

Everything is tested with injected doubles. If you want to *run* the API you will need PostgreSQL,
but the tests and the release gate do not.

Two things to know:

- **`.env` is protected.** `.env.example` is documentation with `example.test` placeholders and no
  secrets. Never create a real `.env` in the repo.
- **Stripe defaults to off.** `STRIPE_ENABLED` unset means the API boots normally and every payment
  action reports that online payment is switched off. If you do experiment, use `sk_test_…` — the
  software **refuses a live key outside production**.

---

## 6. The one command that verifies everything

```bash
node scripts/verify-release.mjs
```

18 gates, about 150 seconds. It runs all three test suites, the Astro production build, a
forbidden-data scan over *rendered* pages, accessibility and responsive checks, environment
validation, a secret-and-host scan, and the deployment-payload assembly.

It is a **local check, not a deployment**. It spawns only `node` and `git` — asserted by its own
test.

Individual suites:

```bash
npm --prefix platform/server/api test          # API
node --test "test/*.test.js"                   # admin panel
npm --prefix platform/server/web test          # public website
npm --prefix platform/server/web run build     # Astro production build
```

---

## 7. Test totals

| Suite | Tests |
|---|---|
| API | **1,669** |
| Admin panel | **298** |
| Public website | **466** |
| **Total** | **2,433 passing, 0 failing** |

---

## 8. Inspecting the public website

```bash
npm --prefix platform/server/web run dev
# http://localhost:4321
```

Look at: the enquiry forms (`/contact`, `/request-b2b-account`, `/private-label-enquiry`), the
structured data, and the accessibility work. `29_ACCESSIBILITY_AND_RESPONSIVE_QA.md` records the
contrast audit — including a defect where the checker silently skipped 62% of site text until
foreground colours were alpha-composited over their resolved backgrounds.

---

## 9. Inspecting the portal and admin panel

Both need a running API and database. If you would rather not stand one up, **read the tests
instead** — they drive the real shipped page handlers against a DOM shim and assert on rendered
output, so they are a faithful description of behaviour:

| Screen | Test |
|---|---|
| Enquiries | `test/enquiries-page.test.js` |
| Store contacts | `test/store-contacts-page.test.js` |
| Invoice payment | `test/invoice-payment-page.test.js` |
| Finance | `test/finance-page.test.js` |
| Permissions | `test/permissions-page.test.js` |
| Public content | `test/public-content.test.js` |

---

## 10. The permission system

`19_ACCOUNT_PERMISSION_SYSTEM.md`. The short version:

- 17 keys in a **frozen, hand-written registry** with no I/O. A key must appear there **and** in the
  `account_permissions` CHECK constraint, so adding one is a reviewable code + migration change.
- **No wildcards, no prefix matching, no hierarchy.** `public_content.*` will never resolve.
- **No role implies any capability.** Nothing in the resolver reads `users.role`.
- **No migration grants anything.** Not one. The first grant is a supervised bootstrap.
- Capabilities are resolved **fresh on every request** — deliberately uncached, so a revocation takes
  effect immediately.

Worth checking: `test/permissions.test.js` pins the exhaustive key list, so adding a key is a
deliberate change that touches that line.

---

## 11. The notification outbox

`src/notifications/`. Before it, an enquiry was stored, the visitor was told it had been received,
and **nothing was ever sent**.

- The notification is inserted in the **same transaction** as the thing that caused it.
- A worker claims with `for update skip locked`; a claim is a **lease**, so a worker that dies leaves
  rows the next tick reclaims.
- Retries are bounded: `[1, 5, 15, 60, 120]` minutes, then terminal.
- **No adapter may report success without provider confirmation.** With no SMTP configured, the
  adapter returns a retryable `NOT_CONFIGURED` and logs nothing — deliberately unlike the older
  `mail.js`, which returns `{ logged: true }` and prints the whole message body.
- A `delivered` row without a provider reference is refused by a CHECK constraint.

---

## 12. Customer contacts

`src/customer-contacts.js`, `src/routes/admin-customer-contacts.js`.

`users` conflated three things: the store, one person's contact details, and the login. Replacing a
buyer meant editing the login email. Contacts are now separate, with the Veyora sales rep
(`users.agent_id`) and the portal login kept distinct.

Nothing was back-filled. A planner *proposes* contacts from legacy fields for human review; it never
infers a job title or a responsibility, never proposes an empty contact, and a record it marks `skip`
cannot be approved into existence.

---

## 13. Stripe

`38_STRIPE_PAYMENT_ARCHITECTURE.md`. The property to check:

> **Only a verified webhook may settle an invoice.**

No route contains `settlement_state = 'paid'` — asserted. The webhook is mounted with
`express.raw()` **before** `express.json()`, because the signature covers the exact bytes.

**Test-mode ready only.** No live key has been used, no live webhook registered, no real payment
made.

---

## 14. Invoices and statements

`39_INVOICE_AND_STATEMENT_SYSTEM.md`. Real server-generated PDFs replacing a toast that said no
document existed and a "Send to Customer" button that emailed nothing while auditing that it had.

Regenerating an unchanged invoice is **byte-identical**. Every legal field is configuration with a
visibly-unset default; nothing is invented.

---

## 15. Known limitations

| # | Limitation |
|---|---|
| 1 | **Final invoice visual matching** is pending the historical Veyora reference, which does not exist in the repo. Functionally complete; visually neutral |
| 2 | ~~The storefront "Pay securely" control is a prepared patch, not applied.~~ **CLOSED 2026-08-07** — applied during the final integration run once the storefront was consolidated, with 12 tests of its own. See `44_BRANCH_INTEGRATION_REPORT.md` |
| 3 | **No account holds any capability.** By design. Nothing works until a supervised bootstrap grants the first ones |
| 4 | **The invoice route keeps an admin-role gate** as a documented bootstrap, because nobody holds `finance.invoice` yet. It delegates to the same implementation |
| 5 | **The public-form throttle is keyed on the Astro container's IP**, not the visitor's, so its budget is shared. An availability concern; the duplicate guard is separate and works |
| 6 | **No general order state machine.** `pending → shipped → pending` is permitted |
| 7 | **Tax comes through from the order record.** Per-jurisdiction rules are an unanswered business question |
| 8 | See `40_FINAL_ENGINEERING_HANDOVER.md` for the dependency-security position |

**Closed since the handover was written:** the `ensureSchema()` / migration mismatch. Migrations
0003–0005 are now mirrored and a structural parity suite keeps them aligned — see `43_SCHEMA_PARITY.md`.
If you are looking for something to break, that suite is a good target: it parses both definitions,
and a way past it is a real finding.

---

## 16. Prohibited

Please do not, under any circumstances:

- access production or the VPS;
- connect to a live database;
- change DNS;
- deploy anything;
- use a live Stripe key, or make any real Stripe API call;
- register a live webhook;
- send real email;
- process real customer or catalogue data;
- run the capability bootstrap SQL against anything real;
- **merge, rebase, fast-forward `main`, force-push, or push at all.**

None of these happened during this work, and none should happen during review.

---

## 17. Where improvements are welcome

Genuinely useful findings, roughly in order:

1. **A hole in an authorisation boundary.** A route reachable without the capability it claims; a
   customer able to read another customer's data. These matter most.
2. **A money bug.** A figure that can be wrong, a balance that can move twice, a rounding error.
3. **A test that passes for the wrong reason.** This happened repeatedly during the build — an
   assertion matching an explanatory comment, a PDF extractor reading compressed bytes and finding
   nothing, a transaction double that interleaved and hid a defect. If you find one, it is a real
   finding.
4. **A stated property that is not actually enforced.** The comments make strong claims. Check them.
5. **Accessibility or copy problems on the public site.**

Less useful: framework preferences, formatting, "you should use TypeScript here", or restating a
limitation already listed in §15.

---

## 18. How to report findings

For each: **what**, **where** (`file:line`), **how to reproduce**, and **why it matters**. A failing
test is the best possible report — the suites are cheap to add to.

Please separate:

- **Defects** — something is wrong;
- **Risks** — something could go wrong;
- **Suggestions** — something could be better.

---

## 19. How not to rewrite history

This branch has a clean, readable commit history and the reasoning lives in the commit messages.

- **Do not rebase, squash, amend or force-push.** Not even to tidy.
- **Do not merge `main` in.**
- If you want to demonstrate a fix, **branch from here** and leave it unmerged.
- If you change nothing, leave the tree clean — `git status --short` should be empty.

The repository has a guard test that fails if changes land in a protected path
(`platform/server/storefront/`, the live `Caddyfile`, any real `.env`). If you trip it, that is the
guard working.

---

## 20. Handback checklist

Before you finish:

- [ ] `git status --short` is empty, or contains only changes you intend to hand back
- [ ] `git log --oneline -1` still shows the commit you started from, or your own commits **on your
      own branch**
- [ ] `node scripts/verify-release.mjs` still reports 17/17
- [ ] No `.env` file exists in the working tree
- [ ] No file under `platform/server/storefront/` is modified
- [ ] Nothing was pushed
- [ ] Findings written up per §18

Thank you — a second pair of eyes on the authorisation boundaries and the money paths is the most
valuable thing this project can receive right now.
