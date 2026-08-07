# 41 — Auditable Finance Operations

**Status:** implemented (Final Handover, Phase 4)
**Supersedes:** the row-diff sync path for `invoices`, `payments`, `creditNotes` and `users.balance`

---

## 1. What was wrong

Money moved through a **whole-database row diff**. The admin panel held the entire dataset in the
browser and posted row-level differences to `POST /admin/sync`. `invoices`, `payments`,
`creditNotes` and `users.balance` were all in that path.

The consequences, in order of severity:

| | |
|---|---|
| **A balance could be set to any number** | `users.balance` was a syncable field. A browser could write `balance: 0` and the API would apply it. There was no record of the prior value, no reason, and no reference. |
| **A payment could be deleted** | The sync payload carries a `deletes` list, which is *every id the tab has not seen*. A stale browser posting a snapshot taken before a real payment arrived would remove it. |
| **An invoice amount could be edited after issue** | `amount` was a syncable field on `invoices`. |
| **Nothing was audited in a way that could be reconciled** | A row diff has no concept of prior value, new value, reason or actor. `audit_log` recorded *"sync"*, not *"who reduced this customer's debt by £4,000 and why"*. |
| **The payment form offered a value the database refuses** | The browser sent `method: 'credit card'` — with a space. `payments.method` has a CHECK constraint listing `credit_card`. The write would have been rejected by PostgreSQL. |

---

## 2. The block

`src/admin-data.js` refuses the **whole request**, before a transaction opens and before any query
runs. A partial write would be worse than none: the caller would be told its payment changes failed
while its product changes had silently landed.

```js
export const FINANCE_COLLECTIONS = ['invoices', 'payments', 'creditNotes'];
export const FINANCE_FIELDS = Object.freeze({ users: ['balance'] });
```

Two properties worth stating explicitly:

- **`balance: 0` is refused exactly as `balance: 5000` is.** The check is `hasOwnProperty`, not
  truthiness — zeroing a balance is the most damaging version of this.
- **The collections remain readable.** Blocking writes must not blind the finance screens. Only a
  write arriving through the generic path is refused.

`collectionFlags` is deliberately **not** blocked. A receivables chase note is workflow, not money.

---

## 3. The capabilities

Four, kept apart:

| Capability | Authority |
|---|---|
| `finance.invoice` | Turn an order into a debt the customer owes |
| `finance.record` | Record money that **arrived** outside Stripe; void a payment keyed in error |
| `finance.credit` | Reduce what a customer owes **without money arriving** |
| `finance.reconcile` | Close a payment-event exception with a stated conclusion |

**`finance.credit` is separate from `finance.record` for one reason.** "We received £4,000" and "we
have decided they owe £4,000 less" look identical on a balance and are completely different events.
The person who keys in bank transfers all day should not be able to forgive a debt.

None is granted by any migration. There is no role fallback and no `finance.*` catch-all.

---

## 4. What every financial mutation now carries

Written to `finance_events` **inside the same transaction as the mutation**:

| Field | Why |
|---|---|
| `event_type` | From a closed CHECK set — a new operation is a reviewed migration |
| `actor_id`, `actor_name`, `actor_role` | The name **as recorded at the time**, so the ledger still reads correctly after an account is renamed or removed |
| `capability` | Which authority admitted it, recorded rather than inferred from the event type |
| `amount_minor`, `currency` | Signed minor units: positive increases the debt, negative decreases it |
| `balance_before`, `balance_after` | So the ledger reconstructs the balance **independently** of `users.balance`. If the two ever disagree, that becomes discoverable rather than invisible |
| `reference` | Required for anything claiming money arrived |
| `reason` | Required for every discretionary act |
| `idempotency_key` | Unique. A retried request records once |
| `created_at` | The database's, never a caller's |

The table is **append-only**, enforced by a trigger — the same mechanism 0010 used for `audit_log`.
A financial record that can be edited after the fact is not a record.

### One function moves every balance

`applyMovement()` in `routes/admin-finance.js` is the only place a balance changes. It locks the
customer row, reads the balance before, applies a **relative** movement, reads the balance after,
and writes the event. There is exactly one `set balance = …` statement in the file and it is
`coalesce(balance,0) + $2`.

If the event insert collides on its idempotency key, the function **throws** — which rolls the
balance movement back too. That is the retry guard: a repeated request must not move the balance a
second time against a ledger entry that already exists.

---

## 5. The operations

| Route | Capability | Notes |
|---|---|---|
| `POST /admin/finance/orders/:orderId/invoice` | `finance.invoice` | Idempotent on the order's `invoice_id` |
| `POST /admin/finance/payments` | `finance.record` | Offline methods only |
| `POST /admin/finance/payments/:id/void` | `finance.record` | Not a delete |
| `POST /admin/finance/credit-notes` | `finance.credit` | Reason mandatory |
| `POST /admin/finance/reconciliation/:id/resolve` | `finance.reconcile` | Settles nothing |
| `GET /admin/finance/ledger[/:customerId]` | `payments.view` | The append-only record |

### A client can never record a Stripe payment

`OFFLINE_PAYMENT_METHODS` is `['transfer', 'check', 'credit_card', 'cash']`. `stripe` is absent, so
the validator refuses it. A Stripe settlement remains the exclusive result of a verified webhook
(Phase 3). `credit_card` means a card taken over the phone or in person under existing policy and
settled outside Stripe — a record of something that already happened elsewhere, not a charge.

### A Stripe payment cannot be voided

The money really was taken. Reversing it is a **refund** — a different capability, a different
provider call and a different record. The void route refuses with `USE_REFUND`.

### Resolving an exception settles nothing

Closing a reconciliation exception is a statement that a human looked at it and decided what it
meant. If the conclusion is that money did arrive, the correct next action is to **record it as a
payment**, which is a separate, separately-gated act with its own ledger entry. Letting "resolve"
also settle would make the reconciliation queue a way to mark invoices paid by hand.

---

## 6. The bootstrap position (a handover item)

`POST /admin/orders/:id/invoice` — the button on the order screen — **keeps its admin-role gate**
rather than moving to `finance.invoice`.

This is deliberate and temporary. No account holds the new capability until somebody grants it, and
silently making invoicing impossible for every existing administrator would be a worse failure than
the one being fixed. The brief permits this: *"no broad admin-role fallback for financial mutations
unless the existing capability architecture requires an explicitly documented bootstrap stage."*

What matters is that it **delegates** to the same `issueInvoice()` implementation. There is one
guard, one transaction, one idempotency check and one ledger write, reached by two entry points —
never two behaviours.

> **HANDOVER ACTION:** after `finance.invoice` is granted to the accounts that need it, retire the
> role gate on `POST /admin/orders/:id/invoice` and route the order screen at
> `POST /admin/finance/orders/:orderId/invoice`. Until then the capability-gated path exists in
> parallel and is fully functional.

A second, smaller consequence: `invoice_number_seq` was removed from the sync catch-up map in
`admin.js`. Sync can no longer write an invoice, so there is no client-assigned number to catch up
with. Leaving the entry would have been dead code that read like a supported path.

---

## 7. What is deliberately absent

- **No DELETE route** for a payment, a credit note or a finance event.
- **No way to set a balance.** Every movement is the arithmetic consequence of an invoice, a
  payment or a credit note.
- **No client method** that could mark a Stripe payment successful.
- **No `finance.*` wildcard** and no role fallback.
- **Existing credit notes are grandfathered.** The `reason <> ''` constraint applies only where
  `issued_by is not null` — it governs what this phase's API creates and does not retroactively
  invalidate history it cannot explain.

---

## 8. Verification

58 dedicated API tests and 18 admin-panel tests. The database double enforces the real unique
indexes and raises on any attempted `UPDATE`/`DELETE` of `finance_events`, so a handler that forgot
one fails there rather than passing on a kind double.
