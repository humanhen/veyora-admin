# Veyora PM SOW — Gap Analysis vs. the veyora.design platform

Source: *Veyora PM — Expanded Statement of Work*, Draft v1.0, dated May 05 2026.
Analysed against this repo at commit `8b7b763` on 2026-07-21.

Every claim below was verified by reading code. Status values:

| Status | Meaning |
|---|---|
| **DONE** | Built, wired to the database, works |
| **PARTIAL** | Real but narrower than the SOW asks for |
| **STUB** | UI exists and looks finished; does nothing on the server |
| **ABSENT** | No table, no column, no code |

---

## 0. Read this first — the SOW does not describe this codebase

SOW §2 "Current Platform Context" lists the app to be extended. It does not match
what is in this repo:

| SOW §2 says | This repo is |
|---|---|
| React 18, Vite, TypeScript, Tailwind, zustand | Vanilla JS SPA, no framework, no build step |
| Firebase Auth, Firestore, Cloud Functions Gen 2, Firebase Hosting | Express, Postgres 16, Caddy, Docker on an IONOS VPS |
| Firestore collections (`crmAccounts/{id}`, …) — SOW §6 | Relational Postgres, 5 SQL migrations |
| QuickBooks US + QuickBooks Canada — SOW §4.12 | Zoho Inventory (live sync + order push) |
| "Granular per-feature permission toggles" | Six role strings, no permission table |
| Warehouses: New York (master) + Montreal | `wh_main` "Main Fulfillment", `wh_reserve` "Reserve (backstock)" — `0001_schema.sql:477` |

SOW §11.1 assumes *"the existing Veyora PM application remains the base application
and will be expanded rather than replaced"*, and §11.2 makes the project dependent on
*"access to the existing Veyora PM repository and Firebase project."*

**No Firebase project or React/Vite Veyora codebase exists on this machine.**
`veyora-admin` is the only Veyora repo present.

This must be resolved before estimating. Either the SOW targets a different
application, or §2/§11.1 are wrong and much of this is greenfield on Postgres
rather than an extension. The functional analysis below holds either way.

---

## 1. Scorecard

Of 16 main modules and 17 Appendix C sections:

- **Substantially done:** 6 — catalog/stock, sales orders (core), backorders, returns, B2B portal basics, purchasing
- **Partial:** 11 — auth, CRM, tasks, inventory, fulfilment, billing, reporting, price rules, commissions, KPIs, notifications
- **Absent:** 12 — warranty module, QuickBooks, territories, contracts/policy engine, return-credit engine, consignment, marketing automation, carrier integration, multi-currency, multi-language, KPI targets, stock ledger
- **Stubbed (looks done, isn't):** 12 discrete features — enumerated in §5

The single largest misconception risk: **the admin panel demos convincingly but a
dozen of its buttons only raise a toast.** Anyone shown a walkthrough would
reasonably conclude those features are finished.

---

## 2. Main SOW modules (§4)

### 4.1 Authentication and User Management — PARTIAL

| Requirement | Status | Evidence |
|---|---|---|
| Email/password login | DONE | `auth.js:23`, bcrypt, JWT access+refresh cookies |
| Google sign-in for internal users | **ABSENT** | No OAuth of any kind |
| Invitation / approval workflow | PARTIAL | Agent creates customer → activation email → OTP → set password (`agent.js:35`, `auth.js:74-110`). No approval step |
| Active/inactive state, password reset | DONE | `status` CHECK `pending\|active\|disabled`, re-checked on every request (`authmw.js:79`) |
| 7 role profiles | PARTIAL | 6 exist: customer, special customer, agent, super-agent, warehouse, admin (`0001:41`). **Missing: Manager, Accounting User, Read-Only Executive** |
| Permission-based access | **ABSENT** | No permission table, no scopes, no per-feature toggles. Authorization is role-string membership + hand-written SQL scoping |
| Login audit history | DONE | `audit_log` (`0001:350`), written on login/orders/password changes/Zoho sync |

### 4.2 CRM — Leads, Accounts, Partners, Pipelines, Territories — PARTIAL

| Requirement | Status | Evidence |
|---|---|---|
| Leads | DONE | `leads` table (`0001:298`) — stage, 1-5 rating, agent, questionnaire, visits. Full admin UI at `pages_customers.js:279` |
| Lead → account conversion | PARTIAL | Manual button (`pages_customers.js:381`). SOW wants **automatic** conversion on first order |
| Accounts as distinct entities | **ABSENT** | No accounts table. `users` doubles as the account record |
| Partners / buying groups / separate pipelines | **ABSENT** | `chains` (`0001:313`) gives parent/branch grouping only — no pipeline, no partner type |
| Contacts (multiple per account) | **ABSENT** | No contacts table. `leads.contact` is one text field; `users` has one name |
| Territories + maps | **ABSENT** | No table, column, or code. Assignment is the flat `users.agent_id` FK |
| Activities (visits/calls/meetings) | PARTIAL | Three disconnected logs: `leads.visits jsonb` (**no code reads or writes it**), collection activity timeline (`pages_finance.js:190`), order comments. No activities table, no unified timeline, no activity types |
| Payment terms, credit limit, currency, price list, tax region | PARTIAL | `payment_terms` stored + displayed, **never enforced**. **No credit limit column** — `place-order` reads no balance. No currency, no tax region |

### 4.3 CRM Activities and Rep KPI Tracking — PARTIAL
Reporting exists (`pages_sales.js:1031` — by customer/item/agent/city; agent revenue at
`pages_ops.js:269`; SQL views in `0002_views.sql`). But **KPI targets are ABSENT** —
no targets table, no target column. Everything is actuals with nothing to compare
against. Rep scorecards with period filters exist in partial form.

### 4.4 Task Management — PARTIAL
`tasks` table (`0001:339`) + threaded messages + admin UI (`pages_core.js:135`) with a
bell badge. **Missing:** projects, due dates, priority, status enum (free text today),
attachments, watchers, reminders, overdue alerts. **No linkage** to accounts, orders,
POs, or warranties — the SOW's central requirement for this module.

> ⚠️ **Security:** `GET /user/tasks/:id` and `POST /user/tasks/:id/message`
> (`agent.js:119-125`) have **no ownership scoping** — any agent or warehouse user
> can read and post to any task.

### 4.5 Warehouse and Inventory — PARTIAL

| Requirement | Status | Evidence |
|---|---|---|
| Warehouse-level inventory | DONE | `stock` PK `(variation_id, warehouse_id)` (`0001:103`) |
| New York + Montreal | **ABSENT** | Only `wh_main` and `wh_reserve` seeded (`0001:477`). Renaming is trivial; the multi-country semantics are not |
| Product master data | DONE | `products` + `variations`, incl. purchase price, EAN, attributes |
| Available/reserved/committed/incoming/backordered/damaged | **PARTIAL** | Only a single `qty` column. **None of the other six states exist** |
| Inventory movements ledger | **ABSENT** | **No movements table.** Stock is mutated in place (`orders.js:86-88`). No receipt/transfer/reservation/adjustment/write-off audit trail. This is a structural gap — SOW §6 `inventoryMovements` and C7 both depend on it |
| Warehouse transfers | PARTIAL | Real UI (`pages_catalog.js:610`) but client-side via generic sync; no transfer record, no status, no receiving confirmation |
| Manufacturer inventory integration | PARTIAL | Zoho sync covers this for one supplier (`zoho.js`); no factory API/SFTP |

### 4.6 Sales Order Module — PARTIAL
Order creation from portal and agent both work (`orders.js:49`), with account, warehouse,
address, promo snapshot. Transactional checkout with `for update` stock locking is solid.

**Gaps:** SOW lists **16 statuses**; schema has **8** (`0001:120`) — missing Draft,
Submitted, Pending Approval, Reserved, Picking, Packed, Partially Invoiced, Invoiced,
Partially Paid, Paid, Returned, Credit Issued. **No approval workflow at all** (no
discount/margin/credit-hold gates). No currency or price-list link on the order. No
margin visibility.

### 4.7 Fulfilment and Backorders — DONE (mostly)
Genuinely strong. Auto-split backorders on shortfall (`orders.js:49-183`), `BO` numbering,
approve/cancel/convert, `order_items.collected` tracks what actually shipped, scan-to-collect
with progress bars (`pages_sales.js:339`). **Missing:** priority/requested-date queue
ordering, expected-arrival dates on backorder lines, the C9 30-day fulfilment window and
its escalation rules.

### 4.8 Shipping and Tracking — PARTIAL
One nullable `orders.tracking jsonb` holding `{company, number}` (`0001:128`), entered by
hand, visible to customer (`pages_orders.js:29`). **No shipments table** — so no multiple
shipments per order, no partial shipment history, no package count, no shipping cost per
shipment, no label creation, no carrier API, no return labels.

### 4.9 Billing, Invoicing, Statements — PARTIAL / STUB
`invoices`, `payments`, `credit_notes`, `collection_flags` tables all exist, and the
statements ledger (`pages_finance.js:291`) is real — merges invoices/payments/credits,
back-computes opening balance, running balance per row.

> ⚠️ **Nothing on the server ever creates an invoice.** No INSERT into `invoices`
> exists outside the generic `/admin/sync`. Invoice generation is a client-side action
> on the order screen (`pages_sales.js:259`). `orders.invoice_id` is untyped text with
> **no foreign key** (`0001:130`).

**Missing:** automatic invoice-on-ship, emailing the invoice, backordered lines shown at
$0 on the invoice (a specific, repeated SOW requirement — §4.9, C9, Figure 3), invoice PDF
(stub, `pages_finance.js:284`), statement emailing (stub, `:372`).

### 4.10 B2B Customer Portal — DONE (largely)
The strongest area. Catalog with guest browsing, account-specific pricing, cart with saved
drafts, checkout, orders, backorders with approve/cancel, returns with exchange capture,
favourites, spare parts, customer dashboard with reorder cadence, shared lists, scan-your-list
OCR. Customer-scoped visibility enforced in SQL.

**Missing vs C10:** sell-off privileged access, checkout policy popups with mandatory
acknowledgement + acceptance history, multi-language (EN/FR/ES), the six-state SKU status
labels, statements in the portal.

### 4.11 Warranty and Parts — **ABSENT**
No warranty concept anywhere — no table, no column, no code. (The only occurrence of the
word in the repo is a Zoho SKU name, "WARRANTY KYME", in the handoff notes.) `spare_parts` (`0001:420`) is
adjacent but different: `{model, part, notes, image, status}` with no claim, no warranty
period, no order linkage, no approval workflow, and **no admin screen at all** — customers
can file them and staff cannot see them in the panel.

This is the largest single missing module. C7's warranty-part-level inventory (front, left/right
temple, nose pads, screws) requires the movements ledger that also doesn't exist.

### 4.12 Multi-Entity QuickBooks — **ABSENT**
QuickBooks appears in exactly two places, neither of them an integration: a free-text
option in the invoice-provider filter dropdown (`pages_finance.js:252`) and a comment in
the superseded Supabase schema (`platform/supabase/migrations/0001_core_schema.sql:249`).
There is no OAuth, no API client, no sync code.

The accounting integration that exists is **Zoho Inventory**
(`zoho.js`) — authoritative for price, purchase price, stock, active status; pushes orders
back as sales orders; pausable for cutover. Zoho is an inventory system, not the multi-entity
accounting hub the SOW describes.

Everything in 4.12 is unbuilt: dual QBO connections, OAuth + realmId, entity mapping, sync
queue with retry, webhook reconciliation, and the NY→Montreal intercompany transfer flow.

### 4.13 Purchase Orders and Replenishment — PARTIAL
`purchase_orders` (`0004`) with `PO` numbering, status CHECK, and `items jsonb`. Full admin
UI: create, receive into a warehouse (adds stock), partial receive, cancel (`pages_ops.js:132`).

**Caveats:** `supplier` is a plain text field — **there is no suppliers table**. Line items are
jsonb, not relational, so no per-line received/confirmed tracking. **No server-side PO
endpoints** — everything routes through the generic snapshot/sync. No PDF/email to supplier,
no supplier integration, no replenishment suggestion engine (the Inventory page's reorder
hint at `pages_catalog.js:476` is a rough `ceil(velocity×3 − stock)`).

### 4.14 KPI and Reporting — PARTIAL
Admin dashboard (`pages_core.js:5`), reports with CSV export, inventory velocity, agent
revenue, customer dashboard, plus five unused SQL views in `0002_views.sql` (the API
re-derives the same aggregates inline instead).

**Missing:** configurable KPI targets, warehouse KPIs (turnaround, pick/pack/ship time,
stock accuracy), accounting KPIs, role-specific dashboards for manager/accounting/executive,
`kpiSnapshots` for historical reporting.

> Note: the admin dashboard's "Active carts" is hardcoded `0` and every "vs prior 24h"
> delta is a literal string (`pages_core.js:81-84`).

### 4.15 Notifications and Email Automation — PARTIAL / STUB
Transactional emails are real and verified live: welcome/activation, password reset,
activation code, order confirmation (`emails.js`). In-app task notifications work.

But `email_templates` (`0001:327`) is **not used by the sending code** — `emails.js`
hardcodes its templates, so the admin template library edits nothing. Broadcast is a stub
(`pages_customers.js:767`). Campaigns persist rows but never send (`pages_sales.js:996`).
All admin-triggered activation emails are toasts even though the API endpoints exist
(`admin.js:412`). No alerts for low stock, overdue invoices, aging backorders, or inactive accounts.

### 4.16 Admin Configuration — PARTIAL
`settings` is a single jsonb blob (`0001:367`) holding a selling-fast threshold, cart-recovery
config, and Zoho state. Audit trail is good. CSV import/export is extensive.

**Missing:** configurable roles/permissions, price lists, currencies, payment terms, tax
settings, KPI targets, notification templates, order statuses, warranty rules, accounting
mappings — i.e. most of what this module is.

---

## 3. Appendix C — Commercial Operations Expansion

| § | Module | Status | Note |
|---|---|---|---|
| C1 | Account contract / commercial terms view | **ABSENT** | No contracts, policies, or versioned terms. Nearest: `users.pricing jsonb` |
| C2 | Return credit + exchange eligibility engine | **ABSENT** | No credit ledger, no eligibility rules, no time windows. Returns have only `open\|closed` and **never touch stock** |
| C3 | Rep portal + commissions | PARTIAL | Agent Revenue calculator (`pages_ops.js:269`) computes gross revenue by agent with ad-hoc rates. **No commission table, no stored rates, no objectives, no deductions, no payout record, no export** |
| C4 | Marketing automation | **ABSENT** | `campaigns` is a `{name, data jsonb}` shell with no code. No triggers, no segmentation, no scheduling |
| C5 | Shipping / carrier integration | **ABSENT** | See §4.8 |
| C6 | Advanced reporting | PARTIAL | Sales reports exist. Warranty/returns/credits/warehouse/commission report families all absent |
| C7 | Multi-warehouse + warranty parts | **ABSENT** | Needs the movements ledger and the warranty module, neither of which exists. No intercompany docs, no transfer valuation, no exchange rates |
| C8 | CRM account tabs (8 tabs) | PARTIAL | Roughly 3 of 8 exist in scattered form; no unified account profile |
| C9 | Sales + backorder management | PARTIAL | Detection and splitting are DONE. 30-day window, escalation, and $0 invoice lines absent |
| C10 | B2B portal expansion | PARTIAL | See §4.10. Sell-off, policy acceptance, multi-language absent |
| C11 | Communication module | **ABSENT** | No per-account chat. Order comments (`pages_sales.js:510`) are the only threaded thing |
| C12 | Consignment | **ABSENT** | No consignment concept. `suitcases` (agent sample cases) is adjacent but its stock is untracked |
| C13 | Payment sync from accounting | **ABSENT** | Depends on QuickBooks |
| C14 | Cross-module business rules engine | **ABSENT** | Rules are hard-coded per feature — exactly what C14 says to avoid |
| C15 | 18 new collections | **ABSENT** | ~2 of 18 have any equivalent |

---

## 4. Structural gaps that block multiple modules

These are worth doing first because many SOW items are downstream of them:

1. **No inventory movements ledger.** Stock is a mutable integer. Blocks 4.5, C7, warranty
   parts, transfers-with-status, stock accuracy KPIs, and any accounting integration that
   needs to post inventory events.
2. **No currency column anywhere.** Every money column is `numeric(12,2)` "dollars"
   (`0001:9`); CAD is a hardcoded ×1.37 in the UI (`pages_catalog.js:358`). Blocks CAD price
   lists, Canadian entity accounting, transfer valuation.
3. **No permission model.** Six role strings. Blocks the 7 role profiles, granular toggles,
   and the accounting/executive/manager personas.
4. **No business rules engine (C14).** Pricing, terms, returns, warranties, commissions and
   backorders each hard-code their logic today.
5. **The admin panel is not an API.** It is one `GET /admin/snapshot` (entire dataset) plus
   one `POST /admin/sync` (row diff). Every admin feature is client-side JavaScript against
   that blob. This will not carry warranty workflows, approval chains, or accounting sync,
   and it does not scale — snapshot returns *everything*.

---

## 5. Stubs — look finished, do nothing

Present in the shared `pages_*.js`, so the deployed build has them too:

| Feature | Location |
|---|---|
| Invoice PDF download / open-at-provider | `pages_finance.js:284-285`, `pages_sales.js:270` |
| Statement "Send to Customer" | `pages_finance.js:372-377` |
| Statements PDF upload (Import Data) | `pages_catalog.js:842-854` — discards the file |
| Email template Broadcast | `pages_customers.js:767-771` |
| Campaign send (opens/clicks stay 0) | `pages_sales.js:996-1016` |
| Admin-triggered activation / reset emails | `pages_customers.js:251-264`, `pages_sales.js:316,379,505,515` |
| Camera barcode scanning | `pages_sales.js:359-360` (keyboard-wedge scanning **is** real) |
| NiiMbot Bluetooth label printing | `pages_sales.js:330` (browser print **is** real) |
| Product image upload | `pages_catalog.js:258` — pushes the literal string `'img'` |
| Audit log Undo | `pages_ops.js:447-458` — flags and logs, does not revert |
| Collection auto-flagging cron | claimed at `pages_finance.js:164`; no implementation |
| Dashboard active carts + deltas | `pages_core.js:81-84` |

---

## 6. Defects and risks found during this analysis

Not SOW items — things worth fixing regardless.

1. **`warehouse` role can write any row in any table.** `requireAuth('admin','warehouse')`
   guards the whole admin router (`admin.js:16`), and `POST /admin/sync` accepts arbitrary
   row upserts/deletes across every collection **including `users`** (`admin.js:308`). Only
   two endpoints re-check for `admin` inline. A warehouse login can grant itself admin.
2. **Task endpoints have no ownership scoping** — `agent.js:119-125`.
3. **Production board data is silently discarded in production.** `pages_catalog.js:404,442`
   writes to `d.production`, which is not in the `SYNCED` list (`admin-overrides/js/data.js:18-20`).
   The list is lost on every reload.
4. **Migrations only run on a fresh Postgres volume** (`docker-compose.yml:11`); `deploy.sh`
   never applies them. `0003`–`0005` were applied by hand. The next migration will silently
   not apply on deploy.
5. **Catalog filtering loads every product then filters in JS** (`catalog.js:87-135`) — fine
   at 996 products, not at scale.
6. `payments.stripe_payment_intent` exists but there is **no Stripe integration** — no SDK,
   no key, no webhook. The column is a placeholder that reads as a built feature.

---

## 7. Suggested sequencing

The SOW's own Phase A–H ordering (C17) is sound, but its Phase A assumes contracts sit on
top of an existing rules layer. Given what's actually here:

- **Phase 0 — foundations the SOW assumes exist:** inventory movements ledger, currency
  columns, permission model, migration-on-deploy, and the admin API split. Also fix §6.1.
- **Phase A — contracts, policies, price lists** (SOW Phase A) — now buildable.
- **Phase B — order lifecycle:** the 16 statuses, approval workflow, credit limits.
- **Phase C — warranty module** — the biggest absent deliverable, and highly visible to
  the client.
- **Phase D — invoicing:** server-side generation, $0 backorder lines, PDF, emailing.
- **Phase E — QuickBooks** — largest integration; needs the accountant decisions in §11.3
  before a line of code.
- Then shipping/carriers, commissions, reporting, marketing, consignment.

**Open decisions from SOW §11.3 that block work and need Veyora's answer:**
inventory reservation timing; online payments; whether QBO receives every inventory movement;
Canadian intercompany treatment; $0-on-invoice vs pro-forma; which carriers; warranty policy rules.
Add to that list: **what happens to Zoho** — the SOW never mentions it, yet it is currently
authoritative for stock and prices.
