# 32 — Production-Standard Functional Audit

An audit of the whole Veyora repository as an engineering-complete release candidate, against what a
professionally built B2B eyewear distribution platform would normally contain.

**This is an audit and planning run. Nothing was implemented, no application file was changed, no
payment feature was added, no production system was contacted, and nothing was committed or pushed.**

| | |
|---|---|
| Branch | `mathew/public-website-rebuild` |
| Commit | `cdb0630` — *checkpoint: complete release candidate handoff* |
| Working tree | clean; `git diff --check` clean |
| Capabilities audited | **236**, across 25 domains |
| Companion files | [32A gap matrix](32A_PRODUCTION_STANDARD_GAP_MATRIX.csv) · [32B backlog](32B_HANDOFF_IMPLEMENTATION_BACKLOG.md) · [33 git diagnosis](33_GIT_HISTORY_AND_RELEASE_LINE_DIAGNOSIS.md) |

> ### Two revisions since first issue — 2026-08-06
>
> **1. The payment decision is settled. Stripe is approved.** §5 is rewritten. Card payment is no
> longer Optional: it is a required deliverable, built against test keys, with live activation as a
> client-owned action after handover. **Apple Pay and Google Pay are not separate requirements** —
> Stripe's own payment sheet surfaces them where the device supports it. Existing B2B net-terms
> settlement is unchanged and remains fully supported.
>
> **2. DEP-009 was a false finding, and it was mine.** I reported that this branch shared no Git
> ancestor with `main` and escalated it to P0. It was an artefact of a **shallow clone**: `.git/shallow`
> contained the commit I called an orphan root, so `git merge-base` could not see past it. `main` is a
> direct ancestor; merging is a fast-forward. Full diagnosis, including the one-line check that would
> have caught it, is in [33](33_GIT_HISTORY_AND_RELEASE_LINE_DIAGNOSIS.md). **DEP-009 is downgraded
> from P0 to P2.**

---

## 1. Executive conclusion

**Veyora is a genuinely capable B2B distribution platform whose engineering quality is materially
above what its remaining gaps suggest. It is not ready for public launch, and the reasons are
concentrated rather than diffuse.**

Of 231 audited capabilities, **119 are complete** (100 outright, 19 pending release-candidate
verification). The governance, permission, publication, inventory-ledger, backorder and public-data
boundary work is of a standard I would not normally expect outside a much larger team. The public
data boundary in particular is defended at four independent layers and proven by adversarial tests.

The gaps cluster into five groups, and only the first two block a launch:

1. **The public website has no content.** 13 of its 29 routes — including the **home page**, all six
   policy pages, the privacy policy, the terms and the accessibility statement — render a
   development placeholder. Every route, layout, metadata contract, form and SEO control around them
   is built and tested. This is a content and legal-approval problem, not an engineering one, and it
   is the largest single obstacle to launch.

2. **Nobody can operate the platform's governed surfaces.** No account holds any capability, because
   the bootstrap grant has deliberately never been performed. Until it is, every public-content and
   enquiry screen is unreachable by every account including existing administrators.

3. **Four operational absences that would be noticed within a week of going live**: nothing notifies
   anyone that an enquiry arrived; nothing tells a customer their order shipped; nothing monitors or
   alerts on an outage; and no backup restore has ever been tested.

4. **A small number of real security gaps** — no rate limiting on authentication, a `Secure` cookie
   flag derived from a variable the planned cutover changes, an audit log the audited party can
   edit, and a fulfilment role that can rewrite commercial data. None is exotic; all are the kind
   found in a first external review.

5. **Structural handoff risk**: there is no CI, so the release-verification command that exists is a
   command nobody runs. *(This point originally also claimed the release branch shared no ancestor
   with `main`. That was wrong — see the revision note above and
   [33](33_GIT_HISTORY_AND_RELEASE_LINE_DIAGNOSIS.md).)*

A sixth group now exists as a consequence of the approved payment decision: **Stripe integration,
PDF invoices, invoice payment and auditable settlement** are required deliverables that did not exist
when this audit was first issued (§5).

The most commercially damaging single finding is **ENQ-006 / NOT-006**: three public enquiry forms
are live-ready, validated, consented and durably stored — and **nothing tells anybody a submission
arrived**. A public site whose sales-enquiry forms silently accumulate leads in a table is worse than
a site with no forms, because the business believes it is receiving enquiries.

**Recommendation:** treat the public website and the portal as two separable releases. The portal is
close to production-ready and gated mainly on operational hygiene. The public website is gated on
content and legal text that engineering cannot supply.

---

## 2. Scope and evidence methodology

### What was examined

Routes, database migrations and the `ensureSchema()` mirror, serializers, Express routers, the
vanilla-JS admin panel, the storefront SPA, the Astro public site, three test suites, deployment
configuration, the release-verification command, and 32 repository documents.

### Evidence levels

| Level | Meaning | Count |
|---|---:|---:|
| **E1** | Directly verified in source, migration, route, configuration or executable test | **191** |
| **E2** | Stated in documentation but not directly verified in implementation | 8 |
| **E3** | Inferred from surrounding architecture or naming | 5 |
| **E4** | Absent after a targeted repository search | 27 |

**83% of findings are E1.** The 13 E2/E3 findings are flagged in the matrix as lower-confidence and
say so in their notes; none of them is a P0.

### Rules applied

- **No capability was marked complete on documentation alone.** Where documentation and
  implementation disagreed, implementation won and the disagreement is recorded (§2.1).
- **No capability was marked absent because one expected filename was missing.** Absence claims (E4)
  come from searching routes, schema, serializers, frontend pages, tests, deployment configuration
  and documentation.
- **Branch-only work is not treated as part of the release candidate.** `feat/storefront-catalog-ux-and-homepage`
  contributes exactly one row (CAT-004), marked `PRESENT ON ANOTHER BRANCH ONLY`.
- **Nothing was labelled missing merely because it is uncommon outside consumer ecommerce.** Card and
  wallet checkout are classified `OPTIONAL — NOT STANDARD FOR CURRENT BUSINESS MODEL`, not missing.

### 2.1 Where documentation and implementation disagreed

`platform/docs/SOW-GAP-ANALYSIS.md` is a thorough analysis dated 2026-07-21 against commit
`8b7b763`, which predates this branch entirely. Several of its findings have since been fixed, and
re-verifying them at `HEAD` mattered:

| Its claim | State at `cdb0630` |
|---|---|
| A `warehouse` login can upsert its own `users` row with `role='admin'` and self-escalate | **Fixed.** `routes/admin.js:765` blocks `users` writes for non-admin, with a comment naming that exact attack |
| Product image upload pushes the literal string `'img'` | **Fixed.** `js/pages_catalog.js:275` calls a real `DB.uploadImages` |
| Admin-triggered activation and reset emails are stubs | **Fixed.** `routes/admin.js:867,883` call `sendMail` |
| Migrations only run on a fresh volume and `deploy.sh` never applies them | **Fixed.** `ensureSchema()` mirrors every migration idempotently at boot |
| Audit-log Undo does not revert | **Still true** (REP-007) |
| Email-template Broadcast raises a toast and does nothing | **Still true** (REP-006) |
| Statement "Send to Customer" does nothing | **Still true** (PAY-008) |
| `payments.stripe_payment_intent` implies an integration that does not exist | **Still true** (PAY-003) |

Two of its findings could not be re-verified within this audit's scope and are recorded as E2 with
that stated plainly: the production board's persistence (INV-006) and task ownership scoping
(CUS-005). **Both should be confirmed against code before anyone acts on them.**

---

## 3. Product and business-model interpretation

**Veyora is a B2B wholesale eyewear distributor. It is not, and should not become, a
direct-to-consumer retailer.**

Read from implementation rather than from documentation:

| Function | Where it lives | Evidence |
|---|---|---|
| Public discovery — brands, models, categories, company | Astro public site, no prices, no availability, no cart | E1 `platform/server/web/src/pages/` |
| Becoming a customer | Three public enquiry forms → staff review → account created with terms | E1 `public-forms.js` |
| Commercial terms | Per-customer `payment_terms`, `currency`, and one of four pricing modes | E1 `users` table, `pricing.js` |
| Ordering | Authenticated portal: cart → reservation → order, with backorder splitting | E1 `routes/cart.js`, `routes/orders.js` |
| Settlement | **Invoice on net terms.** No payment is taken at checkout | E1 `pages_cart.js:201` |
| Sales representatives | Agents order on behalf of customers with an explicit ordering-for context | E1 `routes/agent.js` |
| Deliberately excluded from the public site | Prices, availability, cart, checkout, orders, invoices, customer data | E1 `04_TARGET_ARCHITECTURE.md §8`, enforced by `public-forbidden-keys.js` |

The public/portal split is implemented exactly as designed and is the correct pattern for this
business. A visitor discovers the range publicly, applies for an account, is approved by a human, and
then sees pricing and can order. **Nothing in this audit recommends changing that.**

---

## 4. Domain-by-domain findings

Full detail, including evidence paths, is in [32A](32A_PRODUCTION_STANDARD_GAP_MATRIX.csv). This
section states the conclusion per domain.

### 4.1 Business model and commercial flow — sound, with one broken link
The model is coherent and correctly implemented. The one real gap is **BIZ-002**: a public account
application lands in `form_submissions`, and there is no path from an approved enquiry to a created
account. Today an approved applicant is keyed in by hand on the Users screen, with nothing linking
the two records.

### 4.2 Payments and settlement — see §5. The model is adequate; the tooling around it is thin.

### 4.3 Authentication, accounts and permissions — the strongest domain, with two real gaps
The capability system (`AUTH-007`) is excellent: six keys, a frozen registry, a database `CHECK`, no
wildcards, no prefix matching, no role fallback, revoke-in-place with attribution, and last-manager
protection. Four independent enforcement layers.

Against that: **there is no rate limiting on `/auth/login`** (AUTH-004, E4) — no attempt counter, no
lockout, no delay. And the `Secure` cookie flag is derived from `PUBLIC_URL` (AUTH-002), a variable
the planned cutover changes the meaning of; repointing or unsetting it silently drops `Secure` from
the authentication cookies with no error.

**AUTH-008**, the capability bootstrap, has never been performed. It gates every governed screen.

### 4.4 Public website — built, empty, and legally blocked
| State | Routes |
|---|---|
| **Real and data-driven (13)** | brands index and detail, collections index, three category pages, model detail, the three enquiry forms, global presence, 404, 500 |
| **Development placeholder (13)** | **home**, why-veyora, service-model, private-label, ordering-guide, shipping, warranty-and-exchanges, **privacy-policy**, **terms**, accessibility, resources index and detail, HTML sitemap |
| Machine routes (3) | robots.txt, sitemap.xml, healthz |

Two structural notes. First, **`resources/` has no data source** — the route exists and `/public/*`
has no resources endpoint (PUB-007). Second, **`content_pages` and `policies` tables exist with no
editor and no public read path** (CMS-006), which explains why the six policy pages are hard-coded
Astro files with nowhere for approved text to land.

### 4.5 Catalogue, search and discovery — strong, with one baseline gap
Publication controls, slug protection, the model/variation model, discontinued and replacement
handling, facets and pagination are all complete. **There is no public catalogue search** (CAT-008) —
below baseline for a discovery site. The authenticated catalogue loads ~1,000 products and filters in
JavaScript (CAT-007): fine now, not at scale.

### 4.6 Pricing and currency — complete, except tax
Four pricing modes, price-visibility control, multi-currency with rate stamping on orders,
backorders and invoices so historical orders reproduce. Public price leakage is prevented at four
independent surfaces.

Two gaps. **FX rates are manual** with hard-coded defaults and no change attribution (PRC-005) — a
stale rate silently misprices every order in that currency. And **there is no tax or VAT
representation anywhere** (PRC-006): no column, no rate, no calculation. For a distributor shipping
across borders that absence is notable and needs a business answer.

### 4.7 Cart, ordering and order lifecycle — solid, missing idempotency and a PO field
Transactional placement with guarded reservations, eight statuses with a shipped-order re-open guard,
history, repeat ordering. **No idempotency key on `place-order`** (ORD-003): a double-tap on a slow
connection creates two orders and two reservations. **No customer purchase-order reference**
(ORD-007), which B2B customers commonly require for their own accounts payable.

### 4.8 Backorders — the best-implemented domain, and highly reusable
Shortfall detection before the order is written, customer approve/cancel, conversion, an admin queue,
currency and rate stamping. The planning functions are pure and separately tested. Two gaps:
**no expected-availability date** (BACK-004) and **notifications only at creation** (BACK-005).

### 4.9 Inventory, warehouse and fulfilment — strong ledger, missing one email
The append-only `inventory_movements` ledger (INV-002) is exemplary: signed deltas, balance
snapshots, actor attribution, and deliberately free of foreign keys so it outlives the variation
churn the Zoho sync causes. Reservations are race-tested.

**Nothing emails a customer when their order ships** (INV-008/NOT-002). That is the single
most-expected message in B2B distribution.

### 4.10 Returns, exchanges, warranty and spare parts — the weakest domain
Returns have exactly two states, `open` and `closed`. There is **no staff approve/reject workflow, no
rejection reason, no evidence upload, and no link from an approved credit to a credit note**
(RET-002/003/004). **There is no warranty module at all** (RET-005) — no table, no route, no screen —
while the public site advertises a warranty page.

The enquiry handling model built in WS2 Phase 2 is a good template already in this repository for
what returns should look like.

### 4.11 Customer and sales operations — adequate
Profiles, leads, agents and account ownership are present. `leads` is not linked to
`form_submissions` (BIZ-002). Two E2 findings from the older analysis need re-verification: task
ownership scoping (CUS-005) and the production board (INV-006).

### 4.12 Enquiries and forms — excellent capture, no delivery
Closed field allowlists, server-controlled field rejection, honeypot with an indistinguishable
response, consent versioning, store-before-deliver ordering, a five-state no-delete handling model
with optimistic concurrency and audit. All complete.

**And nothing tells anyone a submission arrived** (ENQ-006). Every row stays `delivery_state =
'pending'` forever. The abuse throttle is per-process and in-memory, and honestly documented in its
own source as a mitigation rather than a control (ENQ-003).

### 4.13 Content management and governance — complete for products, absent for pages
The draft → verify → approve → publish lifecycle, the publication gate, the boundary guard that
stops an ordinary edit crossing into published, the approval log and optimistic concurrency are all
complete and well tested.

**There is no editor for `content_pages` or `policies`** (CMS-006). Preview (CMS-007) and scheduling
(CMS-008) are reasonable post-handoff work.

### 4.14 Media and asset management — adequate, two real gaps
Uploads are size-limited, mimetype-filtered and randomly named; alt text is modelled and asserted
present; rights holder and expiry are tracked and on the forbidden-key list. **File type is verified
only by the client's claimed mimetype** (MED-002), and **there are no responsive derivatives**
(MED-004) — a public catalogue serving full-size images to phones is a real performance and cost
problem.

### 4.15 SEO and discoverability — complete
Route metadata, canonicals, robots.txt, XML sitemap, JSON-LD with forbidden keys asserted absent,
breadcrumbs, indexing policy for filters and pagination, and true 404s. The only item not directly
confirmed is Open Graph/Twitter completeness (SEO-006, E3).

### 4.16 Privacy, legal and data retention — the hardest blocker
Privacy policy, terms and consent wording all require approval by the business's legal adviser
(LEG-001/002/003). **This audit does not draft them and offers no legal advice.**

One genuine strength: the public site sets **no cookies and loads no third-party scripts**, so no
consent banner is currently required (LEG-005) — worth preserving deliberately.

Two implementation gaps: **retention is stated but not honoured** (ENQ-008/LEG-004), and **there is
no data-subject deletion or anonymisation path** (LEG-006).

### 4.17 Accessibility, responsive design and UX — measured, with three open design decisions
Thirty page/viewport audits at 375/768/1280 in a real browser. Structure, landmarks, heading order,
labels, ARIA references, tab order and skip links are **clean at all three widths**, including every
field on all three enquiry forms.

Three findings are open and pinned, each one design-system decision applied everywhere: footer tap
targets under 24×24 (ACC-002), 183 contrast occurrences from a single 42%-alpha token (ACC-003), and
363 micro labels between 10px and 12px (ACC-004). ACC-003 is a one-token change.

**Manual verification has not been done** (ACC-006) and remains a release requirement: automated
checking covers roughly a third of WCAG issues, and focus visibility is not checked at all.

### 4.18 Security — see §6.

### 4.19 Integrations — Zoho is real; everything else is absent by decision
Zoho Inventory has live sync, order push, a pause switch, a scheduled job and a documented
run-without-Zoho cutover path. Email is nodemailer over configured SMTP. Accounting (INT-004), CRM
(INT-005), an FX feed (INT-006) and carrier APIs (INT-007) are all absent and all need a business
decision rather than an engineering one. There are no inbound webhooks, so webhook verification is
Not Applicable rather than missing.

### 4.20 Notifications and communications — half the expected set
Present: order confirmation, staff order alert, backorder creation, account activation, password
reset. Absent: **shipment/tracking** (NOT-002), backorder status changes (NOT-003), return updates
(NOT-004), and **enquiry notification** (NOT-006).

**No delivery-failure handling anywhere** (NOT-007): a silently failed order confirmation is
indistinguishable from a sent one.

### 4.21 Reporting and auditability — good data, two misleading screens
Five SQL views including supplier reconciliation. The audit log is comprehensive and used by the
permission, publication and enquiry surfaces.

Two screens actively mislead. **Audit-log Undo** (REP-007) writes a new audit row saying the action
was reversed while reverting nothing — the log misstates what happened. **Campaign send** (REP-006)
reports opens and clicks that can never be non-zero. Both should be removed or implemented.

### 4.22 Reliability and operations — the largest operational gap in the audit
Health checks are health-gated and real; startup refuses to serve on a failed migration; the runbook
is unusually good.

Against that: **no monitoring and no alerting of any kind** (OPS-004) — an outage would be discovered
by a customer. **Backups are documented but the script is not in the repository** (OPS-005) and **no
restore has ever been performed** (OPS-006). There is no retry or dead-letter handling for any
asynchronous work (OPS-008).

### 4.23 Deployment and handoff — well engineered, unproven
Compose topology, health-gated ordering, an environment contract that fails closed, migrations that
apply on deploy, a 16-gate release command, and an opt-in cutover with a non-destructive rollback.

None of it has run anywhere. `docker compose config`, `caddy validate`, the migration rehearsal, the
HTTPS form smoke test and the rollback test are all outstanding.

**Corrected 2026-08-06:** this section originally claimed the branch shared no common ancestor with
`main` and that landing it was not an ordinary pull request. **Both statements were wrong.** `main` is
a direct ancestor (0 behind, 35 ahead) and merging is a fast-forward. The false finding was caused by
a shallow clone — see [33](33_GIT_HISTORY_AND_RELEASE_LINE_DIAGNOSIS.md). DEP-009 is downgraded to P2:
confirm the release line and authorise a `--ff-only` merge.

### 4.24 Testing and quality assurance — 1,743 tests, no CI
API 1,091 · admin frontend 186 · public site 466, all passing. Deterministic catalogue-chain tests,
extensive authorisation and boundary tests, and real-browser accessibility tests with no dependency
added.

**Nothing enforces any of it** (QA-007). No migration has run against a real engine (QA-005). No scan
has run against a real row (QA-006). No load testing (QA-008).

### 4.25 Reusable platform capabilities — see §7.

---

## 5. Payment conclusion

> **Revised 2026-08-06 following an approved business decision.** The original conclusion — that card
> payment was Optional and not recommended — was correct *on the evidence available at the time*, and
> is superseded by a decision, not by a correction. The original reasoning is retained in §5.5 because
> it still explains why the existing settlement model is sound.

**Classification: the existing settlement model is adequately implemented AND an online payment flow
is now a required new deliverable. Stripe is the approved provider.**

### 5.1 The approved decision

| Decision | Consequence for engineering |
|---|---|
| **Stripe is the payment provider** | Build one integration. No provider comparison, no abstraction layer over multiple providers |
| **Live activation happens after handover** | Build and test against **Stripe test keys only**. Engineering never holds live credentials |
| **The client provides Stripe account access, or creates an account** | PAY-009. Blocks activation, not development — test mode needs no client account |
| **Production keys, webhook registration, payout configuration and final verification are client-owned supervised actions** | PAY-009, PAY-010 (registration half), PAY-011. These are explicitly *not* engineering deliverables |
| **Apple Pay and Google Pay are NOT separate requirements** | No additional integration work. Stripe's payment sheet surfaces them where the device and browser support it. Nothing in the backlog treats them as line items |
| **PDF invoices are required** | PAY-005, reclassified from conditional to required |
| **Auditable settlement updates are required** | PAY-013, and it is now doubly necessary — a webhook can change payment state with no human actor |
| **Invoice payment through Stripe is required** | PAY-012 |
| **Existing B2B payment terms remain supported** | PAY-001 is unchanged. Stripe is added **alongside** net terms, never instead of it |

### 5.2 What this changes in the matrix

| ID | Capability | Status |
|---|---|---|
| **PAY-002** | Stripe payment integration | MISSING — IMPLEMENT BEFORE HANDOFF (was *Optional*) |
| **PAY-003** | Stripe schema columns | Now forward-looking, not vestigial. Keep and extend |
| **PAY-005** | Invoice PDF | MISSING — IMPLEMENT BEFORE HANDOFF (was conditional) |
| **PAY-007** | Refunds | Now needs a provider refund path as well as credit notes |
| **PAY-009** | Stripe account provisioning | REQUIRES PRODUCTION CREDENTIALS — client-owned |
| **PAY-010** | Webhook endpoint and signature verification | MISSING — repository half; registration is client-owned |
| **PAY-011** | Payout configuration and live verification | REQUIRES PRODUCTION CREDENTIALS — client-owned |
| **PAY-012** | Invoice payment through Stripe | MISSING — IMPLEMENT BEFORE HANDOFF |
| **PAY-013** | Auditable settlement updates | MISSING — IMPLEMENT BEFORE HANDOFF |
| **INT-008** | Webhook verification and idempotency | **Reclassified from NOT APPLICABLE to MISSING.** The decision creates the first inbound webhook this platform has ever had |

### 5.3 Engineering constraints that follow from the decision

These are not preferences; they follow from the decision as stated.

1. **No card data may reach a Veyora server.** Use Stripe Elements or Checkout so the card is
   captured by Stripe directly. This is what keeps PCI scope at SAQ-A.
2. **The webhook is the source of truth for payment status, never the browser.** A client redirect
   proves nothing. Mark an invoice paid only from a signature-verified webhook event.
3. **The webhook must be idempotent on the Stripe event id.** Stripe retries deliveries by design; a
   non-idempotent handler will double-apply a settlement.
4. **Test keys only in the repository and in CI.** No live key in any file, environment example or
   test fixture. The existing `secret-and-host-scan` gate should be extended to fail on a live-mode
   key prefix.
5. **Net terms and Stripe must coexist.** A net-terms customer must not be forced to pay online, and
   an online payment must reconcile into the same settlement record as a bank transfer.

### 5.4 What has not changed

The existing model, read from implementation: checkout places an order and states *"Payment on your
usual terms (net N)"* (E1, `platform/server/storefront/js/pages_cart.js:201`). Invoices are raised
against orders; customers read their invoices; staff record receipts.

**That remains the primary settlement path for existing B2B customers** and nothing in the approved
decision removes it. Stripe adds an option.

### 5.5 The original reasoning, retained

At first issue there was no payment-provider integration of any kind — provider names appeared in
exactly three places (`0001_schema.sql`, `shape.js`, `platform/docs/*`), with no SDK, key, route,
webhook or client code (E1, repository-wide search). On that evidence, and absent a stated business
intent, recommending card and wallet checkout would have meant importing a consumer-ecommerce
assumption into a net-terms B2B model.

That reasoning is why the existing model is sound, and it is why **Apple Pay and Google Pay are still
not separate requirements** even now that Stripe is approved: they are a presentation feature of the
chosen provider, not an independent capability to design, build and maintain.

**No payment code was written during this audit or this diagnostic run.**

### 5.6 The payment surface as it stands today

| Capability | State |
|---|---|
| Net-terms settlement | **Complete** (PAY-001) — unchanged by the decision |
| Invoice generation from an order | Complete, RC verification required (PAY-004) |
| Customer invoice access | Complete (read-only) |
| Payment recording, credit notes, collection ageing, statements | Present, but written through the generic row-sync (PAY-006, PAY-013) |
| Invoice PDF / document delivery | Browser print view only — **now a required deliverable** (PAY-005) |
| Statement "Send to Customer" | **Stub** — raises a toast (PAY-008) |
| Refunds | Credit notes only; **now also needs a provider refund path** (PAY-007) |
| **Stripe integration** | **Absent — to be built** (PAY-002, PAY-010, PAY-012, PAY-013) |

At the time of writing, provider names appear in exactly three places — `0001_schema.sql`,
`shape.js` and `platform/docs/*` — with **no SDK, API key, route, webhook or client code** (E1,
repository-wide search). That is the starting point for WS10, not a finding against it.

---

## 6. Security and release conclusion

### Verified sound (E1, each traced individually)

- **Authorisation.** Capability routers mount before the general `/admin` router; no role satisfies a
  capability; no wildcard or prefix matching anywhere.
- **The public read boundary.** `routes/public.js` contains no write method; it cannot reach
  `form_submissions`, `account_permissions` or any handling column.
- **SQL parameterisation.** Every template interpolation into a query was traced to a code constant
  (`SIMPLE_COLLECTIONS`, the entity map, `orderUpdateSql`'s hard-coded columns). **No user-controlled
  identifier reaches SQL anywhere.**
- **Dynamic execution.** No `eval`, no `new Function`, no `child_process` in shipped source.
- **XSS.** Every `innerHTML` assignment in the admin panel is a constant or an `esc()`-guarded
  template; a test submits `<img src=x onerror=…>` through the enquiry path and asserts it survives
  as text.
- **CSRF on public forms.** Verified through a proxy reproducing Caddy's real header contract.
- **CORS.** No header anywhere; nothing needs one.
- **Secrets.** None in any shipped artefact, scanned on every verification run; `JWT_SECRET` required
  at boot.

### Open security findings

| ID | Finding | Priority |
|---|---|---|
| **SEC-011 / AUTH-004** | **No rate limiting on authentication.** No attempt counter, lockout or delay on `/auth/login`. The most exposed unauthenticated surface in the platform | **P0** |
| **AUTH-002** | **The `Secure` cookie flag is derived from `PUBLIC_URL`**, whose meaning the planned cutover changes. Repointing or unsetting it silently drops `Secure` | **P0** |
| **SEC-004** | **Three R-01 link fallbacks** to `https://veyora.design`, which becomes the *public* site after cutover. Password-reset and shared-list links already in inboxes would 404 | **P0** |
| **SEC-002** | **A `warehouse` login can write 17 of 18 sync collections**, including promotions, invoices, payments, shipping rules and settings. The `users` escalation named in the older analysis **is fixed**; the wider scope is not | **P0** |
| **SEC-015** | **The audit log is in the syncable set**, so an administrator can rewrite it. An audit log the audited party can edit is not an audit log | P1 |
| **SEC-013** | **No dependency vulnerability audit has ever been run.** Ten runtime dependencies — a small, genuinely strong surface — but unaudited | P1 |
| **SEC-007** | No CSRF token on portal JSON endpoints; `sameSite=lax` covers the cross-site form case but not defence in depth | P1 |
| **SEC-010** | No Content-Security-Policy. The public site loads no third-party scripts, so a strict policy is unusually easy here | P2 |
| **SEC-017 / MED-002** | Upload type verified by the client's claimed mimetype only | P2 |
| **SEC-016** | The login-handoff `?next=` parameter was not confirmed to be allowlist-validated (E3) | P2 |

### Release conclusion

**The release candidate is engineering-complete and operationally unproven.** Sixteen verification
gates pass and 1,743 tests pass — and every one is a statement about tests, because the stack has
never run anywhere. Before a release candidate can be trusted:

`docker compose config` · `caddy validate` · a migration rehearsal against a disposable PostgreSQL ·
an HTTPS form smoke test through real Caddy · a cutover and a rollback · a backup restore · the
capability bootstrap · monitoring and alerting.

---

## 7. Reusable capability inventory

| Capability | Verdict | Note |
|---|---|---|
| **Account-specific capability system** (REU-001) | **Reusable now** | The strongest component for reuse. Domain-free; only the key names change |
| **Inventory movements ledger** (REU-002) | **Reusable now** | Deliberately FK-free so it outlives entity churn |
| **Backorder planners** (REU-003) | **Reusable now** | The pure planning functions; the routes are Veyora-shaped |
| **Public API boundary + forbidden-key scanner** (REU-004) | **Reusable now** | Scanner is generic; the key list is per project |
| **Release verification command** (REU-007) | **Reusable now** | Harness is generic; the gate list is per project |
| **Dependency-free browser QA harness** (REU-008) | **Reusable now** | CDP over Node's global `WebSocket`. No Playwright, no browser download |
| **Dependency-free DOM shim** (REU-009) | **Reusable now** | Tests a vanilla-JS SPA with no framework or browser |
| **Enquiry handling model** (REU-012) | **Reusable now** | No-delete status machine with attribution and concurrency |
| **Multi-currency rate stamping** (REU-016) | **Reusable now** | The stamping discipline, not the manual rate source |
| Publication governance (REU-005) | Reusable after extraction | Entity-shape assumptions are Veyora-specific |
| Public Astro website (REU-006) | Reusable after extraction | Layouts and tokens are Veyora-branded |
| Catalogue audit/backfill planner (REU-010) | Reusable after extraction | The determinism discipline is the transferable idea |
| Deployment architecture (REU-011) | Reusable after extraction | The opt-in cutover pattern is worth carrying forward |
| Authentication (REU-013) | Reusable after extraction | **Only after AUTH-002 and AUTH-004 are fixed** |
| Customer-specific pricing (REU-017) | Reusable after extraction | — |
| Cart and ordering (REU-018) | Reusable after extraction | **Only after ORD-003 (idempotency)** |
| Admin shell (REU-014) | Tightly coupled | Works well; its data model is a whole-database in-memory snapshot |
| Zoho integration (REU-020) | Tightly coupled | The pause/cutover pattern is the transferable idea |
| Returns / warranty / spare parts (REU-019) | **Unsuitable for reuse** | Too thin — see RET-002 and RET-005 |
| **Whole-database admin sync** (REU-015) | **Unsuitable for reuse** | It is the root of SEC-002, SEC-015 and PAY-006. Works at this scale; do not carry the pattern forward |

---

## 8. Assumptions

1. **The business is B2B wholesale only.** Read from implementation, not assumed. If a
   direct-to-consumer channel is planned, the payment conclusion in §5 changes completely.
2. **The `mathew/public-website-rebuild` branch is the release candidate.** Work on other branches is
   excluded except where explicitly marked `PRESENT ON ANOTHER BRANCH ONLY`.
3. **`docs/public-website-rebuild/` describes intent; the code describes reality.** Where they
   disagreed, code won (§2.1).
4. **Documented server-side operations that are not in the repository cannot be verified** — the
   nightly backup cron is the main instance and is recorded as E2 for that reason.
5. **"Industry standard" means conventional for B2B wholesale distribution**, not for consumer
   ecommerce. This distinction is why wallets are Optional and not Missing.
6. **Recommendations are engineering recommendations.** Where a finding touches legal or privacy
   obligations, this document identifies the decision that must be taken and by whom. It does not
   give legal advice and does not draft binding text.
7. **Effort estimates assume a developer already familiar with this repository.**

---

## 9. Unresolved business, legal and production dependencies

### Business decisions (17 items)
Public website copy for 13 placeholder routes (PUB-001/002/005/007/009/011/012); tax and VAT
treatment (PRC-006); customer PO reference (ORD-007); warranty as a distinct workflow (RET-005);
CRM and accounting integration (CUS-007, INT-004/005); FX rate source (PRC-006/INT-006); enquiry
retention period (LEG-004); the three accessibility design decisions (ACC-002/003/004); capability
allocation archetypes (AUTH-009); and **confirming the release line and authorising a fast-forward
merge into `main`** (DEP-009, downgraded from P0 — the lineage question is resolved, only the
authorisation remains: see [33](33_GIT_HISTORY_AND_RELEASE_LINE_DIAGNOSIS.md) §12).

**Settled 2026-08-06:** the payment decision (PAY-002) is no longer open. Stripe is approved; see §5.

### Legal or privacy approval (5 items)
**Privacy policy** (LEG-001) · **Terms** (LEG-002) · **Consent wording** (LEG-003) · retention period
(LEG-004) · cross-border processing position (LEG-008).

These are the hardest blockers. Three public forms collect personal data today, and a public site
cannot launch without an approved privacy policy.

### Production credentials or access (8 items)
Capability bootstrap (AUTH-008) · catalogue backfill (CAT-003) · backup verification (OPS-005) · DNS
for the portal host (DEP-007) · HTTPS certificate issuance (DEP-008) · live-row data-leak
verification (QA-006) · **Stripe account access or creation (PAY-009)** · **payout configuration,
production key installation and final live verification (PAY-011)**.

The last two are **client-owned by decision**, not merely by circumstance. Engineering builds and
tests the Stripe integration entirely in test mode and must never hold a live key.

---

## 10. Recommended review order

Read in this order. Each step's outcome changes what matters in the next.

1. **§5 Payment conclusion** — **now settled.** Read it for what the Stripe decision requires and,
   just as importantly, what it does not (Apple Pay and Google Pay are not separate deliverables).
   The Stripe work is a new workstream, sized in [32B](32B_HANDOFF_IMPLEMENTATION_BACKLOG.md) WS10.
2. **§3 Business-model interpretation** — confirm B2B-only. Stripe is added alongside net terms, not
   instead of them; if a direct-to-consumer channel is also intended, say so now.
3. **§9 Legal and privacy dependencies** — the longest lead time in the whole programme. Start these
   moving on day one; nothing engineering does shortens them.
4. **§6 Security and release conclusion** — the four P0 security findings are small, well understood,
   and suitable for an unattended implementation run.
5. **[32B](32B_HANDOFF_IMPLEMENTATION_BACKLOG.md) Group A** — implement before engineering handoff.
6. **§4.22 Reliability** — monitoring, alerting and a tested restore. Cheap, and the difference
   between an outage measured in minutes and one measured in a customer's phone call.
7. **32B Group C** — the public website content backlog. Nothing launches without it.
8. **32B Groups D and E** — the supervised real-data and deployment work, in that order.
9. **§7 Reusable capabilities** — for planning future projects, not for this release.
10. **§4.10 Returns and warranty** — the weakest domain, and the natural first post-handoff
    workstream.
