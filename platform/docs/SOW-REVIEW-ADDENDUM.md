# Veyora System SOW — Review Notes and Proposed Additions

Review of *Veyora PM — Expanded Statement of Work*, Draft v1.0 (May 05 2026),
checked line by line against the platform running at veyora.design as of 2026-07-21.

Structure: **Part 1** corrections, **Part 2** existing capabilities the SOW omits,
**Part 3** requirements the SOW is missing entirely, **Part 4** additional open
decisions, **Part 5** what is already built.

A companion document, `SOW-GAP-ANALYSIS.md`, has the module-by-module build status
with code references.

---

## Part 1 — Corrections

### 1.1 §2 "Current Platform Context" does not describe the live platform

This is the most important correction, because §11.1 and §11.2 build assumptions on it.

| §2 states | Actually running at veyora.design |
|---|---|
| React 18, Vite, TypeScript, Tailwind, zustand, SheetJS | Vanilla JavaScript SPA, no framework, no build step |
| Firebase Auth, Firestore, Storage, Cloud Functions, Firebase Hosting | Node/Express API, PostgreSQL 16, Caddy, Docker Compose on an IONOS VPS |
| Real-time Firestore subscriptions | Request/response REST over cookie sessions |
| "Granular per-feature permission toggles in Firestore rules" | Six role strings; no permission table |
| CRM with accounts, contacts, territories, maps, documents | Leads only. No accounts/contacts/territories/maps entities |
| Tasks with projects, attachments, AI rewrite/breakdown | Tasks with a message thread. No projects, attachments, or AI features |
| Inventory with multiple currencies | Single implied currency (USD). No currency field anywhere |

**Consequence:** §6's target data model is expressed as Firestore collections
(`crmAccounts/{id}`, `salesOrderLines/{id}`) and needs restating as a relational
schema. §9's acceptance criterion "sensitive data is protected by Firestore rules"
is not testable against this platform.

**Recommendation:** rewrite §2 from the live system, and revise §11.1's assumption
that the work is an extension — for roughly a third of the scope it is new build.

### 1.2 §12 lists data migration as out of scope; it is already done

Out of scope currently reads *"data migration from external systems unless sources,
format, and cleanup rules are defined."* The migration has in fact been completed:

- 996 products / 3,982 variations, with purchase prices and EANs
- 4,829 product photos
- 157 customers
- 1,117 historical orders with 9,804 line items, original numbers and dates preserved

**Recommendation:** move this to a "completed" section. It is significant delivered
value and should not read as a future risk.

### 1.3 Warehouses are not yet New York and Montreal

§3, §4.5 and Figure 4 assume a New York master warehouse and a Montreal Canadian
warehouse. The database currently has two warehouses named "Main Fulfillment" and
"Reserve (backstock)" — a single-country setup.

Renaming is trivial; the multi-country model behind it (intercompany transfers,
CAD/USD valuation, two legal entities) is not. **Recommendation:** state explicitly
that Montreal is a new build, not a rename, and confirm whether the Canadian entity
exists yet operationally.

### 1.4 §3 says "Quickbooks / Xero", everywhere else says QuickBooks only

§3 objectives mention *"separate Quickbooks / Xero connections."* §4.12, §8, §13 and
Appendix B specify QuickBooks exclusively. **Recommendation:** pick one. Supporting
both roughly doubles the accounting integration.

---

## Part 2 — Existing capabilities the SOW does not mention

These are live and in daily use. Because the SOW is silent on them, a vendor working
only from this document could rebuild the platform without them. Each should be
listed as **preserve**.

| Capability | What it does | Why it matters |
|---|---|---|
| **Presentation mode** | Per-browser toggle that hides all prices, with a per-item "show price" reveal | Lets an agent show frames to a retail customer without exposing wholesale pricing. A specific request from Sam |
| **Agent / super-agent roles** | Two sales roles with different customer scoping | The SOW's role list has "Sales Rep" but no equivalent of super-agent, who sees all customers and leads |
| **Scan your list** | Photo of a handwritten SKU list → OCR → matched cart lines | Migrated from the old site at Sam's request. Currently dormant pending an API key |
| **Shared frame lists** | Staff paste SKUs → shareable public link showing exact variations | Used for curated selections sent to customers |
| **Suitcases** | Agent sample-case planogram — trays of 6/12/15 slots, each holding a SKU | Physical sample-case management for field sales |
| **Chains** | Multi-branch customer groups with a chain-wide order view | Buying-group structure that C8 gestures at but never specifies |
| **Promotions engine** | Date window, country, audience, min qty, usage caps, tiered/percent/fixed/free-shipping rewards | Substantial existing logic. The SOW mentions "temporary promotions" (C1) without specifying anything this detailed |
| **Collection / dunning** | Debt flagging, per-customer contact log with outcomes, resolution | Receivables chasing; not in the SOW at all |
| **Saved cart drafts** | Customers save, list, reload named carts | |
| **Restock notifications** | "Notify me" per variation, with subscription state | |
| **Spare parts requests** | Customer requests a replacement part with photo | Adjacent to §4.11 warranty but distinct — see 3.6 below |
| **Backorder auto-split** | Checkout allocates what's available and splits the shortfall into a linked backorder automatically | Already satisfies much of §4.7 and C9 |
| **Scan-to-collect** | Barcode/SKU scanning against an order with per-line progress | Warehouse fulfilment workflow |
| **Reorder cadence** | Infers per-customer reorder rhythm and flags overdue items | |
| **Zoho pause switch** | One reversible flag that moves source-of-truth from Zoho to the platform | Central to any cutover plan |

---

## Part 3 — Requirements missing from the SOW

### 3.1 Zoho Inventory is never mentioned — the largest omission

Zoho is currently **authoritative** for stock levels, prices, purchase prices and
active status, syncing every 30 minutes, and every placed order is pushed to Zoho as
a sales order. The SOW goes straight to QuickBooks without stating what happens to Zoho.

This needs an explicit section covering:
- Whether Zoho is decommissioned, kept for inventory, or kept for accounting until QBO is live
- The sequencing between the Zoho cutover and the QuickBooks build (both change the
  system of record — doing them at once is risky)
- What happens to `zoho_item_id` mappings, and whether QBO item mapping replaces or
  parallels them
- Order push: today orders go to Zoho. Under §4.12 they would go to QuickBooks. Both? Neither?

**This is the single most important addition.** Without it, §4.12 cannot be estimated.

### 3.2 No non-functional requirements at all

The SOW specifies no:

- **Security requirements** — authentication standards, session policy, password rules,
  encryption at rest/in transit, PII handling, penetration testing, or an access review.
  §9's only security criterion is the (inapplicable) Firestore rules line.
- **Performance / capacity targets** — page load, API latency, concurrent users, catalog
  size ceiling, report generation time.
- **Availability / SLA** — uptime target, maintenance windows, incident response.
- **Backup and disaster recovery** — RPO/RTO. (Nightly `pg_dump` with 14-day retention
  exists today; the SOW should state the requirement it satisfies.)
- **Browser and device support matrix** — significant mobile work has been done at 375px
  and a 900px app-shell breakpoint; none of it is specified anywhere.
- **Accessibility** — no standard named (WCAG level, keyboard navigation, screen readers).
- **Data retention and privacy** — GDPR/PIPEDA obligations for a business selling into
  Canada and the US, customer data export/erasure, audit log retention period.

### 3.3 No sales tax handling

§4.2 mentions capturing a "tax region" and §4.6 lists "tax" as an order line field, but
no requirement describes **calculating** tax. US state/local sales tax and Canadian
GST/HST/QST are genuinely complex and usually need a tax service. Given both
jurisdictions are in scope, this needs its own section — including whether a provider
is bought or rates are maintained manually.

### 3.4 Testing and acceptance are underspecified

§10's Phase 7 mentions "automated tests" but §9's acceptance criteria are not testable
as written (e.g. "priced correctly", "accurate metrics"). There is no UAT plan, no
defined test environment, no sign-off process, no defect severity definitions.

**Recommendation:** add measurable acceptance criteria per module, and specify who signs off.

### 3.5 No rollout plan for the existing 157 customers

All migrated customers are in `pending` status and must self-activate by email before
they can log in. The SOW's §4.10 describes new customers requesting access, but not
onboarding an existing book of business. Needs: comms plan, activation campaign,
fallback for customers who never activate, and a support path.

### 3.6 "Sell-off" is used but never defined

C7 and C10 refer to sell-off inventory, sell-off pricing and privileged sell-off access
as though defined. They are not. Needs: what qualifies, who sets it, how it prices, who
sees it, and its return/warranty status.

### 3.7 Spare parts vs. warranty parts are conflated

§4.11 and C7 describe warranty claims and warranty-part inventory. The platform already
has a **spare parts request** flow (customer asks for a part, no claim, no warranty
period, no order link) — and no admin screen to process them. The SOW should say whether
spare parts is (a) folded into warranty, (b) kept separate as a paid-parts channel, or
(c) replaced.

### 3.8 No effort, timeline, or cost

For a document whose stated purpose includes "vendor alignment," there are no durations,
no effort estimates, no dependencies between phases beyond ordering, and no budget.
Phases A–H (C17) and Phases 1–7 (§10) are also two different, unreconciled phase schemes.

**Recommendation:** reconcile into one plan and attach estimates.

### 3.9 The old site and domain

Nothing covers decommissioning veyora.com, the domain cutover, redirects and SEO, how
long the old system stays readable, or the final data reconciliation. Worth a short section.

---

## Part 4 — Additional open decisions for §11.3

The SOW's existing eight open decisions all still stand. Add:

| Open decision | Why it matters |
|---|---|
| **What happens to Zoho, and when?** | Blocks all of §4.12. Two systems of record cannot both be authoritative |
| **Does the Canadian entity exist operationally?** | Determines whether Montreal is a data change or a business setup |
| **Who fills the Manager, Accounting and Executive roles?** | The SOW defines seven roles; the business currently runs on six, and some may have no occupant. Building unused permission tiers is waste |
| **Is a tax engine bought or built?** | See 3.3 |
| **Do agents/super-agents map onto "Sales Rep", or stay distinct?** | Affects CRM, commissions and portal scoping throughout |
| **QuickBooks or Xero?** | See 1.4 |
| **Which existing features are must-keep?** | Part 2 above — needs client sign-off, not vendor assumption |
| **Is there a hard deadline?** | Nothing in the SOW indicates urgency or sequencing pressure |

---

## Part 5 — What is already built

Detail with code references is in `SOW-GAP-ANALYSIS.md`. Summary against the SOW's
16 modules and 17 Appendix C sections:

**Substantially delivered (6):** catalog and stock, sales order core, warehouse
fulfilment and backorders, returns, B2B portal basics, purchasing.

**Partially delivered (11):** authentication, CRM (leads only), tasks, inventory,
shipping (tracking field only), billing (statements real, invoicing client-side),
reporting, price rules (per-customer, not shared lists), commissions (calculator only),
KPIs (actuals, no targets), notifications (transactional email live).

**Not started (12):** warranty module, QuickBooks, territories, contracts and policies
(C1), return-credit engine (C2), consignment, marketing automation, carrier integration,
multi-currency, multi-language, KPI targets, inventory movements ledger.

### Four foundations the SOW assumes exist but do not

Worth calling out because several modules sit on top of them:

1. **Inventory movements ledger.** Stock is a single mutable quantity per
   variation/warehouse. There is no record of receipts, transfers, reservations,
   adjustments or write-offs. §4.5, C7, warranty parts and any accounting integration
   that posts inventory events all depend on this.
2. **Currency.** No currency field exists on any table. Required before CAD pricing,
   Canadian accounting or transfer valuation.
3. **Permission model.** Six role strings with no permission table. Required for the
   seven role profiles in §7 and the feature toggles in §4.16.
4. **Business rules engine (C14).** Pricing, terms, returns and backorders each hard-code
   their own logic today — the exact situation C14 says to avoid.

**Recommendation:** add a Phase 0 before Phase A covering these four. Phase A
(contracts, policies, price lists) is difficult to build well without at least
items 2 and 4.

---

## Suggested next step

Confirm the answers in Part 4 — particularly the Zoho question — before any estimating.
Several sections of the SOW cannot be costed until those are settled.
