# 47 — Credit Operations

**Branch:** `mathew/final-integration-2026-08-07`
**Nothing was pushed. `main` was not merged. No canonical-branch promotion occurred.**

`46_COMMERCIAL_CREDIT_AND_PRIVACY.md` made the credit limit a real control: capability-gated,
audited, and consulted by the server when an order is placed. It left two operational gaps, both
recorded there as deliberately not built. This closes them.

---

## 1. What was missing, and what now exists

| Gap | Now |
|---|---|
| No admin screen for setting a credit limit — the endpoint was the only mechanism | **Account credit** screen, reached from Collection & Debt |
| Over-limit orders were detected and recorded, but nothing could resolve them | **Credit Reviews** queue with governed approve / decline |

---

## 2. Admin credit-limit UI

Reached from **Finance → Collection & Debt**, where the receivable already lives, rather than from a
disconnected settings page. Each flagged customer row gains a **Credit** action.

The screen shows, from the server:

- receivable balance;
- committed but not yet invoiced exposure, with the order count;
- **total qualifying exposure**;
- configured credit limit, or **"Credit limit not configured"**;
- available credit, or the amount over.

> **The browser computes no money.** Every figure comes from `creditPosition()` — the *same*
> calculation the order-time credit decision uses. A second formula in the panel would let the
> screen and the order decision disagree about the same customer, which is exactly how a customer
> gets told they have headroom and then has their order held.

**Edit Credit Limit** supports a monetary value, zero, and clearing to NULL. It requires a reason,
confirms explicitly, and sends the value read when the screen opened as `expectedCurrentLimit`, so a
change somebody else made in the meantime is refused rather than overwritten. Errors are shown as
the server wrote them.

A 403 is rendered as a sentence explaining the account lacks the capability — not as an empty list.
The panel cannot know what an account holds, because the session carries a role and no capabilities.

---

## 3. Credit reviews

### 3.1 The capability — `finance.credit_review`

**Deliberately not `finance.credit_limit`.**

Raising a customer's ceiling and letting one order through above the existing ceiling are different
responsibilities with different consequences. The first is a standing commitment applying to every
future order; the second is a one-off judgement about one order that changes nothing afterwards. A
salesperson trusted to wave through a $4,000 order for a good customer is not thereby trusted to
decide that customer may permanently owe $40,000 — and somebody who sets limits centrally may have
no view at all on whether one particular order should ship today.

The platform already draws this distinction between `finance.record` and `finance.credit`.

Migration **0019** widens the capability CHECK and **grants nothing**. Mirrored in `ensureSchema()`;
the parity suite passes. No account holds it, and **no capability bootstrap was performed.**

### 3.2 The review state model

`orders.credit_review` — already `jsonb`, so **no schema change was needed**.

| Field | Written | Meaning |
|---|---|---|
| `state` | at submission, then at decision | `pending` / `approved` / `declined` |
| `decision` | at submission | why review was triggered — over limit, or exposure unsupported |
| `projectedExposureMinor`, `creditLimitMinor`, `overLimitByMinor`, `orderTotalMinor`, `currency`, `evaluatedAt` | at submission | **the original calculation** |
| `resolution`, `resolutionReason`, `resolvedBy`, `resolvedByName`, `resolvedAt` | at decision | who decided, when and why |

> **The original calculation is never overwritten.** The resolution merges *on top of* the stored
> snapshot, and the resolution fields are written last from the server's view of the actor and the
> clock. A caller restating the limit or the exposure cannot make an approval look justified after
> the fact — asserted with a deliberately hostile body.

The record answers, on its own: *what did the system calculate when this order was submitted, and
who later approved or declined it?*

### 3.3 Approval semantics

Approving is an **exception for that one order**. It:

- lets that order proceed through the **existing** order workflow — no second state machine;
- **does not touch `users.credit_limit`**. The ceiling is exactly what it was and the next order is
  evaluated against it afresh. The route never issues an `update users` statement at all, the
  response says `creditLimitChanged: false`, and the panel says so in words.

### 3.4 Decline / hold semantics

The order **stays `pending`** with `state: 'declined'`. It is not cancelled and not deleted — a
declined order is a conversation, not a mistake to erase. It cannot pass the protected commercial
transition, and staff can still administer it: tracking, comments, collection counts and cancelling
all remain available, because a held order still has to be handled.

### 3.5 The protected commercial transition

Two paths would let an unapproved over-limit order become a commitment. Both are blocked, on the
locked row, in the server:

| Path | Guard |
|---|---|
| `PATCH /admin/orders/:id` moving the status out of `pending` into fulfilment | `creditReviewAllowsProgress()` |
| Invoicing — `issueInvoice()`, both entry points | the same check, on the same locked row |

Invoicing matters as much as fulfilment: it books the exposure onto the ledger, which is precisely
what the credit limit governs.

**A NULL review allows progress** — that is the ordinary order, which never needed a decision. An
**unrecognised** state is refused rather than allowed: a review whose shape this build does not
understand is not one it may act on.

---

## 4. Audit

Every decision writes to `audit_log` — append-only by database trigger — **inside the same
transaction** as the decision. A decision without its record, or a record without its decision, are
both worse than neither.

The payload carries the actor, the customer, the order, the resolution, the reason, the capability
that admitted the request, and **a copy of the original submission snapshot**, so the evidence
survives even if the order row is later archived.

---

## 5. Concurrency and idempotency

- The order row is locked (`for update of o` — only the order, not the joined customer) before the
  review is read, so two people deciding at once cannot both see `pending`.
- A **second decision is refused deterministically**, naming who decided and when. The first stands.
  A double-click and a colleague arriving late get the same answer.
- The decision and its audit row are one transaction.
- Nothing about the credit position comes from the request. Only the resolution and the reason do.
- The queue is bounded (`limit 200`) and ordered — asserted per branch, from the SQL actually
  issued.

---

## 6. The admin review queue

**Finance → Credit Reviews.** Filters: *Awaiting decision* / Approved / Declined / All. Completed
decisions stay readable, with the reason and who made it — a decision nobody can look up afterwards
is not auditable in any useful sense.

Each row shows the order number and status, the customer (clicking through to their credit screen),
the order total, the exposure at submission, the credit limit at submission, the amount over,
payment terms, the submitted date and the review state. Where review was triggered by an
**unsupported exposure** rather than by being over the limit, the row says so — it is a different
problem and needs a different judgement.

Actions are **Approve exception** and **Decline / hold**, each behind a confirmation requiring a
reason. The screen states that approving does not raise the credit limit.

The nav entry is **not** gated on `finance.credit_review`. Nobody holds it, so the entry would be
invisible to every account — including whoever is deciding whether to grant it. The server refuses
every call regardless, and the screen says so plainly.

---

## 7. Customer-visible behaviour

**Unchanged.** No customer surface can see or resolve a review, and none writes `credit_review` or
`credit_limit` — asserted across `account.js`, `orders.js`, `cart.js`, `catalog.js` and `agent.js`.

The customer's Balance & Payments screen continues to show their exposure, limit and available
credit, from the same server calculation. An order held for review appears as `pending`, which is
what it is.

---

## 8. Verification

| Suite | Result |
|---|---|
| API | **1,887 passing, 0 failing** |
| Admin panel | **325 passing, 0 failing** |
| Public website | **466 passing, 0 failing** |
| **Total** | **2,678 passing, 0 failing** |

Previous baseline 2,641; **+37**, all in `credit-operations.test.js`. No test was removed or
weakened.

Release gate **18/18** (temporary integration-branch override). Schema parity **10/10** with 0019
mirrored. `npm audit`: **0 vulnerabilities**. Astro build passes.

### Tamper evidence

**25 distinct regressions injected, 25 caught.**

Eighteen were caught on the first pass. Five survived, and four of those revealed **real assertion
gaps**, which is the point of doing this:

| Survived | Why | Fixed by |
|---|---|---|
| Dropping the order predicate from the decision lookup | the double resolved the id itself | asserting the query text (25d) |
| Making one of two queue branches unbounded | the assertion checked the string appeared *somewhere* in the file | asserting the SQL actually issued, per branch (25b) |
| A `parseFloat` planted in the panel's money helper | the assertion sliced from the route registration, below the helpers | slicing from the section header |
| Renaming a response shaper out of use | `/function shapeCreditReview/` also matches `shapeCreditReviewUnused` | asserting it is **called**, not merely defined |

The fifth was an ineffective tamper of my own — preferring a field that is always `null` on a
pending review — and was replaced with an effective one (the review being taken from the request
body), caught by a new assertion (25e).

---

## 9. Still NOT complete

- **Real customer credit limits.** Every account still reads NULL. No numerical limits were
  invented or assigned.
- **Capability bootstrap.** Nobody holds `finance.credit_limit` or `finance.credit_review`, or any
  other capability. Both screens are unusable until somebody grants them — deliberately.
- **Migration rehearsal** and **deployment rehearsal** — both need a real disposable database.
- **Production Stripe activation** and **production email activation.**
- **Legal / privacy approval** for any future analytics.
- **Historical invoice visual match** — the old reference PDF is still unavailable.

---

## 10. Release

The gate refuses this branch by design; the documented override was used, and the approved-branch
allowlist was **not** widened.

> **After promotion by fast-forward to `mathew/public-website-rebuild`, the complete release gate
> must be re-run WITHOUT `VEYORA_RELEASE_BRANCH_OVERRIDE`.**

---

## 11. What did not happen

No production or VPS access. No live database. No DNS change. No deployment. No live Stripe
credentials or transaction. No real outbound email. No destructive migration. **No real customer
credit limit assigned. No capability bootstrap executed.** No branch merged, no canonical-branch
promotion, no fast-forward of `main`. **No push.**
