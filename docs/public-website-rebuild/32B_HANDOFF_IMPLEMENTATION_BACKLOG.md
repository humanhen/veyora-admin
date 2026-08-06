# 32B — Handoff Implementation Backlog

Every finding from [32](32_PRODUCTION_STANDARD_FUNCTIONAL_AUDIT.md) /
[32A](32A_PRODUCTION_STANDARD_GAP_MATRIX.csv), grouped by what has to happen to it and who has to do
it.

**Nothing in this document has been implemented.** It is a plan.

> ### Revised 2026-08-06
>
> **Stripe is approved as the payment provider.** A new workstream **WS10** is added to Group A, and
> two client-owned items are added to Group D/E. **Apple Pay and Google Pay are not separate backlog
> items** — Stripe's payment sheet surfaces them where the device supports it, so there is nothing to
> build, test or maintain for them. Existing B2B net-terms settlement is unchanged.
>
> **DEP-009 is downgraded from P0 to P2.** The "two unrelated git histories" finding was a false
> positive caused by a shallow clone; `main` is a direct ancestor and merging is a fast-forward. See
> [33](33_GIT_HISTORY_AND_RELEASE_LINE_DIAGNOSIS.md).

| Group | What it is | Items |
|---|---|---:|
| **A** | Implement before engineering handoff | 28 |
| **B** | Correct before release-candidate deployment | 9 |
| **C** | Requires business, content or legal input | 21 |
| **D** | Requires supervised real-data work | 9 |
| **E** | Requires supervised deployment | 13 |
| **F** | Accepted post-handoff enhancements | 11 |
| **G** | Not applicable or intentionally excluded | 5 |

### How to read the "unattended run" column

`Yes` means the work is fully specified by repository evidence, has a deterministic correct answer,
touches no production system, and needs no business fact. `No` means a human must decide something,
supply something, or watch it happen.

### Recommended workstream grouping

| WS | Theme | Groups |
|---|---|---|
| **WS3** | Security and access hardening | A |
| **WS4** | Operational communications (the outbox) | A |
| **WS5** | Aftersales — returns and warranty | A |
| **WS6** | Commercial data integrity | A |
| **WS7** | Reliability and observability | A + E |
| **WS8** | Content and legal enablement | A + C |
| **WS9** | Release-candidate deployment | B + D + E |
| **WS10** | **Stripe payments** (new, approved 2026-08-06) | A + D/E for the client-owned half |

---

## A. Implement before engineering handoff

### WS3 — Security and access hardening
*Rationale: four P0 findings, all small, all fully specified, none needing a business fact. This is
the single best candidate for an unattended run.*

| ID | Reason | Proposed outcome | Paths | Effort | Depends on | Unattended | Human gate |
|---|---|---|---|---|---|---|---|
| **AUTH-004 / SEC-011** | No rate limiting on `/auth/login` — no counter, lockout or delay. The most exposed unauthenticated surface | Per-identifier and per-IP throttling with exponential backoff on failed authentication, an `audit_log` entry on lockout, and a documented reset path. Cover `/forms/*` with the same mechanism, replacing the per-process throttle | `api/src/routes/auth.js`, `api/src/routes/public-forms.js`, new `api/src/rate-limit.js`, `api/test/` | S | — | **Yes** | Review before merge |
| **AUTH-002** | The `Secure` cookie flag derives from `PUBLIC_URL`, whose meaning the cutover changes. Repointing it silently drops `Secure` | Introduce explicit `COOKIE_SECURE`, defaulting to true when `NODE_ENV=production`. Fail closed. Add a test asserting `Secure` is set in production regardless of `PUBLIC_URL` | `api/src/authmw.js:11-12`, `.env.example`, `api/test/` | XS | — | **Yes** | Review before merge |
| **SEC-004** | Three modules fall back to `https://veyora.design`, which becomes the *public* site after cutover. Reset and shared-list links already in inboxes would 404 | Introduce `PORTAL_URL` for portal-bound links; fail closed if unset in production. Remove the three literals; the release-gate exception list shrinks by three | `api/src/authmw.js`, `api/src/emails.js`, `api/src/routes/catalog.js`, `scripts/verify-release.mjs` | S | — | **Yes** | **Yes — changes live email link content** |
| **SEC-002** | A `warehouse` login can write 17 of 18 sync collections, including promotions, invoices, payments, shipping rules and settings | Restrict the sync collection set by role: warehouse writes only fulfilment-relevant collections. Refuse the whole payload on violation, as the existing stale-client gate does | `api/src/routes/admin.js:733-770`, `api/src/admin-data.js`, `api/test/` | M | — | **Yes** | Confirm the warehouse collection list |
| **SEC-015** | `audit` is in the syncable set, so an administrator can rewrite the log describing them | Remove `audit` from `SIMPLE_COLLECTIONS`; make it append-only at the API. Add a test asserting a sync payload naming `audit` is refused | `api/src/shape.js`, `api/src/routes/admin.js`, `api/test/` | S | — | **Yes** | Review before merge |
| **SEC-013** | No dependency vulnerability audit has ever been run | Run `npm audit` in both packages, triage, and add an `npm audit` gate to `verify-release.mjs` with a documented offline skip | `api/`, `web/`, `scripts/verify-release.mjs` | XS | Network | **Yes** | Review any upgrade |
| **SEC-007** | No CSRF defence in depth on portal JSON endpoints | Origin/Referer check on state-changing API routes, allowlisted against the configured origins | `api/src/index.js` or `authmw.js`, `api/test/` | S | SEC-004 | **Yes** | Review before merge |
| **SEC-010** | No Content-Security-Policy | Add a strict CSP to both Caddyfiles. Unusually easy here because the public site loads no third-party scripts — do it while that is still true | `platform/server/Caddyfile.rc`, `api/test/deployment-config.test.js` | M | — | **Yes** | Verify no console violations at RC |
| **SEC-016** | The login-handoff `?next=` parameter was not confirmed to be allowlist-validated (E3) | Verify; if unvalidated, restrict to internal paths | `web/src/components/nav/`, `web/test/` | XS | — | **Yes** | — |
| **SEC-017 / MED-002** | Upload type verified only by the client's claimed mimetype | Verify the file signature; serve uploads with a fixed `Content-Type` and `Content-Disposition` | `api/src/routes/admin.js:833-848`, `Caddyfile.rc` | S | — | **Yes** | Review before merge |
| **ACC-007** | Admin panel disables pinch-zoom (WCAG 1.4.4) | Remove `maximum-scale=1.0` | `index.html` | XS | — | **Yes** | — |

### WS4 — Operational communications
*Rationale: one durable outbox closes six findings. Build the mechanism once.*

| ID | Reason | Proposed outcome | Paths | Effort | Depends on | Unattended | Human gate |
|---|---|---|---|---|---|---|---|
| **ENQ-006 / NOT-006** | **Nothing tells anyone an enquiry arrived.** Every submission stays `pending`. The most commercially damaging finding in the audit | On submission, enqueue a notification to a configured operations address. Move `delivery_state` through `sent`/`failed` with attempts and last error — the columns already exist and are already excluded from the operations screen | `api/src/routes/public-forms.js`, new `api/src/outbox.js`, `api/test/` | M | OPS-008 | **Yes** | Confirm the destination address |
| **OPS-008** | No retry or dead-letter handling for any asynchronous work | One durable outbox table with attempts, next-attempt time and a failed state, serving email, enquiry delivery and Zoho push. Idempotent, safe to run in one process | new migration + `ensureSchema()` mirror, `api/src/outbox.js`, `api/test/` | M | — | **Yes** | Review the schema |
| **NOT-007** | A silently failed order confirmation is indistinguishable from a sent one | Record every send attempt and outcome through the outbox; surface failures in the admin | `api/src/mail.js`, `api/src/outbox.js`, `js/pages_ops.js` | M | OPS-008 | **Yes** | Review before merge |
| **INV-008 / NOT-002** | Nothing tells a customer their order shipped — the most-expected message in B2B distribution | Dispatch notification with the tracking number, sent on the `shipped` transition through the outbox | `api/src/emails.js`, `api/src/routes/admin.js`, `api/test/` | S | OPS-008 | **Yes** | Approve the wording |
| **BACK-005 / NOT-003** | Backorder notifications exist only at creation | Notify on approve, convert and cancel | `api/src/routes/orders.js:604,619`, `api/src/routes/admin.js:74` | S | OPS-008 | **Yes** | Approve the wording |
| **RET-007 / NOT-004** | No customer communication on returns | Notify on each return status transition | `api/src/routes/orders.js`, `api/src/emails.js` | S | RET-002 | **Yes** | Approve the wording |

### WS10 — Stripe payments *(new — approved 2026-08-06)*
*Rationale: an approved business decision, not an audit recommendation. Build the whole integration
against **test keys only**; every live-credential action is client-owned and appears in Group D/E.
**Apple Pay and Google Pay are deliberately absent from this table** — they are a presentation
feature of Stripe's payment sheet, not a deliverable.*

| ID | Reason | Proposed outcome | Paths | Effort | Depends on | Unattended | Human gate |
|---|---|---|---|---|---|---|---|
| **PAY-002** | Stripe is the approved provider and no integration exists | Server-side payment-intent creation and a Stripe Elements or Checkout client, so **no card data reaches a Veyora server** (keeps PCI scope at SAQ-A). Test keys only, read from the environment, absent by default | new `api/src/payments/stripe.js`, `api/src/routes/`, storefront, `.env.example`, `api/test/` | L | — | **Yes** *(test mode)* | Review before merge |
| **PAY-010 / INT-008** | Stripe retries webhook deliveries by design; a non-idempotent handler double-applies a settlement | A signature-verified webhook endpoint, **idempotent on the Stripe event id**, that is the only writer of payment status. Reject unverified payloads without processing | `api/src/routes/stripe-webhook.js`, additive migration for processed event ids, `api/test/` | M | PAY-002 | **Yes** | Review before merge |
| **PAY-013** | A webhook can change payment state with no human actor, so attribution matters more, not less | Append-only settlement events with actor, source (`manual` \| `stripe-webhook`), amount, currency and provider reference, plus an `audit_log` entry. Remove `payments` and `creditNotes` from the syncable set | additive migration + mirror, `api/src/routes/admin.js`, `api/src/shape.js` | M | SEC-002, PAY-010 | **Yes** | Confirm the accounting treatment |
| **PAY-012** | Customers cannot settle an invoice online | A pay-this-invoice flow scoped to one invoice. Status is updated **only** from the verified webhook, never from the browser redirect. Net-terms customers keep the existing path — online payment is an option | `api/src/routes/orders.js`, storefront, `api/test/` | M | PAY-002, PAY-010 | **Yes** | Review before merge |
| **PAY-005** | PDF invoices are now a required deliverable | Server-side PDF from the invoice record, downloadable and email-attachable, rendering the same figures the portal shows including currency and the stamped FX rate | `api/src/`, `api/src/emails.js`, `api/test/` | M | — | **Yes** | Approve the layout |
| **PAY-003** | The Stripe schema columns exist but are unused and under-specified | Extend with the fields a real integration needs (session/charge id, status, amount received, currency, failure reason) and document them | additive migration + mirror, `docs/.../14_B2_SCHEMA_REFERENCE.md` | XS | PAY-002 | **Yes** | — |
| **PAY-007** | Refunds now need a provider path as well as credit notes | Provider refund reconciled back to a credit note and confirmed by webhook | `api/src/routes/admin.js`, `api/src/payments/` | M | PAY-010 | **Yes** | Confirm the accounting treatment |
| **SEC-012 (extend)** | A live Stripe key must never enter the repository | Extend the `secret-and-host-scan` gate to fail on a live-mode key prefix as well as the existing patterns | `scripts/verify-release.mjs`, `test/verify-release.test.js` | XS | — | **Yes** | — |

### WS5 — Aftersales
*Rationale: the weakest domain, and the enquiry handling model is already a template for it.*

| ID | Reason | Proposed outcome | Paths | Effort | Depends on | Unattended | Human gate |
|---|---|---|---|---|---|---|---|
| **RET-002** | Returns have only `open`/`closed` — no approve, reject, reason or attribution | An explicit status machine (requested/approved/rejected/received/resolved/closed) with a closed transition allowlist, attribution from `req.user`, optimistic concurrency and audit — mirroring `enquiry-operations.js` | additive migration + mirror, `api/src/routes/orders.js`, new `api/src/return-operations.js`, `js/pages_sales.js` | M | — | **Yes** | Confirm the status set |
| **RET-003** | No evidence upload on a return | Attach media to a return using the existing upload endpoint | `api/src/routes/orders.js:657`, `js/`, `platform/server/storefront/js/` | S | RET-002 | **Yes** | — |
| **RET-004** | An approved credit is not linked to a credit note or a replacement order | Link an approved credit resolution to `credit_notes`, an exchange to a replacement order | `api/src/routes/orders.js`, `api/src/routes/admin.js` | M | RET-002, PAY-007 | **Yes** | Confirm the accounting treatment |

### WS6 — Commercial data integrity

| ID | Reason | Proposed outcome | Paths | Effort | Depends on | Unattended | Human gate |
|---|---|---|---|---|---|---|---|
| **ORD-003** | No idempotency on `place-order`; a double-tap creates two orders and two reservations | Accept a client-generated idempotency key; return the original result on replay | `api/src/routes/orders.js:85`, `platform/server/storefront/js/pages_cart.js`, `api/test/` | S | — | **Yes** | Review before merge |
| **PAY-006** | Payments and credit notes are written through the generic row-sync with no audit of the prior value | Dedicated, audited endpoints for recording a receipt and issuing a credit note; remove them from the sync set | `api/src/routes/admin.js`, `api/src/shape.js`, `js/pages_finance.js` | M | SEC-002 | **Yes** | Confirm the accounting treatment |
| **PAY-007** | Credit notes have no issue/approve/apply workflow | Formalise as audited endpoints | `api/src/routes/admin.js` | S | PAY-006 | **Yes** | Confirm the accounting treatment |
| **PRC-005** | FX rates are manual with no change attribution; a stale rate silently misprices every order in that currency | Record who changed a rate and when, with an explicit effective date and an audit entry | `api/src/currency.js`, `js/pages_finance.js`, `api/test/` | M | — | **Yes** | Confirm whether a feed is wanted |
| **PRC-007** | Any admin or warehouse login can rewrite pricing | Covered by SEC-002 | — | — | SEC-002 | — | — |
| **PAY-008** | Statement "Send to Customer" raises a toast and does nothing | Wire to the outbox, or remove the control | `js/pages_finance.js:363-377` | S | OPS-008 | **Yes** | Decide send vs remove |
| **REP-006** | Campaign send is a stub reporting opens and clicks that can never be non-zero | Remove the control, or implement it | `js/pages_customers.js:765-771`, `js/pages_sales.js` | M | OPS-008 | **Yes** | **Yes — decide send vs remove** |
| **REP-007** | Audit-log Undo writes a row saying the action was reversed while reverting nothing. The log actively misstates what happened | **Remove the control.** Implementing a general undo across 18 collections is not justified | `js/pages_ops.js:450-461`, `test/` | XS | — | **Yes** | Confirm removal |

### WS8 — Content enablement (engineering half)

| ID | Reason | Proposed outcome | Paths | Effort | Depends on | Unattended | Human gate |
|---|---|---|---|---|---|---|---|
| **CMS-006** | `content_pages` and `policies` tables exist with no editor and no public read path — approved policy text has nowhere to land | Either build the governed editor plus a `/public/content` read path, **or** decide the six policy pages stay hard-coded Astro files and document that the tables are unused | `api/src/routes/admin-public-content.js`, `api/src/routes/public.js`, `web/src/pages/`, `js/` | M | — | No | **Yes — decide editor vs hard-coded first** |
| **CAT-008** | No public catalogue search — below baseline for a discovery site | Server-driven search on the public catalogue, reusing the existing filter contract | `api/src/routes/public.js`, `web/src/pages/collections/`, tests | M | — | **Yes** | Review before merge |
| **PUB-012** | The HTML sitemap page is a placeholder while `sitemap.xml` is real | Generate it from the same source, or remove the route | `web/src/pages/sitemap/index.astro` | XS | — | **Yes** | — |
| **BIZ-002** | No path from an approved account enquiry to a created account | A governed "convert enquiry to account" action gated on a new capability, writing `users` + terms + currency and sending the existing activation email | `api/src/routes/admin-enquiries.js`, `api/src/permission-registry.js`, additive migration, `js/pages_enquiries.js` | M | AUTH-008 | **Yes** | Confirm the capability name |
| **ORD-007** | No customer purchase-order reference — commonly required by B2B customers for their own accounts payable | Add a customer PO reference to the order; show it on the invoice | additive migration + mirror, `api/src/routes/orders.js`, storefront checkout, `api/src/emails.js` | XS | — | No | **Yes — confirm it is wanted** |
| **BACK-004** | No expected-availability date on a backorder — the commonest source of B2B chase-up contact | Staff-settable expected date, shown to the customer | additive migration + mirror, `api/src/routes/admin.js`, storefront | S | — | **Yes** | — |
| **ORD-009** | No customer-initiated cancellation | Cancellation before dispatch with a status guard | `api/src/routes/orders.js` | S | — | **Yes** | Confirm the cut-off point |
| **LEG-006** | No data-subject deletion or anonymisation path | Supervised, audited anonymisation for a customer and for an enquirer. **Anonymise in place** — deletion must not break order history | `api/src/routes/admin.js`, `api/src/routes/admin-enquiries.js`, additive migration | M | LEG-004 | No | **Yes — legal sign-off on the approach** |
| **ENQ-008** | Retention is stated and not honoured | A supervised retention job with a dry-run mode and an audit record | new `api/scripts/`, `api/src/enquiry-operations.js` | M | LEG-004 | No | **Yes — confirm the period first** |
| **AUTH-009** | No documented capability allocation archetypes | Document five archetypes (Content Reviewer, Content Editor, Publisher, Enquiry Handler, Permission Administrator). **Assign no real accounts** | `docs/.../19_ACCOUNT_PERMISSION_SYSTEM.md` | XS | — | **Yes** | Business confirms the allocation |
| **PAY-003** | `payments.stripe_payment_intent` reads as a built integration | Document it as a placeholder in the schema reference. **Do not drop the column** — destructive for no benefit | `docs/.../14_B2_SCHEMA_REFERENCE.md` | XS | — | **Yes** | — |
| **OPS-009** | The runbook has no named owner, escalation path or incident procedure | Add all three. The runbook is otherwise unusually good | `platform/docs/RUNBOOK.md` | XS | — | No | **Yes — the business names the owner** |

### Findings needing verification before they can be actioned

| ID | Reason | Proposed outcome | Effort | Unattended | Human gate |
|---|---|---|---|---|---|
| **INV-006** | Production board persistence reported broken in a document that predates this branch (E2) | Re-verify at `HEAD`; fix if the collection is still outside the synced set | S | **Yes** | — |
| **CUS-005** | Task ownership scoping reported absent in the same document (E2) | Re-verify at `HEAD`; scope task reads and writes to the owner | S | **Yes** | — |
| **REP-001** | Dashboard placeholder cards reported in the same document (E2) | Re-verify; wire or remove | S | **Yes** | — |
| **SEO-006** | Open Graph / Twitter completeness not directly confirmed (E3) | Confirm and complete, including an image | XS | **Yes** | — |
| **INT-002** | Zoho failure and retry behaviour not verified (E3) | Confirm what happens to a failed order push; make failures visible | S | **Yes** | — |

---

## B. Correct before release-candidate deployment

*Not code changes — verifications and corrections that must happen with the RC, in this order.*

| ID | Reason | Proposed outcome | Effort | Depends on | Unattended | Human gate |
|---|---|---|---|---|---|---|
| **QA-007** | The release-verification command exists and nothing runs it. This is why R-06 cannot close | Wire `scripts/verify-release.mjs` into CI on every pull request; block a failing merge | S | CI platform choice | No | **Yes — the business chooses the CI platform** |
| **DEP-009** | ~~No common ancestor with `main`~~ — **corrected.** `main` is a direct ancestor (0 behind, 35 ahead); the original finding was a shallow-clone artefact | Confirm the release line, then `git checkout main && git merge --ff-only mathew/public-website-rebuild`. **`--ff-only` is the guard**: if it is not a fast-forward, something changed since the diagnosis and the merge stops. **Never use `--allow-unrelated-histories`** | S | Storefront merge, release gate | **No** | **Yes — release authorisation, not a technical decision.** See [33](33_GIT_HISTORY_AND_RELEASE_LINE_DIAGNOSIS.md) §12 |
| **DEP-001** | `docker compose config` has never been run | Parse and interpolation check with a real `.env` | XS | — | No | Supervised |
| **DEP-002** | `caddy validate` has never been run | Syntax and adapter check on `Caddyfile.rc` | XS | — | No | Supervised |
| **QA-005 / DEP-004** | No migration has ever run against a real engine; `0009` has never executed anywhere | Disposable PostgreSQL, every migration plus `ensureSchema()`, confirm `/health` passes | S | — | No | Supervised |
| **SEC-006 / PUB-008** | CSRF is verified through a proxy reproducing Caddy's headers, not through Caddy | Submit all three forms over HTTPS from a real browser; confirm 200 and a `pending` row | S | RC deployed | No | Supervised |
| **DEP-006** | Rollback is documented and never performed | Cut over, then roll back; confirm the storefront returns | S | RC deployed | No | Supervised |
| **PUB-014** | Legacy redirects verified against tests, not against the real URL inventory | Verify at cutover | S | SEC-004 | No | Supervised |
| **E-01 (storefront merge)** | `feat/storefront-catalog-ux-and-homepage` merges cleanly but is gated on a font licence, a data-driven behaviour change and three live links | Merge per [30](30_STOREFRONT_FIX_INTEGRATION.md) §5, then fix the `?v=7`/`?v=8` cache-buster inconsistency and re-run both suites | S | D-01, CAT-004 | No | **Yes — font licence** |

---

## C. Requires business, content or legal input

*Nothing engineering does shortens these. Start them first.*

### C.1 — Legal and privacy (start on day one)

| ID | What is needed | Who | Risk if omitted |
|---|---|---|---|
| **LEG-001 / PUB-010** | **Privacy policy text**, approved by the business's legal adviser | Legal | **Critical** — three public forms collect personal data today |
| **LEG-002** | **Terms text**, approved | Legal | High |
| **LEG-003** | **Consent wording review** for version `2026-08-enquiry-v1` | Privacy owner | High |
| **LEG-004** | **Enquiry retention period** confirmed | Privacy owner | High — gates ENQ-008 and LEG-006 |
| **LEG-008** | Hosting and cross-border processing position documented | Business | Moderate |

> This document identifies the decisions and who must take them. It does not draft binding text and
> is not legal advice.

### C.2 — Public website content (13 routes)

| ID | Route(s) | Risk |
|---|---|---|
| **PUB-001** | **Home** | **Critical** — the home page cannot launch as a placeholder |
| **PUB-002** | Why Veyora | High |
| **PUB-005** | Service model, Private label | High |
| **PUB-009** | Shipping, Warranty and exchanges, Ordering guide | High — these make commercial commitments and must be approved, not drafted by engineering |
| **PUB-011** | Accessibility statement | High — must state the real position; a claim contradicting ACC-002/003/004 is worse than none |
| **PUB-007** | Resources — **decide whether they ship at all.** If yes, needs content *and* a new public endpoint; if no, remove the routes | Moderate |

### C.3 — Commercial and product decisions

| ID | Decision | Risk |
|---|---|---|
| **PRC-006** | **Tax / VAT treatment.** No column, rate or calculation exists anywhere. A distributor shipping across borders normally needs this | **High** |
| **RET-005** | **Is warranty a distinct workflow or a return reason?** No warranty module exists while the public site advertises a warranty page | High |
| **ORD-007** | Is a customer PO reference required? | Moderate |
| **CUS-007 / INT-005** | Does the platform own enquiries, or do they route to a CRM? | Moderate |
| **INT-004** | Must the platform post to an accounting system, or is export enough? | Moderate |
| **PRC-005 / INT-006** | Manual FX rates, or a provider feed? | Moderate |
| **AUTH-012** | Confirm the one-human-per-login expectation | Moderate — audit attribution depends on it |
| **CUS-004** | Territories — recommended as not required at current scale | Low |
| **INT-007** | Carrier API — recommended as not required at current volume | Low |
| **NOT-008** | Communication preferences — required before any marketing email | Low |

### C.4 — Accessibility design decisions

| ID | Decision | Recommendation |
|---|---|---|
| **ACC-003** | 183 contrast occurrences below 4.5:1 | **Raise the alpha token from 0.42 to ~0.52.** One token, clears it everywhere, no layout change |
| **ACC-002** | 20 footer tap targets under 24×24 | Vertical padding on footer navigation; moves the footer's rhythm on every page |
| **ACC-004** | 363 micro labels between 10px and 12px | Not a WCAG failure. Decide with ACC-003 — the same elements are affected |
| **PUB-011** | The development placeholder is also the worst contrast case at 2.65:1 | **Remove it.** It should not ship regardless |

### C.5 — Payment — **SETTLED 2026-08-06**

No open payment decisions remain. Recorded here for traceability:

| Decision | Outcome |
|---|---|
| Payment provider | **Stripe.** Single provider; no abstraction layer over alternatives |
| Timing | Build now against **test keys**; live activation **after handover** |
| Account | Client provides access to an existing Stripe account or creates one (**PAY-009**) |
| Live credentials, webhook registration, payouts, final verification | **Client-owned supervised actions** (**PAY-009 / PAY-010 / PAY-011**). Engineering never holds a live key |
| **Apple Pay / Google Pay** | **Not separate requirements.** Surfaced by Stripe's payment sheet where the device supports it. Nothing to build |
| PDF invoices | **Required** (PAY-005) |
| Auditable settlement updates | **Required** (PAY-013) |
| Invoice payment through Stripe | **Required** (PAY-012) |
| Existing B2B payment terms | **Unchanged and fully supported.** Stripe is added alongside net terms, never instead of them |

Implementation is **WS10** in Group A. The client-owned half is in Groups D and E.

---

## D. Requires supervised real-data work

| ID | Work | Effort | Depends on | Human gate |
|---|---|---|---|---|
| **AUTH-008** | **The capability bootstrap.** Until it is done, every governed screen is unreachable by every account including existing administrators | XS | AUTH-009 | **Yes — production access** |
| **CAT-003** | **Catalogue backfill.** Run the export, audit and review, then apply through the governed API. Nothing can be published until this is done | L | AUTH-008 | **Yes — production access** |
| **QA-006** | **Live-row data-leak verification.** Every scan to date is against fixtures. The reason R-06 cannot close | S | Seeded database | **Yes** |
| **ACC-006** | **Manual accessibility pass** — screen reader, keyboard, focus visibility, alt-text quality, real devices, zoom and reflow | M | — | **Yes** |
| **ACC-009** | Cross-browser pass, Safari at minimum | S | — | **Yes** |
| **CAT-004** | Validate the brand-filter precedence change against real catalogue data before merging the storefront branch | S | — | **Yes** |
| **QA-008** | Load-test the catalogue and public listing paths at realistic volume | M | CAT-007 | **Yes** |
| **QA-009** | Independent security review before public launch | M | Group A | **Yes** |
| **INV-004** | Confirm every receiving, transfer and adjustment path writes a ledger row | S | — | **Yes** |
| **PAY-009** | **Stripe account access.** The client provides access to an existing account or creates one. Blocks activation, **not** development — the integration is buildable and testable in Stripe test mode without it | XS | — | **Yes — client-owned** |

---

## E. Requires supervised deployment

| ID | Work | Depends on | Human gate |
|---|---|---|---|
| **OPS-004** | **Monitoring and alerting.** External uptime monitoring on both hosts and `/api/health`, alerting to a named owner. **The largest operational gap in the audit** | OPS-009 | **Yes** |
| **OPS-005** | **Verify the backup cron actually runs**, and bring `backup.sh` into the repository so it is reviewable | — | **Yes** |
| **OPS-006** | **Perform one full restore** into a disposable database; record the result and elapsed time. An untested backup is not a backup | OPS-005 | **Yes** |
| **DEP-007** | Confirm `PORTAL_DOMAIN` DNS resolves **before** touching Caddy — the portal becomes unreachable the moment it moves | — | **Yes** |
| **DEP-008** | Verify HTTPS certificate issuance for the new host | DEP-007 | **Yes** |
| **DEP-003** | RC deployment with the current storefront preserved | Group B | **Yes** |
| **INT-003** | Configure and verify SMTP, including SPF/DKIM/DMARC alignment | — | **Yes** |
| **INT-001** | Verify Zoho sync and order push against the live account | — | **Yes** |
| **PAY-004** | Verify invoice numbering and currency stamping against a real order | — | **Yes** |
| **SEO-003 / PUB-003 / PUB-004 / PUB-006** | Verify sitemap, brand, collection and location rendering against published records | CAT-003 | **Yes** |
| **REP-005** | Confirm exports honour the same data-minimisation rules as the screens | — | **Yes** |
| **PAY-010** *(registration half)* | **Register the webhook endpoint with Stripe and install the signing secret in production.** The endpoint itself is built in WS10; only registration is client-owned | PAY-009, WS10 | **Yes — client-owned** |
| **PAY-011** | **Payout configuration, production key installation and final live verification** with a real transaction. The last step before taking real money | PAY-009, PAY-010 | **Yes — client-owned** |

---

## F. Accepted post-handoff enhancements

Deliberately deferred. None blocks handoff or launch.

| ID | Item | Note |
|---|---|---|
| **CMS-007** | Content preview | Valuable, not launch-critical |
| **CMS-008** | Scheduling and bulk publication | `scheduled_review_at` exists; nothing acts on it |
| **AUTH-011** | Access review reporting | Low urgency at six capabilities and a handful of staff |
| **CAT-011** | Related products | Useful for internal linking and SEO |
| **ENQ-007** | Enquiry assignment | Add when volume justifies it |
| **REP-003** | Enquiry aggregate reporting | As above |
| **REP-004** | Permission and publication reporting | As above |
| **MED-006** | Orphan media handling | Start reporting-only, before any deletion job |
| **ACC-008** | `prefers-reduced-motion` | Add where animation exists |
| **LEG-007** | Audit-log retention policy | State a period; do not delete without a decision |
| **NOT-008** | Communication preferences | All current email is transactional |
| **OPS-003** | Structured logging with request ids | Preserve the deliberate no-payload-logging on the enquiry path |
| **OPS-007** | Scheduled-job status visibility | So a silently stopped scheduler is visible |
| **CAT-007** | Move authenticated catalogue filtering to SQL | Fine at 996 products; not at scale |
| **MED-004** | Responsive image derivatives and `srcset` | Real performance and cost benefit |
| **CUS-006** | Minimum-disclosure discipline on the general admin snapshot | The permissions endpoint already demonstrates the pattern |

---

## G. Not applicable or intentionally excluded

| ID | Item | Why |
|---|---|---|
| **Apple Pay / Google Pay** | Wallet checkout as a **separate** deliverable | **Not a separate requirement** by the approved decision. Stripe's payment sheet surfaces them where the device and browser support it, so there is nothing distinct to design, build, test or maintain. They are not a line item anywhere in this backlog |
| **Multi-provider payment abstraction** | A layer over Stripe plus alternatives | Stripe is the single approved provider. An abstraction over one provider is cost with no benefit |
| **INT-007** | Carrier API integration | Manual tracking entry is adequate at current volume |
| **CUS-004** | Territories | `agent_id` ownership is sufficient at current scale |
| **PAY-003** *(dropping the column)* | Deleting `payments.stripe_payment_intent` | Was recommended-against as destructive; now **actively wanted** — the approved decision gives the column a purpose. Extend it (WS10), do not drop it |
| **REU-015** | Reusing the whole-database admin sync pattern | It is the root of SEC-002, SEC-015 and PAY-006. Works at this scale; do not carry it to a new project |

---

## Suggested sequencing

1. **Day one:** start Group C.1 (legal) and C.2 (content), **and ask the client for Stripe account
   access (PAY-009)**. All three have external lead times that nothing engineering does shortens.
2. **WS3** — security hardening. Four P0s, all unattended-suitable, no dependencies.
3. **WS4** — the outbox. One mechanism closes six findings, including the most commercially damaging
   one. WS10's webhook work benefits from the same idempotency discipline.
4. **WS10** — Stripe, in test mode. Independent of PAY-009, so it does not wait on the client.
   Sequence within it: PAY-002 → PAY-010 → PAY-013 → PAY-012, with PAY-005 in parallel.
5. **WS7 / Group E** — monitoring, alerting and a tested restore. Cheap, and the difference between
   an outage measured in minutes and one measured in a customer's phone call.
6. **Group B** — the RC verification sequence. **DEP-009 is no longer the blocker it appeared to
   be**: the lineage is proven, so this is now confirm-and-authorise rather than investigate. Run the
   storefront merge, then the release gate, then the `--ff-only` merge.
7. **Group D** — bootstrap, then backfill, then the live-row scan, in that order. Each gates the next.
8. **WS5, WS6** — aftersales and commercial data integrity. Substantial, and neither blocks the
   public launch.
9. **Group E, Stripe half** — PAY-010 registration and PAY-011 payout configuration, **after
   handover**, client-owned.
10. **Group F** — as capacity allows.

---

## Security Hardening Workstream — completed 2026-08-06

WS3 is **done**, plus two items that were elsewhere in this backlog. Detail:
[34_SECURITY_HARDENING.md](34_SECURITY_HARDENING.md).

| ID | Was | Now |
|---|---|---|
| **AUTH-002** | P0 · Secure flag derived from `PUBLIC_URL` | **COMPLETE** — explicit `COOKIE_SECURE`, secure by default in production |
| **AUTH-004 / SEC-011** | P0 · no rate limiting | **COMPLETE** — bounded per-client and per-account limits on all seven sensitive endpoints |
| **SEC-004** | P0 · three R-01 link fallbacks | **COMPLETE** — all six sites use the explicit origin contract; gate exceptions deleted |
| **SEC-002** | P0 · warehouse writes 17 of 18 collections | **COMPLETE** — sync is admin-only; narrow `/admin/inventory` routes replace it |
| **SEC-015** | P1 · audit log editable | **COMPLETE** — append-only triggers, removed from the syncable set |
| **REP-007** | P1 · Undo control misstates the log | **COMPLETE** — removed |
| **AUTH-009** | P1 · no capability archetypes | **partially addressed** — the bootstrap planner enforces the structural rules; the archetype *allocation* is still a business decision (Group C) |

### Three findings not in the audit, found and fixed

1. **`trust proxy` was `true`** — Express took `req.ip` from a client-controlled header, which would
   have made every rate limit decorative. Now an explicit hop count. *A prerequisite, not an extra.*
2. **The OTP verifiers had no attempt limit** — a six-digit code with a 15-minute lifetime, which is
   a sharper path to account takeover than the login endpoint. Strictest policy in the limiter.
3. **A bare production IP in the compose default** that the host scan could not see. The scan now
   detects bare routable IPv4 addresses; this one is declared with a reason.

### Still open, and unchanged by this workstream

`SEC-007` CSRF defence in depth · `SEC-010` CSP · `SEC-013` dependency audit · `SEC-016` open-redirect
confirmation · `SEC-017`/`MED-002` upload content verification.

### New follow-up created by this work

**The admin panel needs a UI change for warehouse logins.** A warehouse user now receives a 403 from
`POST /admin/sync`; the panel should show the inventory screens rather than a failed save. A
usability regression for that role, not a security one.
