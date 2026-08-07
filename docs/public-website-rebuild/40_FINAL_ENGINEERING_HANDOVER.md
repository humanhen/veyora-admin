# 40 — Final Engineering Handover

**Branch:** `mathew/public-website-rebuild`
**Nothing was pushed, merged, deployed, or run against production.**

---

## 1. What this run did

Seven implementation phases plus a regression phase, each ending in a local checkpoint commit.

| Phase | Outcome | Commit |
|---|---|---|
| 1 | Durable enquiry notification delivery | `93cdf1d` |
| 2 | Governed store contact management | `3f0eef9` |
| 3 | Stripe invoice payment foundation | `650e292` |
| 4 | Auditable finance operations | `aaa2c74` |
| 5 | Production invoice PDFs | `241d680` |
| 6 | Account statements and delivery | `baaa1d6` |
| 7 | Duplicate-submission and reliability sweep | `f42fed2` |
| 8 | Handover documentation package | `3580223` |
| 9 | Nodemailer upgrade (isolated) | `4853611` |

| Suite | Start | End |
|---|---|---|
| API | 1,229 | **1,669** |
| Admin panel | 213 | **298** |
| Public website | 466 | **466** |
| **Total** | **1,908** | **2,433 passing, 0 failing** |

Release gate: **18/18** at the end — a `critical-invariants` gate was added in Phase 9, proved by
injecting three real regressions and confirming each was caught.

---

## 2. The defects this run closed

Not features — things that were **wrong**.

| # | Defect | Where it came from |
|---|---|---|
| 1 | **An enquiry was stored, the visitor was told it was received, and nothing was ever sent.** No queue, no worker, no recipient configuration, no way to find out | ENQ-006 / NOT-006 |
| 2 | **`mail.js` returns `{ logged: true }` and prints the message body when unconfigured** — indistinguishable from a send, so any status built on it would have reported success for every enquiry ever received | Pre-existing |
| 3 | **`users` conflated the store, one person, and the login.** Replacing a buyer meant editing the login email | Pre-existing |
| 4 | **Money moved through a whole-database row diff.** A browser could set a balance to any number, and a stale tab's `deletes` list could remove every payment recorded since it loaded | Pre-existing |
| 5 | **The payment form offered `method: 'credit card'`** — with a space. The CHECK constraint lists `credit_card`; PostgreSQL would have refused the write | Pre-existing |
| 6 | **"Download PDF" was a toast saying no document existed** | Pre-existing |
| 7 | **"Send to Customer" emailed nothing and wrote an audit line saying it had.** A false record is worse than no button | Pre-existing |
| 8 | **Statements reported today's balance as any past period's closing balance** — the arithmetic ran backwards from the current balance | Pre-existing |
| 9 | **Public enquiries had no server-side duplicate guard at all.** A refresh, a second tab, or scripting being off each produced a second enquiry and a second alert | Pre-existing |
| 10 | **The inventory CSV import doubled every `adjust` delta** on a second click. No guard at all, not even `disabled` | Pre-existing |
| 11 | **Every stock adjustment wrote `variation_id = NULL`.** Snake_case keys passed to a camelCase reader — an unattributable movement is exactly what you need to detect a duplicate | **My own**, from the security-hardening batch |
| 12 | **An emoji in a customer's business name would have 500'd their invoice download.** `widthOfTextAtSize()` throws on an unencodable character, and one draw path measured unsanitised text | **My own**, Phase 5, caught by its own tests |
| 13 | **A dead `invoice_number_seq` sync entry** that read like a supported path | **My own**, surfaced by a Phase 4 test |

Items 11–13 are mine. They are listed with the rest because a handover that only records other
people's mistakes is not a handover.

---

## 3. Architecture added

| Area | Document |
|---|---|
| Stripe payments | `38_STRIPE_PAYMENT_ARCHITECTURE.md` |
| Invoices and statements | `39_INVOICE_AND_STATEMENT_SYSTEM.md` |
| Finance operations | `41_FINANCE_OPERATIONS.md` |
| Duplicate-submission sweep | `42_DUPLICATE_SUBMISSION_SWEEP.md` |
| Migration / runtime schema parity | `43_SCHEMA_PARITY.md` |
| Enquiry operations | `27_ENQUIRY_OPERATIONS.md` |
| Security hardening | `34_SECURITY_HARDENING.md` |

Migrations **0011–0019**, all additive: no drop, no truncate, no delete, no column retype, no
default change. Every one mirrored idempotently in `ensureSchema()`, and a structural parity suite
compares the two definitions object by object (`43_SCHEMA_PARITY.md`).

---

## 4. Capabilities

Nineteen keys. **None is granted by any migration.**

| Family | Keys |
|---|---|
| Public content | `public_content.view` / `.edit` / `.publish` |
| Permissions | `permissions.manage` |
| Enquiries | `enquiries.view` / `.manage` |
| Store contacts | `customer_contacts.view` / `.manage` |
| Payments | `payments.view` / `.collect` / `.refund` / `.reconcile` |
| Finance | `finance.invoice` / `.record` / `.credit` / `.reconcile` |
| Statements | `statements.send` |
| Credit | `finance.credit_limit` / `finance.credit_review` |

Two separations worth understanding, because they look like over-engineering and are not:

- **`payments.collect` ≠ `payments.refund`.** Asking a customer to pay and sending money back are
  different jobs.
- **`finance.record` ≠ `finance.credit`.** *"We received £4,000"* and *"we have decided they owe
  £4,000 less"* look identical on a balance and are completely different events. The person who keys
  in bank transfers all day should not be able to forgive a debt.

---

## 5. Dependency security

### Position at the end of the run

**`npm audit` reports 0 vulnerabilities.**

During the run it reported one high-severity advisory against `nodemailer` (installed 6.10.1 under
`^6.9.13`; the advisory covers `<= 9.0.0`). The two dependencies added — `stripe@22.4.0` and
`pdf-lib@1.17.1` — contributed nothing to it; Stripe has zero runtime dependencies.

### Resolved

**Upgraded to `nodemailer@9.0.4` in an isolated checkpoint (`4853611`). `npm audit` now reports 0
vulnerabilities.**

It was isolated on purpose: had it broken anything, reverting one checkpoint would have restored a
working implementation without touching seven phases of work. It did not break anything. The API
surface Veyora uses is exactly two calls — `createTransport({host, port, secure, auth})` and
`sendMail({from, to, subject, html, text, attachments})` — both nodemailer core, unchanged across
6 to 9. There are two construction sites and no use of `jsonTransport`, the `raw` message option,
`envelope`, or a caller-supplied transport name, which is what the advisories concern.

Verified: 0 vulnerabilities; a real nodemailer 9 transport constructs and the SMTP adapter reports
`configured`; 129 focused notification and email tests pass; all three suites and the release gate
unchanged. No SMTP credential was used and no email was sent.

### What reduces the exposure regardless

The advisories concern header injection, transport-name injection, and file/URL access in
`jsonTransport` and the `raw` message option. Veyora's usage is narrow:

- one `sendMail()` call site, in `src/notifications/delivery.js`;
- subject, HTML and text come from a **fixed template set** with an allowlisted data shape — no
  caller-supplied header, no `raw` option, no `envelope`;
- the recipient is validated against an address pattern before the adapter is called;
- attachments are `Buffer`s built by the application, never a path the library reads.

That narrowness is why the upgrade carried so little risk, and it remains true after it.

---

## 6. Prepared work — SINCE APPLIED

> **Closed on 2026-08-07.** The patch below was applied during the final integration run, once the
> other developer's storefront work was formally consolidated and the protected-storefront boundary
> was retired for its stated reason. It ships with 12 tests of its own, and the five guards that
> matter — the state check, the double-click guard, the fail-closed missing-URL path, the id
> encoding and the account-terms note — were each proved by injecting the regression. See
> `44_BRANCH_INTEGRATION_REPORT.md`. The rest of this section is kept as the record of why it
> waited.

**`docs/public-website-rebuild/prepared-patches/storefront-invoice-payment.patch`** (97 lines).

A "Pay securely" control for the customer's account page: shown only for a payable invoice,
per-state notes for paid / confirming / refunded / cancelled, a double-click guard, and a standing
note that card payment is optional and changes nothing about account terms.

**Not applied** because `platform/server/storefront/` is protected by a repository guard whose stated
reason is *"the storefront, which another developer is working on"*. Editing it would create a
conflict for that developer; editing the guard to permit it is exactly the reflexive widening the
guard's own comment warns against.

**The customer payment API is complete and tested**: `GET /user/invoices/:id/payment` returns the
state with a payability verdict and a reason, `POST /user/invoices/:id/pay` returns a hosted link for
the caller's **own** invoice, and `/user/invoices` carries `settlementState`.

**This needs supervised storefront integration.** It is the one item of Phase 3 left for the client.

---

## 7. Engineering blockers remaining

**None.** Every phase completed. The items below are decisions and credentials, not code:

1. The invoice's final visual match needs the historical reference PDF (§ `39`, §D of `40A`).
2. The storefront patch needs a supervised window when the other developer is not mid-change.
3. Tax rules beyond what the order record carries need an accounting decision.
4. The `finance.invoice` bootstrap should be retired once capabilities are granted
   (`41_FINANCE_OPERATIONS.md` §6).

### The schema-parity finding — CLOSED

The Phase 9 sweep recorded that migrations 0003, 0004 and 0005 were not mirrored in
`ensureSchema()`. **That is now fixed**, in the Final Release Correction.

The gap was six objects: `return_items.exchange_sku` (0003), the `purchase_orders` table and
`po_number_seq` sequence (0004), and `orders.zoho_so_id` (0005). Every one is used at runtime —
`po_number_seq` is read by `seqNext()` on **every `/admin/snapshot`** call, so a database
lacking it fails the request that loads the entire admin panel.

All six are now created idempotently in `ensureSchema()`, and a structural parity suite
(`test/schema-parity.test.js`, 10 tests) parses both definitions and compares them object by
object — so the *next* migration is covered without anybody remembering to extend a list. Proved by
injecting five regressions, including a brand-new unmirrored migration; all five were caught.

Two migrations remain deliberately migration-only, each with a stated and tested reason:

| Migration | Why it is not mirrored |
|---|---|
| `0001_schema.sql` | It **is** the database. Mirroring it would mean a second complete copy of the schema in JavaScript. A test asserts `ensureSchema` never creates a core table |
| `0002_views.sql` | Reporting views only. A test asserts no API source reads them — if that ever changes, the exclusion fails |

See `43_SCHEMA_PARITY.md`.

---

## 8. What did not happen

No production access. No VPS access. No live database connection. No DNS change. No deployment. No
capability bootstrap SQL executed. No permission granted to a real account. No real catalogue or
customer data processed. No real email sent. No live Stripe key used. No real Stripe API call. No
live webhook registered. No branch merged. No fast-forward of `main`. **No push.**

---

## 8A. Since this handover — the integration and client-feedback run

Two further runs landed on `mathew/final-integration-2026-08-07`:

| Run | Document |
|---|---|
| Branch consolidation (the second developer's storefront work) | `44_BRANCH_INTEGRATION_REPORT.md` |
| Client feedback items A–M | `45_CLIENT_FEEDBACK_IMPLEMENTATION.md` |
| Commercial credit control and portal privacy | `46_COMMERCIAL_CREDIT_AND_PRIVACY.md` |
| Credit operations — limit UI and review workflow | `47_CREDIT_OPERATIONS.md` |
| Handover exhaustion — what is left, and for whom | `48_HANDOVER_EXHAUSTION.md` |
| Production activation, step by step | `49_PRODUCTION_ACTIVATION_RUNBOOK.md` |
| The short list of client inputs | `49A_CLIENT_INPUTS_REQUIRED.md` |

Totals moved from **2,433** to **2,720 passing, 0 failing**; the release gate is still 18/18. One
migration, **0017**, adds a nullable `users.credit_limit` — mirrored in `ensureSchema()`, with the
parity contract verified by tampering before the mirror was written.

Three pre-existing defects worth flagging to anyone reading this document for the first time:
a return's **price came from the request body**; a return could cite **any customer's order**; and
`shipping_address` was the browser's word for it and usually NULL, which forced every screen to
fall back to the customer's *current* profile address. All three are closed.

---

## 9. Where to start

- Reviewing the code → `40B_WEEKEND_REVIEWER_START_HERE.md`
- Activating the platform → `40A_CLIENT_ACTIVATION_CHECKLIST.md`
- Understanding a subsystem → `38`, `39`, `41`, `42`
- The full phase-by-phase record → `FINAL_ENGINEERING_HANDOVER_PROGRESS.md`
