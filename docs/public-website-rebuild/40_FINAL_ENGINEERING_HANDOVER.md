# 40 — Final Engineering Handover

**Branch:** `mathew/public-website-rebuild`
**Nothing was pushed, merged, deployed, or run against production.**

---

## 1. What this run did

Seven implementation phases, each ending in a local checkpoint commit.

| Phase | Outcome | Commit |
|---|---|---|
| 1 | Durable enquiry notification delivery | `93cdf1d` |
| 2 | Governed store contact management | `3f0eef9` |
| 3 | Stripe invoice payment foundation | `650e292` |
| 4 | Auditable finance operations | `aaa2c74` |
| 5 | Production invoice PDFs | `241d680` |
| 6 | Account statements and delivery | `baaa1d6` |
| 7 | Duplicate-submission and reliability sweep | `f42fed2` |

| Suite | Start | End |
|---|---|---|
| API | 1,229 | **1,659** |
| Admin panel | 213 | **298** |
| Public website | 466 | **466** |
| **Total** | **1,908** | **2,423 passing, 0 failing** |

Release gate: **17/17** throughout.

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
| Enquiry operations | `27_ENQUIRY_OPERATIONS.md` |
| Security hardening | `34_SECURITY_HARDENING.md` |

Six migrations, **0011–0016**, all additive: no drop, no truncate, no delete, no column retype, no
default change. Every one mirrored idempotently in `ensureSchema()`.

---

## 4. Capabilities

Seventeen keys. **None is granted by any migration.**

| Family | Keys |
|---|---|
| Public content | `public_content.view` / `.edit` / `.publish` |
| Permissions | `permissions.manage` |
| Enquiries | `enquiries.view` / `.manage` |
| Store contacts | `customer_contacts.view` / `.manage` |
| Payments | `payments.view` / `.collect` / `.refund` / `.reconcile` |
| Finance | `finance.invoice` / `.record` / `.credit` / `.reconcile` |
| Statements | `statements.send` |

Two separations worth understanding, because they look like over-engineering and are not:

- **`payments.collect` ≠ `payments.refund`.** Asking a customer to pay and sending money back are
  different jobs.
- **`finance.record` ≠ `finance.credit`.** *"We received £4,000"* and *"we have decided they owe
  £4,000 less"* look identical on a balance and are completely different events. The person who keys
  in bank transfers all day should not be able to forgive a debt.

---

## 5. Dependency security

### Current position

`npm audit` in `platform/server/api` reports **one high-severity advisory against `nodemailer`**
(installed range `^6.9.13`; the advisory covers `<= 9.0.0`). The two dependencies added in this run —
`stripe@22.4.0` and `pdf-lib@1.17.1` — contribute nothing to it; Stripe has zero runtime
dependencies.

### What was done about it

See the Phase 9 record in `FINAL_ENGINEERING_HANDOVER_PROGRESS.md` for the attempted upgrade, its
outcome, and the exact decision taken. **Do not treat this section as complete without reading
that.**

### What reduces the exposure regardless

The advisories concern header injection, transport-name injection, and file/URL access in
`jsonTransport` and the `raw` message option. Veyora's usage is narrow:

- one `sendMail()` call site, in `src/notifications/delivery.js`;
- subject, HTML and text come from a **fixed template set** with an allowlisted data shape — no
  caller-supplied header, no `raw` option, no `envelope`;
- the recipient is validated against an address pattern before the adapter is called;
- attachments are `Buffer`s built by the application, never a path the library reads.

That is a mitigation, not a fix, and it is recorded as such.

---

## 6. Prepared work not applied

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

---

## 8. What did not happen

No production access. No VPS access. No live database connection. No DNS change. No deployment. No
capability bootstrap SQL executed. No permission granted to a real account. No real catalogue or
customer data processed. No real email sent. No live Stripe key used. No real Stripe API call. No
live webhook registered. No branch merged. No fast-forward of `main`. **No push.**

---

## 9. Where to start

- Reviewing the code → `40B_WEEKEND_REVIEWER_START_HERE.md`
- Activating the platform → `40A_CLIENT_ACTIVATION_CHECKLIST.md`
- Understanding a subsystem → `38`, `39`, `41`, `42`
- The full phase-by-phase record → `FINAL_ENGINEERING_HANDOVER_PROGRESS.md`
