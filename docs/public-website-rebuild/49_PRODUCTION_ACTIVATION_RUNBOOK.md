# 49 — Production Activation Runbook

**Read this if you are taking Veyora live and were not involved in building it.**

Follow it top to bottom. Every path and script named here exists in the repository — nothing is
illustrative. Where a step needs something only Veyora can supply, it says so and points at
`49A_CLIENT_INPUTS_REQUIRED.md`.

---

## STEP 0 — START HERE

**Repository:** `Veyora`
**Canonical branch:** `mathew/public-website-rebuild`
**Final engineering commit:** `f7652f8` *(the handover-exhaustion work; `4facddc` is the commit
before it if you need the earlier state)*

**Runtime:**

| Component | Version |
|---|---|
| Node | 22 (developed on v22.22.2) |
| PostgreSQL | 16 (per `platform/server/docker-compose.yml`) |
| Reverse proxy | Caddy v2 |
| Orchestration | Docker Compose |

**Read first, in this order — about 40 minutes:**

1. `48_HANDOVER_EXHAUSTION.md` — what is done, and what needs whom
2. `40B_WEEKEND_REVIEWER_START_HERE.md` — the architecture in ten minutes
3. `26_RELEASE_DEPLOYMENT_ARCHITECTURE.md` — the deployment topology
4. `43_SCHEMA_PARITY.md` — why there are two schema paths, before you run any migration

**Verify the code before trusting any of it:**

```bash
npm --prefix platform/server/api  install
npm --prefix platform/server/web  install
node scripts/verify-release.mjs          # 18 gates, ~140s, expect 18/18
```

That runs entirely locally: no database, no network, no credentials.

**DO NOT YET:**

- [ ] deploy anything
- [ ] point DNS at anything
- [ ] use a live Stripe key
- [ ] send real email
- [ ] run a migration against production
- [ ] grant any capability
- [ ] import any catalogue price — **see STEP 3**

---

## STEP 1 — COLLECT CLIENT INPUTS

Send `49A_CLIENT_INPUTS_REQUIRED.md` to Veyora. Nothing below STEP 2 can complete without it.

### Stripe
- [ ] Existing Stripe account, or create a new one?
- [ ] Who has account access
- [ ] Business verification completed
- [ ] Payout bank account added
- [ ] **Test** secret key, publishable key, webhook signing secret
- [ ] **Live** equivalents — later, at cutover only

### Email
- [ ] SMTP provider
- [ ] Host, port, username, password
- [ ] Sender identity (`SMTP_FROM`)
- [ ] Enquiry alert recipients
- [ ] Order alert recipients
- [ ] SPF record published
- [ ] DKIM signing configured
- [ ] DMARC policy decided

### Invoice identity
- [ ] Registered legal name
- [ ] Company registration number
- [ ] Tax / VAT number
- [ ] Registered address
- [ ] Billing contact email
- [ ] Bank details for remittance
- [ ] Legal / footer text
- [ ] Logo file
- [ ] **The historically approved invoice PDF**, for visual matching

### Tax
- [ ] Per-jurisdiction rules, from Veyora's accountant

### Permissions
- [ ] **At least two** people who will hold `permissions.manage`
- [ ] Who receives each capability family
- [ ] Specifically: who may hold `finance.credit_limit`
- [ ] Specifically: who may hold `finance.credit_review` *(deliberately a different question)*

### Data
- [ ] Reviewed store contacts
- [ ] The authoritative catalogue / product source
- [ ] **Which 2026 price list is authoritative, and what the other one represents**

### Legal
- [ ] Approved Privacy Policy
- [ ] Approved Terms
- [ ] Cookie / analytics position

---

## STEP 2 — CAPABILITY BOOTSTRAP

> **NO CAPABILITY IS GRANTED BY ANY MIGRATION.** Not one. Every account starts holding nothing, and
> that is deliberate — it is why nothing can be done by accident before somebody decides who may do
> it. Do not "temporarily" grant everything to get moving.

**Planner:** `platform/server/api/scripts/plan-permission-bootstrap.js`

1. [ ] **Plan.** Run the planner. It produces a proposal; it grants nothing.
2. [ ] **Review.** A human reads the proposal against Veyora's answers from STEP 1.
3. [ ] **Obtain approval.** Named approver signs off the list.
4. [ ] **Apply, supervised.** Two people present. Apply the approved plan only.
5. [ ] **Verify two permission managers.** Confirm at least two accounts hold `permissions.manage`
       and can both sign in. *One is a single point of failure: if that person leaves or is locked
       out, nobody can grant anything ever again.*
6. [ ] **Assign the remaining capabilities** through the admin panel's permissions screen.

**Verify:** sign in as one granted account, confirm the expected screens appear; sign in as an
ungranted account, confirm they do not and that the refusal is explicit rather than an empty page.

---

## STEP 3 — REAL DATA PREPARATION

### 3.1 Store contacts

**Planner:** `platform/server/api/scripts/plan-store-contacts.js`

- [ ] Run the planner. It **proposes** contacts from legacy fields.
- [ ] A human reviews every proposal. It never infers a job title or a responsibility, never
      proposes an empty contact, and a record it marks `skip` cannot be approved into existence.
- [ ] Build the reviewed plan: `platform/server/api/scripts/build-reviewed-plan.js`
- [ ] Apply only what was reviewed.

**Nothing was back-filled.** An unreviewed proposal is not a contact.

### 3.2 Catalogue

**Tooling:** `platform/server/api/src/catalogue-audit/`,
`platform/server/api/scripts/audit-public-catalogue.js`

> ### ⚠ CATALOGUE PRICE WARNING — READ BEFORE ANY IMPORT
>
> Two 2026 Veyora price-list documents exist outside this repository, and **they conflict**. Neither
> has been identified as authoritative.
>
> **DO NOT IMPORT EITHER** until Veyora states, in writing:
> - which list is authoritative, and
> - what the other one represents (a different tier? a season? a superseded draft?).
>
> Importing the wrong one prices the entire catalogue wrongly for every customer, and the error is
> not obvious from the screen.

- [ ] Obtain the authoritative source and its mapping from Veyora
- [ ] Run the audit to see what the current data looks like against it
- [ ] Review the plan — **human approval point**
- [ ] Apply only what was reviewed

**No catalogue record in this repository is currently verified for publication.** Catalogue
verification and population are client / other-developer owned.

---

## STEP 4 — ENVIRONMENT CONFIGURATION

Set these in the server's `.env`. **Never commit real values. `.env.example` is documentation and
carries `example.test` placeholders only.**

### Required for boot — the API refuses to start without them

| Variable | Notes |
|---|---|
| `DATABASE_URL` | **production secret** |
| `JWT_SECRET` | **production secret**. Rotating it signs everyone out |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | **production secret** |
| `PUBLIC_SITE_ORIGIN` | required by the web container's own gate |
| `PORTAL_ORIGIN` | required by the web container's own gate |
| `PUBLIC_DOMAIN` / `PORTAL_DOMAIN` | the two hostnames Caddy serves |

### Required for feature activation

| Variable | Activates |
|---|---|
| `STRIPE_ENABLED` | Card payment. **Unset = off**, and every payment action says so honestly |
| `STRIPE_SECRET_KEY` | **production secret**. `sk_test_…` first. The software **refuses a live key outside production** |
| `STRIPE_PUBLISHABLE_KEY` | |
| `STRIPE_WEBHOOK_SECRET` | **production secret**. Settlement does not work without it |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | where Stripe returns the customer |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | **production secret**. Unset = the adapter reports `NOT_CONFIGURED` and never claims a send |
| `SMTP_FROM` | sender identity |
| `ENQUIRY_ALERT_EMAILS` | who is told about an enquiry |
| `ORDER_ALERT_EMAILS` | who is told about an order |

### Optional — sensible defaults exist

| Variable | Default |
|---|---|
| `TRUST_PROXY_HOPS` | `1` (Caddy). **Read by both the API and the public-form throttle — change both or neither** |
| `COOKIE_SECURE` | production defaults to Secure |
| `ALLOW_CUSTOMER_BACKORDERS` | |
| `ADMIN_ORIGIN` | falls back to `PORTAL_ORIGIN` |
| `ZOHO_*` | Zoho sync; leave unset to disable |
| `CADDYFILE` | **STEP 8** — the cutover switch |

**Verify:** `node scripts/verify-release.mjs` includes an `env-validation` gate. Run it.

---

## STEP 5 — DATABASE MIGRATION REHEARSAL

> **NEVER PERFORMED.** This is the highest-value step you can do before cutover, and it must happen
> against a **disposable copy**, never production.

Read `43_SCHEMA_PARITY.md` first. It explains that `db/migrations/*.sql` runs **only on a fresh
volume** via `docker-entrypoint-initdb.d`, while `ensureSchema()` runs **every boot** — so an
existing database only ever executes the second.

1. [ ] **Export a copy of production data.** *Supervised production action — read-only.*
       `pg_dump` to a file. Do not run anything else against production.
2. [ ] **Stand up a disposable Postgres** — a throwaway container, on your own machine.
3. [ ] **Restore the copy** into it.
4. [ ] **Back up the disposable database** before migrating, so you can repeat the run.
5. [ ] **Point the API at the disposable database and boot it.** `ensureSchema()` runs. It must
       succeed; the process refuses to listen if it does not.
6. [ ] **Verify.** Confirm every object exists — the parity suite tells you what should:
       `node --test platform/server/api/test/schema-parity.test.js`
7. [ ] **Compare critical counts and invariants** before and after: users, orders, order_items,
       invoices, payments, credit_notes, finance_events, audit_log. Nothing should have been lost or
       duplicated. `audit_log` and `finance_events` are append-only by trigger — confirm the triggers
       exist.
8. [ ] **Destroy the disposable environment**, including the volume.

**Migrations 0009 and 0011–0019 have never executed anywhere.** That is the risk this step retires.

---

## STEP 6 — RELEASE CANDIDATE DEPLOYMENT

**Deploy script:** `platform/server/deploy.sh`
**RC topology:** `platform/server/Caddyfile.rc`

The RC topology is **not live by default**. `docker-compose.yml` mounts `./Caddyfile` unless
`CADDYFILE` is set, so `Caddyfile.rc` only takes effect when an operator deliberately sets it.

1. [ ] Deploy the RC to the server. **The public hostname does not move yet.**
2. [ ] Migration order: bring the database up first, then the API. `ensureSchema()` runs at API boot
       and the API refuses to listen if it fails — that is the gate, not a warning.
3. [ ] Health checks: the API exposes `/health`; the web container has its own `healthz` route.
4. [ ] **Record your rollback point:** the previous image tags and the current `Caddyfile` in use.

> Rollback at this stage is removing the `CADDYFILE` line and reloading. Nothing about the live
> public host has changed yet.

---

## STEP 7 — RC SMOKE TEST

Do this on the RC host, in test mode, before anyone talks about cutover.

### Authentication
- [ ] Sign in to the admin panel
- [ ] Sign in to the customer portal
- [ ] Sign out; confirm the session is gone
- [ ] Cookie is `Secure`, `HttpOnly`, `SameSite` — check in the browser's dev tools
- [ ] Password reset link arrives and works

### Public website
- [ ] Home page renders
- [ ] Every top-level route resolves; an unknown URL returns a real 404
- [ ] Catalogue pages render
- [ ] Submit each of the three enquiry forms **with JavaScript disabled**
- [ ] Each appears in the admin Enquiries screen
- [ ] Submit nine in quick succession — the ninth is throttled
- [ ] Submit from a second device — **it is not throttled** *(this is the fix in `48` §2.1)*

### Customer portal
- [ ] Catalogue, filters, search
- [ ] Product detail, images, colour thumbnails
- [ ] Add to cart, change quantity, remove
- [ ] Place an order
- [ ] Backorder appears where stock is short
- [ ] File a return **against a real previous order**; confirm another customer's order is not offered
- [ ] Exchange search returns frames and requires a chosen one
- [ ] Invoices list; download an invoice PDF
- [ ] Statement generates
- [ ] Balance & Payments shows exposure and, where no limit is set, **"Credit limit not configured"**
- [ ] Back navigation from a deep link goes somewhere sensible
- [ ] Order rows expand and show item images and the stamped delivery address

### Admin
- [ ] Enquiries: view, handle
- [ ] Store contacts
- [ ] Warehouse: start collection, scan, finish collection
- [ ] Permissions screen reflects the grants from STEP 2
- [ ] Finance: invoices, payments, statements
- [ ] Accounts receivable: revenue, open AR, past due, future due, ageing
- [ ] Dashboard cards drill through to the right screens
- [ ] **Credit limits:** set one, change it, clear it — each requires a reason
- [ ] **Credit review:** place an over-limit order, confirm it appears in the queue, approve it,
      confirm the order can then progress and the customer's limit is **unchanged**
- [ ] Decline a second one; confirm it cannot progress

### Stripe — TEST MODE ONLY
- [ ] Hosted payment page opens
- [ ] Complete a test payment
- [ ] Webhook received and verified
- [ ] Invoice settles **only after** the webhook, not on redirect
- [ ] Replay the same webhook — nothing changes twice
- [ ] A failed and an expired session both report honestly

### Email
- [ ] Enquiry notification delivered
- [ ] Order confirmation delivered
- [ ] Statement delivered as a PDF attachment
- [ ] A delivered row carries a provider reference

### Finance
- [ ] Invoice PDF renders and is byte-identical when regenerated unchanged
- [ ] Statement PDF renders
- [ ] Record an offline payment; balance moves; `finance_events` records before and after
- [ ] Issue a credit note; confirm it needs a reason
- [ ] Credit position matches the ledger plus uninvoiced orders

### Security
- [ ] An account without a capability is refused, with an explicit message
- [ ] One customer cannot see another's orders, invoices or returns
- [ ] A cross-origin form POST is rejected
- [ ] Rate limits engage on repeated failed sign-ins
- [ ] `audit_log` refuses UPDATE and DELETE — try it directly in psql

---

## STEP 8 — PRODUCTION CUTOVER

> **REQUIRES EXPLICIT AUTHORISED APPROVAL from the named cutover approver in `49A`.**
> **Nothing in this run performed any part of this step.**

**Preconditions — all must be true:**

- [ ] STEP 5 rehearsal completed successfully
- [ ] STEP 7 smoke test passed and was signed off
- [ ] Live Stripe credentials in place and the webhook endpoint registered
- [ ] SMTP live and SPF/DKIM/DMARC verified
- [ ] Capabilities granted; two permission managers confirmed
- [ ] Invoice legal identity configured
- [ ] Privacy Policy and Terms published
- [ ] A current database backup taken **immediately before** cutover
- [ ] Rollback point recorded
- [ ] A named person is watching for the first hour

**The mechanism:** set `CADDYFILE=./Caddyfile.rc` and reload Caddy. That moves the public catch-all
to the Astro site and the portal to its own hostname. This is risks **R-01 and R-02**, the two
highest in the programme — which is why it is one deliberate line rather than something a deploy
does for you.

**Rollback triggers — any one of these, roll back immediately:**

- the public site does not serve, or serves the portal
- sign-in fails for staff or customers
- orders cannot be placed
- Stripe webhooks are not arriving
- database errors in the API log
- error rate materially above the RC baseline

**Rollback:** remove the `CADDYFILE` line, reload Caddy, redeploy the previous image tags. Restore
the pre-cutover backup **only** if data was written and is wrong — check first.

---

## STEP 9 — POST-CUTOVER VERIFICATION

### First 5 minutes
- [ ] `/health` responds
- [ ] Public home page loads over HTTPS on the real hostname
- [ ] Portal loads on its hostname
- [ ] Staff sign-in works
- [ ] API logs show no errors

### First 30 minutes
- [ ] Submit a real enquiry; confirm it arrives by email
- [ ] Place a small real order end to end
- [ ] Confirm a Stripe webhook is received and verified
- [ ] Confirm outbound mail is delivering (check the provider's dashboard, not just the app)
- [ ] Database connections stable; no lock contention
- [ ] Review error logs line by line

### First business day
- [ ] Orders, invoices and payments reconcile against expectations
- [ ] No duplicate enquiries or orders
- [ ] Backups ran
- [ ] Ask staff what looked wrong — they will notice things a checklist does not
- [ ] **Rollback decision point:** if anything above is unresolved, roll back rather than carry it

---

## STEP 10 — DEFERRED / NON-BLOCKING

**These are not release blockers.** Do not let them delay cutover.

| Item | Status |
|---|---|
| **Catalogue verification and population** | Client / other-developer owned. See STEP 3 and `48` §5 |
| **The 2026 price lists** | Conflicting. **Must not be imported** until Veyora identifies the authoritative one |
| **Invoice historical visual match** | Pending the old approved PDF. Functionally complete; visually neutral |
| **Analytics** | Off by default, deliberately. Re-activating needs a configured id, a consent mechanism and a business decision — see `46` §5 |
| **Tax rules beyond the order record** | Awaiting the accountant |
| **Warranty module, CRM, campaign reporting, HTML sitemap** | Unbuilt, unrequested. Post-handover enhancements, not unfinished work |
| **The `finance.invoice` role-gate bootstrap** | The invoice route keeps an admin-role gate because nobody held the capability. Retire it once grants exist — `41_FINANCE_OPERATIONS.md` §6 |
| **CI enforcement, load testing, monitoring, restore testing** | Need infrastructure access |
