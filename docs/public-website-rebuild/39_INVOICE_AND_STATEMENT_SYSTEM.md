# 39 — Invoice and Statement Document System

**Status:** implemented (Final Handover, Phases 5 and 6)
**Outstanding:** final visual matching of the invoice against the historical Veyora reference.

---

## 1. What these replaced

| Control | Old behaviour |
|---|---|
| Invoices → **Download PDF** | A toast: *"No invoice document is generated yet"* |
| Statements → **Print statement** | A popup with hand-written HTML and `print()` |
| Statements → **Send to Customer** | `DB.audit('statement.send', …); toast('Statement emailed to …')` — **nothing was generated, attached or sent**, and the audit log recorded a delivery that never happened |

A false record is worse than no button, because it is consulted later and believed.

The old statement screen also had an arithmetic fault: it took the customer's **current** balance as
the closing figure and subtracted the period's activity to derive an opening one — so a statement for
*any past period* silently reported today's balance as that period's closing balance.

---

## 2. The dependency

`pdf-lib@1.17.1`, pinned exactly. Pure JS, no native bindings, four small dependencies.

Chosen over a hand-built writer — against this repository's own `xlsx-lite` precedent — for **font
metrics**. `font.widthOfTextAtSize()` is exact because pdf-lib carries the AFM tables. A financial
document that silently overflows a column because the width was *estimated* is a real defect, and
glyph widths are exactly the part a hand-rolled writer gets wrong.

---

## 3. Nothing is invented

Every legal and business fact comes from `src/documents/brand-config.js`, where each is an
environment variable whose default is `null` — a visibly-unset marker, never a plausible guess.

> A company number this codebase made up would look exactly as authoritative as a real one and would
> be wrong on every invoice Veyora ever sends.

An unset field is **omitted** rather than printed as a placeholder: an invoice with no VAT line is a
normal invoice, while one carrying `«NOT CONFIGURED»` is a document nobody should send.

`configurationGaps()` reports every unset **required** field, separately from optional ones — so the
handover checklist is generated from the code rather than maintained by hand. Nineteen fields in
total; see `.env.example` and `40A_CLIENT_ACTIVATION_CHECKLIST.md`.

---

## 4. The invoice

### Content

Issuer identity, address, company and tax numbers, bank block; customer business, address, tax
number, and the **accounts-payable contact** where the store has one (the person who actually has to
pay it); invoice number, issue date, **derived** due date, terms, order number and the customer's own
PO reference; itemised SKU / description / colour / quantity / unit price / discount; subtotal,
discount, shipping, tax, total, paid, refunded, balance due; the stamped FX rate **only** when the
order currency differs; a live hosted payment link where one is open; and the configured footer.

### Two deliberate presentation decisions

- **An invoice on terms is stamped `DUE`, never `UNPAID`.** An invoice outstanding on agreed account
  terms is not delinquent. `OVERDUE` is *derived* from the due date, so it cannot drift.
- **Zero tax is printed, not omitted.** "Tax 0.00" and no tax line mean different things to a
  bookkeeper, and the first is what is true when tax was calculated and came to nothing.

### Determinism

No clock is read in the generator. The PDF's creation and modification dates come from the invoice's
own `issued_on`; "overdue" is decided by an injected `asOf`. **Regenerating an unchanged invoice is
byte-identical** — asserted — so *"is this the same document I sent?"* is answerable by comparing
files.

### Access

| Route | Gate |
|---|---|
| `GET /admin/invoices/:id/pdf` | `payments.view` |
| `GET /user/invoices/:id/pdf` | the customer's **own** invoice |

Ownership is a **SQL predicate** (`and customer_id = $2`), not a comparison afterwards — there is no
branch in which a row is loaded and then rejected, which is where a "forgot the check" bug lives.
Another customer's invoice is a **404, not a 403**: distinguishing them would confirm the invoice
exists to anyone enumerating ids.

Headers: `application/pdf`, a stable filename, `private, no-store` (a shared cache holding an invoice
is a disclosure; a browser cache holding a stale one would show `DUE` on an invoice since paid), and
`nosniff`. Neither route reads a body or a query string.

### Leakage

Asserted absent from the document: cost, supplier price, margin, wholesale price, account balance,
and any Stripe key or idempotency value. The line shape is built key by key from a fresh object
literal, so a field added to the order later cannot appear unreviewed.

---

## 5. The statement

### Arithmetic

The closing balance is **computed**: opening plus movements. The opening balance is the sum of
everything *before* the period, from the source ledgers. **No balance column is read anywhere** in
the builder or the route — asserted. Every figure is in minor units, formatted once. The sign comes
from the movement **kind**, so a negative amount cannot invert a credit.

### One currency per statement

A running balance mixing USD and EUR is arithmetic nobody can defend.
`GET /:customerId/currencies` reports what a customer actually has activity in; the screen presents
the choice and explains why. A movement in another currency never reaches the running balance.

### Content

Customer identity, period, opening balance, every invoice / payment / credit note / refund, running
balance, closing balance, currency, generated timestamp, Veyora identity, an **ageing breakdown**
computed from the invoice lines only, and payment instructions. A credit balance is described as
credit, not as a debt. An empty period says so plainly.

A **voided** payment is excluded: the money did not arrive, and showing both the payment and its void
would be internally correct and externally baffling.

### Delivery

Statements go through the **notification outbox**, inheriting bounded retries and the rule that
nothing is reported delivered without provider confirmation.

- The statement row and its notification are written in **one transaction**.
- A route can only set `queued`. **No route can set `sent`** — asserted. Only
  `markStatementSentOnDelivery`, called by the worker after a confirmed delivery, does; and it is
  idempotent against a duplicated confirmation.
- A `sent` row must carry evidence of where it went, enforced by a CHECK.

**The PDF is not stored.** The inputs are recorded and the document regenerated deterministically.
That keeps a customer's full financial history out of a second place and means a corrected brand
configuration improves every historical statement rather than none. An attachment that cannot be
rebuilt is a **retryable** failure — a statement email with no statement attached would be worse than
one that arrives a few minutes late.

The trade-off, stated honestly: a statement re-sent after the ledger changed carries the corrected
figures. That is right for a supplier statement — it is a current view of an account, not an
immutable demand like an invoice — and the period, currency, opening and closing balances **as sent**
are recorded on the statement row either way, so a discrepancy is always discoverable.

### Recipients

Accounts-payable contact → primary contact → account email, with an explicit override beating all
three. An archived contact or one with no email is skipped. No recipient at all is reported as such,
never sent to nowhere.

The **reason** is stored alongside the address, because *"why did this go to the owner rather than
accounts payable?"* is asked months later, and reconstructing it from the contact table as it stands
*then* would give the wrong answer.

### No scheduling

No cron column, no `next_run_at`, no recurrence rule, and nothing in the router schedules anything —
asserted. Automatic monthly statements are out of scope, and a column anticipating them would be an
invitation to wire one up.

### Authority

`payments.view` to generate, preview and download — that is reading payment state.
`statements.send` for sending, because it reaches a customer. Holding the first confers nothing of
the second. **A preview creates no record**: checking a figure must not litter the history.

---

## 6. Shared layout

Both documents are built on `src/documents/pdf-layout.js`: a text cursor, exact measurement,
wrapping, ellipsis truncation, and a table that breaks across pages and repeats its header. Every
cell is wrapped before a row is drawn, so the row's height is known first — drawing and then
discovering it does not fit is how a table ends up with a header on one page and its first line on
the next. **A table wider than the page throws** rather than silently overflowing.

Text is folded to the font's encoding before measurement. That is not cosmetic:
`widthOfTextAtSize()` **throws** on a character the standard font cannot encode, so one emoji in a
customer's business name would otherwise have been a **500 on their invoice download**. Characters
the font *can* represent (`é`, `ü`) are preserved — folding them would corrupt a name it prints
perfectly well.

---

## 7. Outstanding

> **Final visual matching of the generated invoice against the approved invoice from the previous
> Veyora system remains pending receipt of that historical reference.**

`source-assets/invoice-reference/approved-invoice-reference.pdf` does not exist and there is no
`source-assets/` directory. This is a **visual acceptance dependency, not an unfinished generator** —
every functional behaviour is complete and tested (61 invoice tests, 56 statement tests: multi-page,
header repetition, page numbering, long fields, three currencies, discounts, shipping, zero and
non-zero tax, every payment state, determinism, ownership, cache headers and leakage).
