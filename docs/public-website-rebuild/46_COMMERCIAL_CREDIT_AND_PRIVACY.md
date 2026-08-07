# 46 — Commercial Credit Control and Portal Privacy

**Branch:** `mathew/final-integration-2026-08-07`
**Nothing was pushed. `main` was not merged. No canonical-branch promotion occurred.**

Two substantive areas: finishing the credit-limit work as a real commercial control, and turning off
authenticated-portal tracking. The brief's suggested number (`41`) is taken by
`41_FINANCE_OPERATIONS.md`, so this is `46`.

---

## 1. Credit — what it is now

`credit_limit` is an **account-level commercial control**, not a figure on a page. It is consulted by
the server when an order is placed, and only an authorised person may change it.

### 1.1 NULL

> **`credit_limit IS NULL` means NOBODY HAS SET ONE.**
> It is never unlimited. It is never zero.

Every account in the database reads NULL, and **no numerical limits were invented or bulk-populated**
by this run or any previous one. A build that conflated NULL with unlimited would grant infinite
credit to the entire customer base in a single deploy; one that conflated it with zero would tell
every customer they may order nothing.

**Zero is a real, deliberate limit** — pro-forma only — and is distinct from NULL at every layer. It
is pinned for the number `0` as well as the string `'0.00'`, because `pg` returns `numeric` as a
string today and a truthiness check passes on `'0.00'` by accident.

### 1.2 Qualifying outstanding exposure — the exact definition

Two terms, added. Both in `platform/server/api/src/credit.js`.

**1. The ledger balance — `users.balance`.**

Already the canonical net receivable. Every movement goes through `applyMovement()` in
`routes/admin-finance.js`, which updates the balance and writes a `finance_events` row carrying
`balance_before` and `balance_after` — so the figure is *reconstructible from the ledger* rather than
merely asserted by a column.

Because it is a **net** figure, the required properties hold by construction rather than by special
case:

| Requirement | Why it holds |
|---|---|
| A fully paid invoice contributes zero | Its `invoice.issued` credit was offset by the `payment.recorded` debit |
| A partly paid invoice contributes only the remainder | Same, partially |
| An unpaid qualifying invoice contributes in full | Only the `invoice.issued` movement has occurred |
| A cancelled or never-issued invoice does not inflate it | It never entered the ledger |
| A voided payment does not deflate it | `payment.voided` reverses the movement |
| Credit notes and refunds are treated consistently | They **are** ledger entries |

> **Deriving exposure from invoice rows instead would have been wrong here.** An offline payment —
> bank transfer, cheque, cash — lowers the balance but does **not** write
> `invoices.amount_settled_minor`; only a verified Stripe webhook does. An invoice-derived figure
> would therefore over-state the debt of every customer who pays by transfer, which is most of them.

**2. Committed but not yet invoiced orders.**

An order increases what a customer will owe the moment it is accepted, but does not reach the ledger
until somebody issues the invoice. Without this term a credit limit is bypassed simply by **ordering
faster than Veyora invoices** — the exact situation a limit exists to prevent. Cancelled orders are
excluded; already-invoiced orders are excluded because the ledger is counting them.

### 1.3 Available credit

```
available_credit = max(credit_limit − qualifying_outstanding_exposure, 0)
```

Clamped, because *"how much more may I order"* has no negative answer. The shortfall is reported
separately as `overLimitBy`, so the clamp loses nothing.

**Server authoritative.** Nothing in `credit.js` reads a request. The browser may display the result
and may not supply or override the limit, the exposure, the available credit or the eligibility — a
test sends every field a hopeful client might invent (`credit_ok`, `available_credit`, `balance`,
`limit`, `approval_required`) and asserts none changes the answer.

### 1.4 Currency

Every stored amount is in the platform's base currency, so the sum is single-currency **by
construction — asserted, not assumed**. If a contributing record ever carries a different currency
the exposure is reported as `exposureUnsupported`, **no figure is produced**, and the customer's page
says so. Adding two currencies together would give a number that looks authoritative and is
meaningless.

---

## 2. Who may change a credit limit

A new capability: **`finance.credit_limit`**.

Deciding how much a customer may owe is a **third authority**, separate from the two the platform
already separates: recording a payment and issuing a credit note both record something that *already
happened*; setting a limit **commits Veyora to future risk**.

| Property | How |
|---|---|
| Capability-gated | `PUT /admin/credit/customers/:id/credit-limit` behind `requirePermission('finance.credit_limit')` |
| No role satisfies it | Unchanged platform-wide: nothing reads `users.role` for authorisation |
| Customer can never reach it | No customer-facing route exists; asserted across the whole customer surface |
| Not via generic sync | `credit_limit` is deliberately absent from the `users` collection in `shape.js` |
| Value validated | Positive, ≤2 decimal places, bounded by `numeric(12,2)`; **negative rejected** |
| NULL supported | `''` or `null` **clears** it back to *not configured* — a limit set in error must be removable to "not decided", not only to zero |
| Zero supported | A deliberate pro-forma-only decision |
| Reason required | As for a credit note. *"Why is this ceiling $40,000?"* must have an answer that is not "somebody typed it" |
| Stale-write safe | Optional `expectedCurrentLimit`; "I expected it unset" is expressible and is **not** the same as "I expected zero" |
| No-op refused | An audit trail full of *"changed from 5000 to 5000"* is one nobody reads |

**Migration 0018 widens the capability CHECK and grants nothing.** No account holds this capability;
the first grant remains a supervised bootstrap.

### 2.1 Audit evidence

Every change writes to `audit_log` — append-only by database trigger, no UPDATE, no DELETE, enforced
below the application — recording **previous value, new value, actor, customer, reason, capability
and timestamp**.

Written **inside the transaction, on the same client.** Writing it afterwards on the pool would let
the two come apart in both directions: a limit that changed with no record of what it replaced (the
precise thing this exists to prevent), or a record of a change that rolled back.

That required a transactional audit writer. Rather than a third raw `insert into audit_log`, `db.js`
gained `auditIn()`, which **shares the one `AUDIT_INSERT` statement** with `audit()` — so *"does
every audit writer only ever append?"* remains a question about one line of SQL, and the existing
audit-integrity guard keeps working unweakened.

---

## 3. Order-time credit evaluation

`POST /user/place-order` evaluates credit **inside the order transaction**, on the **server-priced**
total, for the **resolved** customer. The request body carries no total, balance, limit or verdict,
and none would be read if it did.

### 3.1 An over-limit order is not rejected

Veyora's commercial model is credit **checking with an approval stage**, not automatic refusal. A
legitimate order above the limit is a conversation, not an error, and no existing canonical business
rule requires rejection.

So the order proceeds and **stays `pending`** — the status it genuinely has. **No second order state
machine was introduced**; adding one would have meant every screen, filter, report and transition
learning about it, which is far larger than the requirement needs.

Instead the order carries `orders.credit_review`, a JSONB snapshot of the decision and the figures it
was made on: projected exposure, the limit at that moment, the shortfall, the order total, the
currency and the timestamp.

> **NULL means no credit decision was needed** — either no limit is configured, or the order was
> within it. The presence of the column is therefore the signal, and **an absent snapshot can never
> be mistaken for a passed check.** No default, no backfill, no coalesce — asserted.

An immutable `order credit review required` record is written in the same transaction.

### 3.2 The four outcomes

| Decision | Meaning | Review required |
|---|---|---|
| `not_configured` | No limit set, so no credit decision is possible or claimed | no |
| `within_limit` | Projected exposure is within the configured limit | no |
| `credit_review_required` | Projected exposure exceeds it | **yes** |
| `exposure_unsupported` | Exposure could not be computed honestly (mixed currency) | **yes** |

*"We could not tell"* is not *"yes"* — an unsupported exposure needs review rather than counting as
approval.

### 3.3 What still needs a human — NOT COMPLETE

The **credit approval workflow itself is not built.** The server detects and records the condition;
resolving it is a human step with no screen yet:

- `credit_review.resolvedBy`, `resolvedAt` and `resolution` are present in the snapshot and always
  `null` — nobody has decided;
- there is **no route to resolve one**, deliberately: the resolution capability, who may hold it and
  what an approval means commercially are decisions for Veyora, not defaults to invent;
- **no admin screen** exists for setting a credit limit either. The endpoint is the mechanism; a
  screen is pending, and would in any case be unusable until the first capability grant.

Orders awaiting a decision are findable now: `orders.credit_review is not null`, with a partial index
supporting it.

---

## 4. The customer's Balance & Payments screen

Shows outstanding balance, payment terms, invoices with links and *Pay Securely* where eligible, and:

**No configured limit**

> Credit limit — **Not configured**
> *No credit limit has been set for this account. Please contact us if you need one.*

**Configured limit**

> Credit limit · Current exposure (with its two components) · Available credit
> — or *Over limit by …* with a note that new orders may need approval.

**Unsupported exposure**

> Credit available — **Unavailable**, with the reason.

The word "unlimited" appears nowhere. The customer can mutate nothing: the page contains no input
element and calls no write method.

The screen uses **the same `creditPosition()`** the order decision uses. Recomputing headroom there —
as it did — would let the screen promise headroom that an order is then held for exceeding.

---

## 5. Analytics — disabled by default

A **Meta Pixel** loaded in `platform/server/storefront/index.html`. It initialised on every page load
and fired a `PageView` on **every in-app route change**, so a signed-in trade customer's entire
session — which frames they looked at, what they ordered, how often they returned — was sent to a
third party. No consent gate, a hard-coded production pixel id, and a third-party script with full
access to the DOM of an authenticated page.

**It was removed, not switched off, and nothing replaces it.**

There is deliberately **no dormant hook and no configuration flag holding the id**: an id that only
something else prevents from executing is one line away from executing again. The id is also gone
from `platform/docs/OLD-API-MAP.md`, where it sat as a historical note — it is recoverable from
Veyora's own Meta Business account if an integration is ever approved.

Every occurrence was inspected first. The pixel was contained entirely in the storefront shell; the
Facebook reference in `pages_home.js` is a link to Veyora's own profile page, and the public Astro
site had no tracking at all.

**Future activation is a business and privacy decision**, not a code change made in passing. It needs
an explicitly configured id that is never committed, a consent mechanism suited to the jurisdictions
Veyora's customers trade in, and a decision about whether tracking signed-in commercial behaviour is
acceptable at all. **No legal or privacy wording was invented here, and no consent-management
platform was built.**

---

## 6. Release branch

The release gate refuses this branch by design and offers a documented override, which is what was
used:

```
VEYORA_RELEASE_BRANCH_OVERRIDE=mathew/final-integration-2026-08-07
```

**The approved-branch allowlist was NOT widened, and the gate was not weakened.** The override is
acceptable only because this is a temporary integration branch.

> **After this candidate is reviewed and promoted by fast-forward to
> `mathew/public-website-rebuild`, the complete release gate must be re-run WITHOUT the override.**

No canonical-branch promotion and no `main` merge occurred in this run.

---

## 7. Verification

| Suite | Result |
|---|---|
| API | **1,850 passing, 0 failing** |
| Admin panel | **325 passing, 0 failing** |
| Public website | **466 passing, 0 failing** |
| **Total** | **2,641 passing, 0 failing** |

Previous candidate: 2,593. The 48 added are 41 commercial-credit tests and 7 analytics tests. No test
was weakened or removed.

Release gate **18/18**. `npm audit`: **0 vulnerabilities**. Schema parity: **10/10**, with 0018
mirrored and the contract verified by tampering before the mirror was written.

### Tamper evidence

| Area | Injected | Caught |
|---|---|---|
| Credit | 23 | **22** |
| Analytics | 7 | **7** |

The one not caught was a genuine **semantic no-op** — coercing `limitMinor` when no limit is
configured, a value never read in that branch — not a missed regression.

Four credit tampers survived a first pass and are recorded because two were real:

- the test double filtered invoiced and cancelled orders **itself**, so the SQL could have stopped
  doing so unnoticed — the query text is now asserted, as the returns suite already learned;
- asserting that `creditReviewSnapshot` *appeared* survived replacing the whole snapshot with `null`,
  which would silently disable the control while leaving every other assertion green — the
  derivation is now asserted.

---

## 8. NOT complete

Explicitly **not** marked done:

- **Real customer credit-limit assignment.** Every account reads NULL. No numerical limits were
  invented. Assigning them is a supervised, authorised act.
- **The credit approval workflow.** Detection and recording are built; resolving a review has no
  capability, no route and no screen — those are Veyora's decisions.
- **The admin credit-limit screen.** The endpoint exists; the screen does not.
- **Capability bootstrap.** No account holds `finance.credit_limit` or any other capability.
- **Migration rehearsal** and **deployment rehearsal** — both need a real disposable database.
- **Production Stripe activation** and **production email activation.**
- **Legal / privacy approval** for any future analytics.
- **Historical invoice visual match** — the old reference PDF is still unavailable.

---

## 9. What did not happen

No production or VPS access. No live database. No DNS change. No deployment. No live Stripe
credentials and no real Stripe transaction. No real outbound email. No destructive migration. No real
customer credit limit assigned. No capability bootstrap executed. No branch merged, no
canonical-branch promotion, no fast-forward of `main`. **No push.**
