# 38 — Stripe Payment Architecture

**Status:** implemented, test-mode ready (Final Handover, Phase 3)
**Not done:** no live key has ever been used, no live webhook registered, no real payment made.

---

## 1. The commercial model this preserves

Veyora is a **B2B wholesale distributor**. Customers order on **account terms** (Net 30 by default,
per-account). That is the primary flow and it is unchanged.

Paying an issued invoice by card is an **option added beside** those terms — never a replacement,
never a precondition. Concretely:

- **payment is not forced at checkout.** Nothing in the ordering path calls Stripe;
- an invoice with online payment switched off still says *"payable on your usual account terms"*;
- there is no direct-to-consumer checkout, and none was built.

**Apple Pay and Google Pay are not separate requirements.** They are wallet presentations of a card
payment; Stripe Checkout surfaces them automatically where the device supports them and the account
has them enabled. No separate implementation exists or is needed.

---

## 2. The approved flow

```
order
  → Veyora invoice issued          (customer now owes it, on terms)
  → customer remains on terms      (nothing is due differently)
  → an authorised user creates a Stripe-hosted payment session
  → the customer follows the secure Stripe link
  → a SIGNED WEBHOOK confirms payment
  → Veyora records settlement transactionally
  → invoice state and customer balance update
  → an immutable payment event is recorded
```

---

## 3. The one property everything rests on

> **Only a verified webhook may settle an invoice.**

A browser arriving on the success page proves that a browser followed a redirect. A signed webhook is
a statement by Stripe, verified against a shared secret. Those are different things, and the
subsystem is built on the difference:

| Guarantee | How |
|---|---|
| No route can mark an invoice paid | Asserted: no route file contains `settlement_state = 'paid'`; only `webhook.js` does |
| A redirect is never proof | No route reads `session_id` / `payment_intent` / `success` from a query string |
| The signature covers the real bytes | The webhook is mounted with `express.raw()` **before** `express.json()` — a re-serialised body changes whitespace and key order and would never verify |
| An unverified webhook cannot be accepted | Enabling Stripe without `STRIPE_WEBHOOK_SECRET` **throws at startup** |
| A paid invoice carries evidence | `check (settlement_state <> 'paid' or (settled_at is not null and settlement_reference <> '' and amount_settled_minor > 0))` |

---

## 4. Configuration

`src/payments/stripe-config.js` is pure — it takes an environment map and reads nothing itself.

1. **The API boots without Stripe.** Unset, or `STRIPE_ENABLED=false`, gives a *disabled*
   configuration with a stated reason. `enabled: false` is a first-class state; every payment action
   refuses with a sentence rather than a broken page.
2. **A half-configured Stripe is a refusal, not a guess.** Enabled with no webhook secret, or no
   return URLs, throws.
3. **Test and live are never confused.** The mode is derived from the key prefix; a mismatched
   test/live pair throws; **a live key outside production is refused outright** — the usual way that
   happens is a staging box copied from production configuration, and the usual outcome is a real
   card charged during a test.

The API version is **pinned** (`2024-06-20`). `publicView()` is the only shape a browser sees:
`enabled`, `mode`, `testMode`, `disabledReason` — no key of any kind, asserted.

See `platform/server/.env.example` for every variable with its explanation.

---

## 5. Money

Every new column is `bigint` **minor units**, because that is what Stripe speaks and every conversion
between representations is a chance to be out by a factor of a hundred.

`toMinorUnits()` is the single conversion and it **refuses rather than rounds**. `pg` returns
`numeric` as a string precisely so no precision is lost; parsing it into a float reintroduces exactly
that error — `29.97 * 100` is `2996.9999999999995`.

---

## 6. Sessions

- **The amount comes from the server.** It is read from the invoice inside the transaction. The
  functions take no amount parameter at all, so no request body can influence it.
- **One live session per invoice**, enforced by a partial unique index — not a check-then-insert, so
  two concurrent requests cannot both create.
- **Stripe is never called inside the transaction** that locks the invoice: a provider round trip
  with a row lock held is how a slow third party becomes a database incident.
- A provider failure leaves a **visible failed session** with the error code, not silence.
- Sessions expire, so an abandoned link cannot make an invoice permanently unpayable.

The Stripe request carries an amount, a currency, a description and return URLs. It carries **no**
SKUs, wholesale prices, costs, balances, terms or pricing mode — asserted. The metadata carries the
Veyora invoice number, which is safe: it is already printed on the invoice the customer holds, and it
is what makes a dashboard payment traceable during reconciliation.

---

## 7. The webhook

| Property | Implementation |
|---|---|
| Signature first | Nothing is parsed, stored or acted on before `constructEvent` verifies |
| Exact allowlist | Six event types. Anything else is acknowledged with 200 and recorded as `ignored` — acknowledging is not acting |
| Persistent dedup | `provider_event_id` UNIQUE. A retry collides on insert. One constraint, not an application-level check that races with itself |
| Amount verified | Against Veyora's own session **and** against the invoice, so a session created before the amount changed cannot settle it |
| Out-of-order safe | Every transition is a no-op when already applied — an expiry after a completion does not un-pay an invoice |
| `payment_status`, not session status | `checkout.session.completed` fires for delayed methods where nothing was captured |
| No raw payload | An allowlisted summary is built key by key from a fresh object literal. Never logged, never stored |
| Disputes | Recorded; the invoice is **not** flipped back to unpaid — the money has not moved, and doing so would misstate receivables for something often resolved in Veyora's favour |
| Refunds | `charge.refunded` **records** a refund that already happened. Nothing a customer can send moves money outward |

A failure to apply is a **reconciliation exception** for a human, not an endless retry loop.

---

## 8. Capabilities

Four, kept apart, because these are four different jobs:

| Capability | Authority |
|---|---|
| `payments.view` | Read payment state and provider references |
| `payments.collect` | Create or re-send a secure payment link |
| `payments.refund` | Send money back |
| `payments.reconcile` | Review events that could not be applied |

No role fallback, no wildcard, none granted by any migration. A refund additionally requires an
explicit confirmation, a stated reason and an amount within what remains refundable; the admin UI
confirms by **typing REFUND**.

---

## 9. The dependency

`stripe@22.4.0`, pinned exactly, **zero runtime dependencies**, loaded **dynamically** and only when
Stripe is enabled — an API with no payment configuration never instantiates it.

Chosen over a hand-built client, against this repository's own `xlsx-lite` precedent, for
`constructEvent` alone: webhook verification is an HMAC over a timestamped payload with a tolerance
window and a timing-safe comparison, and it is the only thing between the internet and *"this invoice
is paid"*. A subtly wrong reimplementation does not fail loudly; it accepts forged events.

---

## 10. Testing

80 dedicated tests. **No test contacts Stripe** — there is no key, no network call and no SDK
instance in the suite, asserted structurally. The whole lifecycle is driven by an injected client.

---

## 11. What is NOT done — client activation

See `40A_CLIENT_ACTIVATION_CHECKLIST.md`. In summary: no Stripe account has been chosen, no keys
supplied, no verification completed, no payouts configured, no live webhook registered, and **no real
payment has ever been made**.
