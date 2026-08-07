# 40A — Client Activation Checklist

**Everything in this document is OUTSTANDING.** Nothing here has been done, and nothing here *could*
be done by engineering — each item needs a business decision, a credential, or an action against a
live system.

The software is built and tested for every one of these. What is missing is the input.

---

## How to read this

| Column | Meaning |
|---|---|
| **Blocks** | What stays unavailable until this is done |
| **Who** | The client, or Veyora's engineer acting on the client's instruction |
| **Evidence** | What "done" looks like |

Nothing below is marked complete. Do not treat any of it as done.

---

## A. Payments (Stripe)

| # | Action | Blocks | Who | Evidence |
|---|---|---|---|---|
| A1 | **Decide: existing Stripe account or a new one.** If Veyora already takes card payments anywhere, reusing that account keeps payouts and reporting in one place. | Everything below | Client | A written decision |
| A2 | **Supply Stripe access** — an account invitation for whoever will configure it. Do not email keys. | A3–A7 | Client | Access confirmed |
| A3 | **Complete Stripe identity and business verification.** Stripe will ask for company registration, ownership and a bank account. This can take days. | Live payments | Client | Stripe dashboard shows the account activated |
| A4 | **Configure payouts** — bank account, payout schedule, statement descriptor. The descriptor is what a customer sees on their card statement; make it recognisably Veyora. | Money reaching Veyora | Client | Payout settings saved |
| A5 | **Provide TEST keys first.** `sk_test_…` and the webhook signing secret. | Test-mode verification | Client | `STRIPE_ENABLED=true` with test keys on the RC deployment |
| A6 | **Register the webhook endpoint** at `https://<portal host>/api/webhooks/stripe`, subscribed to: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`. | Any settlement at all | Client / engineer | Stripe dashboard shows the endpoint receiving 200s |
| A7 | **Provide LIVE keys only after test-mode acceptance.** A live key outside production is refused by the software; that is deliberate. | Live payments | Client | Production `.env` updated, service restarted |

> The API boots and B2B ordering works normally with none of this done. Payment actions report that
> online payment is switched off.

---

## B. Email delivery

| # | Action | Blocks | Who | Evidence |
|---|---|---|---|---|
| B1 | **Choose and configure an email provider.** `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`. | Every notification | Client | A test enquiry shows **Delivered** on the Enquiries screen |
| B2 | **Set up SPF, DKIM and DMARC** for the sending domain. | Deliverability | Client | An external mail-authentication check passes |
| B3 | **Provide operational enquiry recipients** — `ENQUIRY_ALERT_EMAILS`. Who should be told when a website enquiry arrives? | Enquiry alerts reaching a person | Client | Real addresses in `/opt/veyora/.env` |
| B4 | **Provide order alert recipients** — `ORDER_ALERT_EMAILS`. The example placeholder is filtered out at runtime and must be replaced. | Order alerts | Client | Real addresses configured |

> Until B1 is done, notifications **queue** rather than send, and the Enquiries screen shows
> "not configured". Nothing is falsely reported as delivered.

---

## C. Invoice and statement identity

Nineteen configuration fields. **None has a default** — the software omits an unset field rather than
inventing one.

| # | Action | Blocks | Who |
|---|---|---|---|
| C1 | **Registered legal name** (`VEYORA_LEGAL_NAME`) — must match the company register | A compliant invoice | Client |
| C2 | **Company registration number** (`VEYORA_COMPANY_NUMBER`) | A compliant invoice | Client |
| C3 | **VAT / tax registration number** (`VEYORA_TAX_NUMBER`) | Any invoice charging tax | Client |
| C4 | **Registered address** — line 1, city, postcode, country (region and line 2 optional) | A compliant invoice | Client |
| C5 | **Billing contact email** (`VEYORA_CONTACT_EMAIL`) | Customers replying to an invoice | Client |
| C6 | **Bank details** — name, account name, IBAN/account, SWIFT/BIC. All or nothing: an invoice with no bank block is normal, one with half a block is not | Offline payment instructions | Client |
| C7 | **Invoice footer / legal text** — retention of title, late-payment terms. No default wording is shipped; this is the client's to supply, ideally reviewed by their accountant or solicitor | Legal completeness | Client |
| C8 | **Logo file** (`VEYORA_INVOICE_LOGO`) — a PNG or JPEG path on the server. Absent falls back to the wordmark | Branded documents | Client |

**The admin panel reports every unset required field**, so this checklist can be verified against the
running system rather than against this document.

---

## D. Invoice visual acceptance

| # | Action | Blocks | Who |
|---|---|---|---|
| D1 | **Supply the approved invoice from the previous Veyora system.** Place it at `source-assets/invoice-reference/approved-invoice-reference.pdf`. | D2 | Client |
| D2 | **Approve the final visual match.** The generated invoice is a clean neutral Veyora template with every functional behaviour complete; matching it to the historical layout needs the reference. | Visual sign-off only — invoices generate correctly now | Client |

> This is a **visual acceptance dependency, not an unfinished generator.**

---

## E. Tax

| # | Action | Blocks | Who |
|---|---|---|---|
| E1 | **Decide the tax/VAT rules** — which customers, which rates, reverse charge for intra-EU B2B, and how export sales are treated. This is an accounting decision, not an engineering one. | Correct tax on invoices | Client + accountant |
| E2 | **Enter the decided rules.** Tax currently comes through from the order record; if per-customer or per-jurisdiction rates are needed, that is a scoped change once E1 is answered. | Automated tax | Client, then engineering |

---

## F. Permissions

**No account holds any capability.** No migration grants one. This is deliberate — the whole point of
the capability system — and it means the first grant is a supervised bootstrap.

| # | Action | Blocks | Who |
|---|---|---|---|
| F1 | **Assign at least TWO `permissions.manage` holders.** Two, so losing one person does not lock the organisation out of its own permission system. Use `scripts/plan-permission-bootstrap.js` — it plans and renders SQL for review and contacts no database | Every other grant | Client + engineer |
| F2 | Assign **content** capabilities: `public_content.view` / `.edit` / `.publish` | Editing and publishing the public site | Client |
| F3 | Assign **enquiry** capabilities: `enquiries.view` / `.manage` | Reading and handling website enquiries |Client |
| F4 | Assign **contact** capabilities: `customer_contacts.view` / `.manage` | Store contact management | Client |
| F5 | Assign **payment** capabilities: `payments.view` / `.collect` / `.refund` / `.reconcile`. Keep `payments.refund` narrow — it moves money out | Payment operations | Client |
| F6 | Assign **finance** capabilities: `finance.invoice` / `.record` / `.credit` / `.reconcile`. Keep `finance.credit` separate from `finance.record`: recording money that arrived and forgiving a debt are different decisions | Finance operations | Client |
| F7 | Assign `statements.send` | Emailing statements | Client |
| F8 | **Retire the invoice bootstrap.** `POST /admin/orders/:id/invoice` currently keeps an admin-role gate because nobody holds `finance.invoice` yet. Once F6 is done, retire it and point the order screen at the capability-gated route. See `41_FINANCE_OPERATIONS.md` §6 | Full capability governance | Engineer |

---

## G. Data migration

| # | Action | Blocks | Who |
|---|---|---|---|
| G1 | **Run the store-contact migration review.** `scripts/plan-store-contacts.js` proposes primary contacts from legacy customer fields and **applies nothing**. It never infers a job title or responsibility, never proposes an empty contact, and a record it marks `skip` cannot be approved into existence. Open the CSV, check every row, type `yes` where you vouch for it | Store contacts existing at all | Client |
| G2 | **Create approved contacts** through the governed API. There is no bulk applier, deliberately | | Client / engineer |
| G3 | **Run the catalogue audit / backfill.** See `23_CATALOGUE_BACKFILL_PLAN.md` | Public catalogue completeness | Client |
| G4 | **Approve legal content** — privacy policy, terms, cookie wording on the public site | Public launch | Client + solicitor |

> No real customer data has been processed. The planner has only ever been run against invented
> example.test records.

---

## H. Deployment

| # | Action | Blocks | Who |
|---|---|---|---|
| H1 | **Rehearse the database migrations** on a copy of production data. Sixteen migrations exist; 0011–0016 are new in this run. All are additive — no drop, no truncate, no delete — but rehearsing is how you find out what a real dataset does | Safe deployment | Engineer |
| H2 | **Deploy the release candidate.** `Caddyfile.rc` ships beside the live `Caddyfile`; the cutover is one deliberate line on the server | RC testing | Engineer |
| H3 | **Test on the RC:** HTTPS and certificates; session cookies carry `Secure`; every public form submits and appears in Enquiries; a test-mode Stripe payment completes and the webhook settles the invoice; an invoice PDF downloads; a statement sends and shows **Delivered** | Production confidence | Client + engineer |
| H4 | **Approve the production cutover.** | Go-live | Client |

---

## I. Known limitations carried forward

| Item | Detail |
|---|---|
| **Nodemailer advisory** | See `40_FINAL_ENGINEERING_HANDOVER.md` for the current status and what was attempted |
| **Storefront payment control** | The "Pay securely" button is a **prepared patch**, not applied — `platform/server/storefront/` is protected because another developer is working there. The customer payment APIs are complete and tested. Patch at `docs/public-website-rebuild/prepared-patches/storefront-invoice-payment.patch` |
| **Public-form throttle key** | Keyed on the Astro container's IP rather than the visitor's, so the 8-per-window budget is shared across all visitors. An availability concern, not a duplication one — the duplicate guard is separate and works |
| **Order state machine** | `pending → shipped → pending` is currently permitted. A missing *transition* guard, not a duplicate-submission hazard |

---

## J. Sign-off

Nothing in this document is complete. When each section is done, record who did it and when — this
file is the record, not a summary of one.
